#!/usr/bin/env node
/**
 * JWT Token Generator for Horizon Medical WSS
 *
 * Usage:
 *   JWT_SECRET=<secret> node scripts/generate-token.js --role device --deviceId holter-001
 *   JWT_SECRET=<secret> node scripts/generate-token.js --role monitor --userId admin-001
 *   JWT_SECRET=<secret> node scripts/generate-token.js --role admin --userId admin-001 --expires 8h
 */

'use strict';

require('dotenv').config();

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('Error: JWT_SECRET environment variable is required.');
  process.exit(1);
}

// Parse CLI args
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, '');
  args[key] = process.argv[i + 1];
}

const role = args.role || 'device';
const validRoles = ['device', 'monitor', 'admin'];
if (!validRoles.includes(role)) {
  console.error(`Invalid role: ${role}. Valid: ${validRoles.join(', ')}`);
  process.exit(1);
}

const payload = {
  sub: args.userId || args.deviceId || `${role}-${Date.now()}`,
  role,
  deviceId: args.deviceId || null,
  patientId: args.patientId || null,
  userId: args.userId || null,
  permissions: role === 'admin' ? ['send_ecg', 'send_status', 'monitor', 'admin'] :
    role === 'monitor' ? ['monitor'] :
      ['send_ecg', 'send_status'],
};

const expiresIn = args.expires || '24h';

const token = jwt.sign(payload, JWT_SECRET, {
  algorithm: process.env.JWT_ALGORITHM || 'HS256',
  expiresIn,
});

console.log('\n=== Horizon Medical WSS - JWT Token ===\n');
console.log('Payload:', JSON.stringify(payload, null, 2));
console.log('Expires in:', expiresIn);
console.log('\nToken:\n');
console.log(token);
console.log('\n--- WebSocket URL ---');
console.log(`wss://hrzmed.org?token=${token}`);
console.log();
