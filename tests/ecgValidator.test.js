/**
 * Tests for ECG data validator
 * Run with: node --test tests/ecgValidator.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Set JWT_SECRET before requiring modules that depend on it
process.env.JWT_SECRET = 'test-secret-for-unit-tests';

const {
  validateMessage,
  validateECGData,
  ADC_24BIT_MIN,
  ADC_24BIT_MAX,
  VALID_CHANNEL_UUIDS,
} = require('../src/validators/ecgValidator');

describe('validateMessage', () => {
  it('should reject empty messages', () => {
    const result = validateMessage('');
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  });

  it('should reject invalid JSON', () => {
    const result = validateMessage('not json');
    assert.equal(result.valid, false);
    assert.ok(result.errors[0].includes('Invalid JSON'));
  });

  it('should reject messages without type', () => {
    const result = validateMessage(JSON.stringify({ foo: 'bar' }));
    assert.equal(result.valid, false);
  });

  it('should reject invalid message types', () => {
    const result = validateMessage(JSON.stringify({ type: 'hack_system' }));
    assert.equal(result.valid, false);
    assert.ok(result.errors[0].includes('Invalid message type'));
  });

  it('should accept valid ping messages', () => {
    const result = validateMessage(JSON.stringify({ type: 'ping' }));
    assert.equal(result.valid, true);
    assert.equal(result.sanitized.type, 'ping');
  });

  it('should reject oversized messages', () => {
    const huge = 'x'.repeat(65 * 1024);
    const result = validateMessage(huge);
    assert.equal(result.valid, false);
    assert.ok(result.errors[0].includes('exceeds maximum'));
  });
});

describe('validateECGData', () => {
  const validECGData = {
    type: 'ecg_data',
    deviceId: 'holter-001',
    channelId: '8171',
    timestamp: Date.now(),
    samples: [100000, -200000, 300000, 0, -500000],
    sequenceNumber: 1,
  };

  it('should accept valid ECG data', () => {
    const result = validateECGData(validECGData);
    assert.equal(result.valid, true);
    assert.ok(result.sanitized);
    assert.equal(result.sanitized.deviceId, 'holter-001');
    assert.equal(result.sanitized.channelId, '8171');
    assert.equal(result.sanitized.samples.length, 5);
  });

  it('should reject missing deviceId', () => {
    const data = { ...validECGData, deviceId: undefined };
    const result = validateECGData(data);
    assert.equal(result.valid, false);
  });

  it('should reject invalid channelId', () => {
    const data = { ...validECGData, channelId: '9999' };
    const result = validateECGData(data);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('Invalid channelId')));
  });

  it('should accept all valid channel UUIDs', () => {
    for (const uuid of VALID_CHANNEL_UUIDS) {
      const data = { ...validECGData, channelId: uuid };
      const result = validateECGData(data);
      assert.equal(result.valid, true, `Channel ${uuid} should be valid`);
    }
  });

  it('should reject samples outside 24-bit ADC range', () => {
    const data = { ...validECGData, samples: [ADC_24BIT_MAX + 1] };
    const result = validateECGData(data);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('out of 24-bit ADC range')));
  });

  it('should accept samples at ADC boundaries', () => {
    const data = { ...validECGData, samples: [ADC_24BIT_MIN, ADC_24BIT_MAX, 0] };
    const result = validateECGData(data);
    assert.equal(result.valid, true);
  });

  it('should reject empty samples array', () => {
    const data = { ...validECGData, samples: [] };
    const result = validateECGData(data);
    assert.equal(result.valid, false);
  });

  it('should reject too many samples', () => {
    const data = { ...validECGData, samples: new Array(101).fill(0) };
    const result = validateECGData(data);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('maximum')));
  });

  it('should reject non-numeric samples', () => {
    const data = { ...validECGData, samples: ['abc', null, undefined] };
    const result = validateECGData(data);
    assert.equal(result.valid, false);
  });

  it('should warn on timestamp drift', () => {
    const data = { ...validECGData, timestamp: Date.now() - 10 * 60 * 1000 }; // 10 min ago
    const result = validateECGData(data);
    assert.ok(result.warnings.some(w => w.includes('drift')));
  });

  it('should sanitize and truncate float samples', () => {
    const data = { ...validECGData, samples: [100.7, -200.3] };
    const result = validateECGData(data);
    // Floats get warning but are still valid after truncation
    assert.equal(result.sanitized.samples[0], 100);
    assert.equal(result.sanitized.samples[1], -200);
  });
});

describe('validateMessage - ECG integration', () => {
  it('should validate a full ECG message end-to-end', () => {
    const msg = JSON.stringify({
      type: 'ecg_data',
      deviceId: 'holter-001',
      channelId: '8175',
      samples: [0, 100000, -100000, 8388607, -8388608],
      timestamp: Date.now(),
    });
    const result = validateMessage(msg);
    assert.equal(result.valid, true);
    assert.equal(result.sanitized.channelId, '8175');
  });
});

describe('validateMessage - device_status', () => {
  it('should accept valid device status', () => {
    const msg = JSON.stringify({
      type: 'device_status',
      deviceId: 'holter-001',
      status: 'online',
      batteryLevel: 85,
    });
    const result = validateMessage(msg);
    assert.equal(result.valid, true);
  });

  it('should reject invalid status', () => {
    const msg = JSON.stringify({
      type: 'device_status',
      deviceId: 'holter-001',
      status: 'hacked',
    });
    const result = validateMessage(msg);
    assert.equal(result.valid, false);
  });
});

describe('validateMessage - patient_info', () => {
  it('should accept valid patient info', () => {
    const msg = JSON.stringify({
      type: 'patient_info',
      patientId: 'patient-001',
      firstName: 'John',
      lastName: 'Doe',
    });
    const result = validateMessage(msg);
    assert.equal(result.valid, true);
  });

  it('should reject PII fields', () => {
    const msg = JSON.stringify({
      type: 'patient_info',
      patientId: 'patient-001',
      ssn: '123-45-6789',
    });
    const result = validateMessage(msg);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('PII')));
  });
});
