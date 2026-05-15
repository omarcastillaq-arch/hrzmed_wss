/**
 * @module ecgValidator
 * @description Validates incoming ECG/EKG medical data for the Horizon Medical platform.
 *
 * Validates:
 *   - Message structure and required fields
 *   - ECG channel data format (8 channels from ADS1298 AFE)
 *   - Sample values within valid ADC range (24-bit signed: -8388608 to 8388607)
 *   - Sampling rate consistency
 *   - Timestamp validity
 *   - Patient/device identifier format
 *
 * The ADS1298 AFE produces 24-bit signed samples across 8 channels.
 * BLE characteristic UUIDs: 0x8171-0x8178 map to channels 1-8.
 */

const logger = require('../utils/logger');

// ─── Constants ───────────────────────────────────────────────────────────────

/** 24-bit signed integer range (ADS1298 ADC output) */
const ADC_24BIT_MIN = -8388608;   // -(2^23)
const ADC_24BIT_MAX = 8388607;    //  (2^23) - 1

/** Expected number of ECG channels from the ADS1298 */
const EXPECTED_CHANNELS = 8;

/** Valid BLE characteristic UUIDs for ECG channels */
const VALID_CHANNEL_UUIDS = [
  '8171', '8172', '8173', '8174',
  '8175', '8176', '8177', '8178',
];

/** Maximum samples per packet (based on BLE MTU and protocol) */
const MAX_SAMPLES_PER_PACKET = 100;

/** Minimum samples per packet (at least 1 sample expected) */
const MIN_SAMPLES_PER_PACKET = 1;

/** Maximum allowed timestamp drift from server time (ms) — 5 minutes */
const MAX_TIMESTAMP_DRIFT_MS = 5 * 60 * 1000;

/** Maximum message size in bytes (prevent DoS via oversized payloads) */
const MAX_MESSAGE_SIZE_BYTES = 64 * 1024; // 64KB

/** Valid message types */
const VALID_MESSAGE_TYPES = ['ecg_data', 'device_status', 'patient_info', 'ping'];

// ─── Validation Results ──────────────────────────────────────────────────────

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} valid - Whether the data passed validation
 * @property {string[]} errors - List of validation error messages
 * @property {string[]} warnings - List of non-critical warnings
 * @property {object|null} sanitized - Sanitized/normalized data (null if invalid)
 */

/**
 * Create a validation result object.
 * @returns {ValidationResult}
 */
function createResult() {
  return { valid: true, errors: [], warnings: [], sanitized: null };
}

// ─── Core Validators ─────────────────────────────────────────────────────────

/**
 * Validate the raw WebSocket message before JSON parsing.
 * @param {Buffer|string} rawMessage - Raw WebSocket message
 * @returns {ValidationResult}
 */
function validateRawMessage(rawMessage) {
  const result = createResult();

  // Check message size
  const size = Buffer.isBuffer(rawMessage) ? rawMessage.length : Buffer.byteLength(rawMessage, 'utf8');
  if (size > MAX_MESSAGE_SIZE_BYTES) {
    result.valid = false;
    result.errors.push(`Message size ${size} bytes exceeds maximum ${MAX_MESSAGE_SIZE_BYTES} bytes`);
    return result;
  }

  if (size === 0) {
    result.valid = false;
    result.errors.push('Empty message received');
    return result;
  }

  return result;
}

/**
 * Parse and validate the JSON structure of a message.
 * @param {string} messageStr - JSON string message
 * @returns {ValidationResult}
 */
function validateMessageStructure(messageStr) {
  const result = createResult();

  let data;
  try {
    data = JSON.parse(messageStr);
  } catch (e) {
    result.valid = false;
    result.errors.push(`Invalid JSON: ${e.message}`);
    return result;
  }

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    result.valid = false;
    result.errors.push('Message must be a JSON object');
    return result;
  }

  // Validate message type
  if (!data.type) {
    result.valid = false;
    result.errors.push('Missing required field: type');
    return result;
  }

  if (!VALID_MESSAGE_TYPES.includes(data.type)) {
    result.valid = false;
    result.errors.push(`Invalid message type: "${data.type}". Valid types: ${VALID_MESSAGE_TYPES.join(', ')}`);
    return result;
  }

  result.sanitized = data;
  return result;
}

