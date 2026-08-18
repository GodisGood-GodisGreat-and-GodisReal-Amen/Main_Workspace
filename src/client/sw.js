// Minimal service worker: network passthrough. Exists so Chrome on Android
// treats AeroLink as installable; the app itself is LAN-live, never cached.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* default network handling */ });
