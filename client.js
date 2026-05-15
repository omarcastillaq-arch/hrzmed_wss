/**
 * Example WebSocket client with JWT authentication for Horizon Medical WSS.
 *
 * Usage:
 *   JWT_SECRET=<your-secret> node client.js
 *
 * Or with a pre-generated token:
 *   node client.js <token>
 */

'use strict';

require('dotenv').config();

const WebSocket = require('ws');
const jwt = require('jsonwebtoken');

// ─── Configuration ───────────────────────────────────────────────────────────

const WSS_URL = process.env.WSS_URL || 'wss://hrzmed.org';
const JWT_SECRET = process.env.JWT_SECRET;

// ─── Generate or use provided token ─────────────────────────────────────────

let token = process.argv[2];

if (!token && JWT_SECRET) {
  // Generate a test token for a simulated Holter device
  token = jwt.sign(
    {
      sub: 'test-device-001',
      role: 'device',
      deviceId: 'holter-001',
      patientId: 'patient-test-001',
      permissions: ['send_ecg', 'send_status'],
    },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );
  console.log('Generated test JWT token');
} else if (!token) {
  console.error('Error: Provide JWT_SECRET in .env or pass a token as argument.');
  console.error('Usage: JWT_SECRET=<secret> node client.js');
  console.error('   or: node client.js <jwt-token>');
  process.exit(1);
}

// ─── Connect with JWT ────────────────────────────────────────────────────────

const wsUrl = `${WSS_URL}?token=${token}`;
console.log(`Connecting to: ${WSS_URL} (with JWT auth)`);

const ws = new WebSocket(wsUrl);

ws.on('open', () => {
  console.log('✓ Connected and authenticated!\n');

  // Send a sample ECG data message
  const ecgMessage = {
    type: 'ecg_data',
    deviceId: 'holter-001',
    channelId: '8171',
    timestamp: Date.now(),
    samples: generateSampleECG(21),
    sequenceNumber: 1,
  };

  console.log('Sending ECG data sample...');
  ws.send(JSON.stringify(ecgMessage));

  // Send a device status
  setTimeout(() => {
    ws.send(JSON.stringify({
      type: 'device_status',
      deviceId: 'holter-001',
      status: 'online',
      batteryLevel: 85,
      timestamp: Date.now(),
    }));
    console.log('Sent device status');
  }, 1000);

  // Send a ping
  setTimeout(() => {
    ws.send(JSON.stringify({ type: 'ping' }));
    console.log('Sent ping');
  }, 2000);

  // Test validation: send invalid data
  setTimeout(() => {
    console.log('\nTesting validation - sending invalid data...');
    ws.send(JSON.stringify({
      type: 'ecg_data',
      deviceId: 'holter-001',
      channelId: '9999', // Invalid channel
      samples: [99999999], // Out of 24-bit range
    }));
  }, 3000);

  // Disconnect after tests
  setTimeout(() => {
    console.log('\nTest complete. Disconnecting...');
    ws.close();
  }, 4000);
});

ws.on('message', (data) => {
  try {
    const msg = JSON.parse(data.toString());
    console.log('← Server:', JSON.stringify(msg, null, 2));
  } catch {
    console.log('← Server (raw):', data.toString());
  }
});

ws.on('error', (error) => {
  console.error('✗ WebSocket error:', error.message);
});

ws.on('close', (code, reason) => {
  console.log(`Connection closed (code: ${code}, reason: ${reason?.toString() || 'N/A'})`);
});

// ─── Helper: Generate simulated 24-bit ECG samples ──────────────────────────

function generateSampleECG(count) {
  const samples = [];
  for (let i = 0; i < count; i++) {
    // Simulate ECG-like values within 24-bit ADC range
    const baseValue = Math.sin(i * 0.3) * 500000;
    samples.push(Math.round(baseValue));
  }
  return samples;
}