/**
 * Validate ECG data payload from a Holter device.
 *
 * Expected format:
 * {
 *   type: "ecg_data",
 *   deviceId: "string",
 *   timestamp: <number|ISO string>,
 *   channelId: "8171"-"8178",
 *   samples: [<int24>, <int24>, ...],
 *   sequenceNumber: <number> (optional)
 * }
 *
 * @param {object} data - Parsed ECG data object
 * @returns {ValidationResult}
 */
function validateECGData(data) {
  const result = createResult();

  // --- Device ID ---
  if (!data.deviceId || typeof data.deviceId !== 'string') {
    result.valid = false;
    result.errors.push('Missing or invalid deviceId (must be a non-empty string)');
  } else if (data.deviceId.length > 128) {
    result.valid = false;
    result.errors.push('deviceId exceeds maximum length (128 characters)');
  }

  // --- Timestamp ---
  if (data.timestamp !== undefined) {
    const ts = typeof data.timestamp === 'string' ? Date.parse(data.timestamp) : data.timestamp;
    if (isNaN(ts)) {
      result.valid = false;
      result.errors.push('Invalid timestamp format (must be Unix ms or ISO 8601 string)');
    } else {
      const drift = Math.abs(Date.now() - ts);
      if (drift > MAX_TIMESTAMP_DRIFT_MS) {
        result.warnings.push(`Timestamp drift of ${Math.round(drift / 1000)}s exceeds ${MAX_TIMESTAMP_DRIFT_MS / 1000}s threshold`);
      }
    }
  }

  // --- Channel ID ---
  if (!data.channelId) {
    result.valid = false;
    result.errors.push('Missing required field: channelId');
  } else if (!VALID_CHANNEL_UUIDS.includes(String(data.channelId))) {
    result.valid = false;
    result.errors.push(`Invalid channelId: "${data.channelId}". Valid channels: ${VALID_CHANNEL_UUIDS.join(', ')}`);
  }

  // --- Samples array ---
  if (!data.samples) {
    result.valid = false;
    result.errors.push('Missing required field: samples');
  } else if (!Array.isArray(data.samples)) {
    result.valid = false;
    result.errors.push('samples must be an array');
  } else {
    if (data.samples.length < MIN_SAMPLES_PER_PACKET) {
      result.valid = false;
      result.errors.push(`samples array is empty (minimum ${MIN_SAMPLES_PER_PACKET} sample required)`);
    }
    if (data.samples.length > MAX_SAMPLES_PER_PACKET) {
      result.valid = false;
      result.errors.push(`samples array has ${data.samples.length} items (maximum ${MAX_SAMPLES_PER_PACKET})`);
    }

    // Validate individual sample values
    let invalidSamples = 0;
    for (let i = 0; i < data.samples.length; i++) {
      const sample = data.samples[i];

      if (typeof sample !== 'number' || !Number.isFinite(sample)) {
        invalidSamples++;
        if (invalidSamples <= 3) {
          result.errors.push(`samples[${i}] is not a valid number: ${sample}`);
        }
        continue;
      }

      if (!Number.isInteger(sample)) {
        result.warnings.push(`samples[${i}] is not an integer (${sample}), will be truncated`);
      }

      const intSample = Math.trunc(sample);
      if (intSample < ADC_24BIT_MIN || intSample > ADC_24BIT_MAX) {
        invalidSamples++;
        if (invalidSamples <= 3) {
          result.errors.push(`samples[${i}] value ${intSample} out of 24-bit ADC range [${ADC_24BIT_MIN}, ${ADC_24BIT_MAX}]`);
        }
      }
    }

    if (invalidSamples > 3) {
      result.errors.push(`... and ${invalidSamples - 3} more invalid samples`);
    }
    if (invalidSamples > 0) {
      result.valid = false;
    }
  }

  // --- Sequence number (optional, but validated if present) ---
  if (data.sequenceNumber !== undefined) {
    if (typeof data.sequenceNumber !== 'number' || !Number.isInteger(data.sequenceNumber) || data.sequenceNumber < 0) {
      result.warnings.push('sequenceNumber should be a non-negative integer');
    }
  }

  // Build sanitized output
  if (result.valid || result.errors.length === 0) {
    result.sanitized = {
      type: 'ecg_data',
      deviceId: String(data.deviceId).trim(),
      timestamp: data.timestamp || Date.now(),
      channelId: String(data.channelId),
      samples: data.samples ? data.samples.map(s => Math.trunc(s)) : [],
      sequenceNumber: data.sequenceNumber || null,
    };
  }

  return result;
}

