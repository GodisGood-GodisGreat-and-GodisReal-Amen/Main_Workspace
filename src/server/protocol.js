'use strict';

// WebSocket message types. This file is the single source of truth for the
// protocol; src/client/js/ws-client.js mirrors these string literals.
const MSG = {
  // connection & identity
  HELLO: 'hello',
  HELLO_ACK: 'hello-ack',
  ERROR: 'error',
  // presence — drives the Frutiger Aero transformation on the host
  PRESENCE: 'presence',
  // clipboard
  CLIPBOARD_SET: 'clipboard-set',
  CLIPBOARD_GET: 'clipboard-get',
  CLIPBOARD_UPDATE: 'clipboard-update',
  // device info dashboard
  DEVICE_INFO: 'device-info',
  DEVICE_INFO_UPDATE: 'device-info-update',
  // remote control
  INPUT: 'input',
  INPUT_RESULT: 'input-result',
  // file sharing notifications
  FILE_ADDED: 'file-added',
  FILE_REMOVED: 'file-removed',
  // USB pairing status (host only)
  USB_STATUS: 'usb-status',
  // app launcher — Frutiger Aero icon grid on the phone
  APPS_GET: 'apps-get',
  APPS_LIST: 'apps-list',
  // live screen preview (full-screen remote mode)
  SCREEN_START: 'screen-start',
  SCREEN_STOP: 'screen-stop',
  SCREEN_FRAME: 'screen-frame',
  // low-bandwidth streaming: the client acks each frame so the hub can pace
  // deliveries to the link, and may pin the eco profile explicitly
  SCREEN_ACK: 'screen-ack',
  SCREEN_PROFILE: 'screen-profile',
};

// Capture profiles for the live screen, slowest link first. The hub walks
// this ladder from measured frame-delivery times; `intervalMs` doubles as the
// delivery-time budget a link must hold to stay on that rung.
const SCREEN_PROFILES = {
  eco: { width: 560, quality: 32, intervalMs: 1400 },
  balanced: { width: 800, quality: 45, intervalMs: 900 },
  hd: { width: 1024, quality: 55, intervalMs: 650 },
};
const PROFILE_LADDER = ['eco', 'balanced', 'hd'];

const ROLES = { HOST: 'mac-host', PHONE: 'phone-client' };

// 'launch' opens an app by name; 'click-at' clicks at normalized (0..1)
// screen coordinates — the full-screen mode's tap-to-click.
const INPUT_KINDS = ['move', 'click', 'click-at', 'scroll', 'text', 'key', 'media', 'volume', 'launch'];

const CLOSE_BAD_TOKEN = 4001;

module.exports = { MSG, ROLES, INPUT_KINDS, CLOSE_BAD_TOKEN, SCREEN_PROFILES, PROFILE_LADDER };
