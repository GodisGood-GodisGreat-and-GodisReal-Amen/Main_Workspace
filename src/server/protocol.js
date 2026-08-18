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
  // reserved for v2 screen preview
  SCREEN_START: 'screen-start',
  SCREEN_STOP: 'screen-stop',
  SCREEN_FRAME: 'screen-frame',
};

const ROLES = { HOST: 'mac-host', PHONE: 'phone-client' };

const INPUT_KINDS = ['move', 'click', 'scroll', 'text', 'key', 'media', 'volume'];

const CLOSE_BAD_TOKEN = 4001;

module.exports = { MSG, ROLES, INPUT_KINDS, CLOSE_BAD_TOKEN };