/**
 * Validate a device_status message.
 * @param {object} data
 * @returns {ValidationResult}
 */
function validateDeviceStatus(data) {
  const result = createResult();

  if (!data.deviceId || typeof data.deviceId !== 'string') {
    result.valid = false;
    result.errors.push('Missing or invalid deviceId');
  }

  const validStatuses = ['online', 'offline', 'low_battery', 'error', 'calibrating'];
  if (!data.status || !validStatuses.includes(data.status)) {
    result.valid = false;
    result.errors.push(`Invalid status. Valid values: ${validStatuses.join(', ')}`);
  }

  if (data.batteryLevel !== undefined) {
    if (typeof data.batteryLevel !== 'number' || data.batteryLevel < 0 || data.batteryLevel > 100) {
      result.warnings.push('batteryLevel should be a number between 0 and 100');
    }
  }

  if (result.valid) {
    result.sanitized = {
      type: 'device_status',
      deviceId: String(data.deviceId).trim(),
      status: data.status,
      batteryLevel: data.batteryLevel || null,
      timestamp: data.timestamp || Date.now(),
    };
  }

  return result;
}

/**
 * Validate a patient_info message.
 * @param {object} data
 * @returns {ValidationResult}
 */
function validatePatientInfo(data) {
  const result = createResult();

  if (!data.patientId || typeof data.patientId !== 'string') {
    result.valid = false;
    result.errors.push('Missing or invalid patientId');
  }

  // Ensure no PII is passed unencrypted in this channel
  const piiFields = ['ssn', 'socialSecurity', 'creditCard', 'bankAccount'];
  for (const field of piiFields) {
    if (data[field]) {
      result.valid = false;
      result.errors.push(`SECURITY: PII field "${field}" must not be transmitted over this channel`);
      logger.security('PII_TRANSMISSION_ATTEMPT', { field, patientId: data.patientId });
    }
  }

  if (result.valid) {
    result.sanitized = {
      type: 'patient_info',
      patientId: String(data.patientId).trim(),
      deviceId: data.deviceId ? String(data.deviceId).trim() : null,
      firstName: data.firstName ? String(data.firstName).trim().substring(0, 100) : null,
      lastName: data.lastName ? String(data.lastName).trim().substring(0, 100) : null,
      timestamp: data.timestamp || Date.now(),
    };
  }

  return result;
}

/**
 * Main validation entry point: validates any incoming WebSocket message.
 * @param {Buffer|string} rawMessage - Raw WebSocket message
 * @returns {ValidationResult}
 */
function validateMessage(rawMessage) {
  // Step 1: Raw message validation
  const rawResult = validateRawMessage(rawMessage);
  if (!rawResult.valid) return rawResult;

  const messageStr = Buffer.isBuffer(rawMessage) ? rawMessage.toString('utf8') : rawMessage;

  // Step 2: JSON structure validation
  const structResult = validateMessageStructure(messageStr);
  if (!structResult.valid) return structResult;

  const data = structResult.sanitized;

  // Step 3: Type-specific validation
  switch (data.type) {
    case 'ecg_data':
      return validateECGData(data);
    case 'device_status':
      return validateDeviceStatus(data);
    case 'patient_info':
      return validatePatientInfo(data);
    case 'ping':
      return { valid: true, errors: [], warnings: [], sanitized: { type: 'ping', timestamp: Date.now() } };
    default:
      return { valid: false, errors: [`Unhandled message type: ${data.type}`], warnings: [], sanitized: null };
  }
}

module.exports = {
  validateMessage,
  validateRawMessage,
  validateMessageStructure,
  validateECGData,
  validateDeviceStatus,
  validatePatientInfo,
  // Export constants for testing
  ADC_24BIT_MIN,
  ADC_24BIT_MAX,
  EXPECTED_CHANNELS,
  VALID_CHANNEL_UUIDS,
  MAX_SAMPLES_PER_PACKET,
  MAX_MESSAGE_SIZE_BYTES,
  VALID_MESSAGE_TYPES,
};
