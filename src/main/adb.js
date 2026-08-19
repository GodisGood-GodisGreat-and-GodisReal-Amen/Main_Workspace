'use strict';

// USB pairing via adb: detect platform-tools, watch for a plugged-in phone,
// set up `adb reverse` so the phone reaches the server at localhost, and
// auto-open the pairing URL on the phone. Everything degrades to status
// reports — a missing adb must never break Wi-Fi pairing.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ADB_CANDIDATES = [
  'adb',
  path.join(os.homedir(), 'Library', 'Android', 'sdk', 'platform-tools', 'adb'),
  '/opt/homebrew/bin/adb',
  '/usr/local/bin/adb',
];

function createAdbWatcher({ port, pairingToken, onStatus, exec = execFile, pollMs = 5000 }) {
  let adbPath = null;
  let timer = null;
  let lastStatus = null;
  const reversedSerials = new Set();

  function report(adb, extra = {}) {
    const status = { type: 'usb-status', adb, ...extra };
    const key = JSON.stringify(status);
    if (key === lastStatus) return;
    lastStatus = key;
    onStatus(status);
  }

  function run(args, cb) {
    exec(adbPath, args, { timeout: 6000 }, (err, stdout, stderr) =>
      cb(err, String(stdout || ''), String(stderr || '')));
  }

  function detect(cb) {
    const tryNext = (i) => {
      if (i >= ADB_CANDIDATES.length) return cb(null);
      const candidate = ADB_CANDIDATES[i];
      if (candidate !== 'adb' && !fs.existsSync(candidate)) return tryNext(i + 1);
      exec(candidate, ['version'], { timeout: 4000 }, (err) => {
        if (err) return tryNext(i + 1);
        cb(candidate);
      });
    };
    tryNext(0);
  }

  function parseDevices(stdout) {
    return stdout
      .split('\n')
      .slice(1)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [serial, state] = l.split(/\s+/);
        return { serial, state };
      })
      .filter((d) => d.serial && d.state);
  }

  function poll() {
    run(['devices', '-l'], (err, stdout) => {
      if (err) {
        report('absent');
        return;
      }
      const devices = parseDevices(stdout);
      const ready = devices.find((d) => d.state === 'device');
      const unauthorized = devices.find((d) => d.state === 'unauthorized');
      if (ready) {
        if (!reversedSerials.has(ready.serial)) {
          run(['-s', ready.serial, 'reverse', `tcp:${port}`, `tcp:${port}`], (revErr) => {
            if (revErr) {
              report('no-device', { hint: 'USB: could not set up the cable link — replug and retry' });
              return;
            }
            reversedSerials.add(ready.serial);
            report('ready', { serial: ready.serial });
            run([
              '-s', ready.serial, 'shell', 'am', 'start',
              '-a', 'android.intent.action.VIEW',
              '-d', `http://localhost:${port}/?token=${pairingToken}`,
            ], () => {});
          });
        } else {
          report('ready', { serial: ready.serial });
        }
      } else if (unauthorized) {
        report('unauthorized');
      } else {
        reversedSerials.clear();
        report('no-device');
      }
    });
  }

  function start() {
    detect((found) => {
      adbPath = found;
      if (!adbPath) {
        report('absent');
        return;
      }
      poll();
      timer = setInterval(poll, pollMs);
    });
  }

  function stop() {
    if (timer) clearInterval(timer);
  }

  return { start, stop };
}

module.exports = { createAdbWatcher };
