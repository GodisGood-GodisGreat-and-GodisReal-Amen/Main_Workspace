'use strict';

// Remote-control input on macOS via osascript (AppleScript) and, for pointer
// events, cliclick when installed. No native Node modules. Every handler
// resolves to { ok, message? } — errors never throw past this module.

const { execFile } = require('child_process');
const fs = require('fs');

const EXEC_TIMEOUT = 4000;

const KEY_CODES = {
  return: 36, tab: 48, space: 49, backspace: 51, escape: 53,
  left: 123, right: 124, down: 125, up: 126,
};

const CLICLICK_PATHS = ['/opt/homebrew/bin/cliclick', '/usr/local/bin/cliclick'];

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: EXEC_TIMEOUT }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, message: (stderr || err.message).trim().slice(0, 200) });
      else resolve({ ok: true, stdout });
    });
  });
}

function osascript(script) {
  return run('osascript', ['-e', script]);
}

function escapeAsText(text) {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function createMacInput() {
  let cliclick = null;
  for (const p of CLICLICK_PATHS) {
    if (fs.existsSync(p)) { cliclick = p; break; }
  }
  if (!cliclick) {
    // also honor PATH installs
    execFile('which', ['cliclick'], (err, stdout) => {
      if (!err && stdout.trim()) cliclick = stdout.trim();
    });
  }

  let volume = null; // last known 0-100, lazily read

  async function getVolume() {
    if (volume !== null) return volume;
    const res = await osascript('output volume of (get volume settings)');
    volume = res.ok ? parseInt(res.stdout, 10) || 50 : 50;
    return volume;
  }

  async function accessibilityHint(res) {
    if (!res.ok && /not allowed|1002|assistive/i.test(res.message || '')) {
      return {
        ok: false,
        message: 'Grant AeroLink Accessibility access: System Settings → Privacy & Security → Accessibility',
      };
    }
    return res;
  }

  const handlers = {
    async text(msg) {
      const text = String(msg.text || '');
      for (let i = 0; i < text.length; i += 200) {
        const chunk = escapeAsText(text.slice(i, i + 200));
        const res = await osascript(`tell application "System Events" to keystroke "${chunk}"`);
        if (!res.ok) return accessibilityHint(res);
      }
      return { ok: true };
    },

    async key(msg) {
      const code = KEY_CODES[msg.key];
      if (code === undefined) return { ok: false, message: `unknown key: ${msg.key}` };
      return accessibilityHint(
        await osascript(`tell application "System Events" to key code ${code}`)
      );
    },

    async volume(msg) {
      const current = await getVolume();
      let next = current;
      if (msg.action === 'up') next = Math.min(100, current + 6);
      else if (msg.action === 'down') next = Math.max(0, current - 6);
      else if (msg.action === 'set') next = Math.max(0, Math.min(100, Number(msg.value) || 0));
      else if (msg.action === 'mute') {
        return osascript('set volume with output muted');
      }
      const res = await osascript(`set volume output volume ${next}`);
      if (res.ok) volume = next;
      return res;
    },

    async media(msg) {
      const verb = { playpause: 'playpause', next: 'next track', prev: 'previous track' }[msg.action];
      if (!verb) return { ok: false, message: `unknown media action: ${msg.action}` };
      // Target whichever player is running; hardware media keys need
      // NX_KEYTYPE events AppleScript cannot send.
      const script = `
        if application "Spotify" is running then
          tell application "Spotify" to ${verb}
        else if application "Music" is running then
          tell application "Music" to ${verb}
        else
          error "no player"
        end if`;
      const res = await osascript(script);
      if (!res.ok && /no player/.test(res.message || '')) {
        return { ok: false, message: 'Open Music or Spotify on the Mac first' };
      }
      return res;
    },

    async move(msg) {
      if (!cliclick) return needCliclick();
      const dx = Math.round(msg.dx) || 0;
      const dy = Math.round(msg.dy) || 0;
      return run(cliclick, [`m:${dx >= 0 ? '+' : ''}${dx},${dy >= 0 ? '+' : ''}${dy}`]);
    },

    async click(msg) {
      if (!cliclick) return needCliclick();
      return run(cliclick, [msg.button === 'right' ? 'rc:.' : 'c:.']);
    },

    async scroll(msg) {
      if (!cliclick) return needCliclick();
      // cliclick has no wheel command; nudge with arrow-key scrolling instead
      const code = (msg.dy || 0) > 0 ? 125 : 126;
      return osascript(`tell application "System Events" to key code ${code}`);
    },
  };

  function needCliclick() {
    return {
      ok: false,
      message: 'Pointer control needs cliclick — run: brew install cliclick',
    };
  }

  return {
    async handle(msg) {
      const handler = handlers[msg.kind];
      if (!handler) return { ok: false, message: `unsupported input: ${msg.kind}` };
      try {
        const res = await handler(msg);
        return { ok: res.ok, ...(res.message ? { message: res.message } : {}) };
      } catch (err) {
        return { ok: false, message: err.message };
      }
    },
  };
}

module.exports = { createMacInput, KEY_CODES };
