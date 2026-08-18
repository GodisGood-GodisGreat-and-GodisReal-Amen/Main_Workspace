'use strict';

const crypto = require('crypto');

function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

// Constant-time comparison that tolerates length mismatches.
function tokensEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.alloc(64);
  const bufB = Buffer.alloc(64);
  bufA.write(a.slice(0, 64));
  bufB.write(b.slice(0, 64));
  return a.length === b.length && crypto.timingSafeEqual(bufA, bufB);
}

module.exports = { generateToken, tokensEqual };
