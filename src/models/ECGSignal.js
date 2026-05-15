/**
 * @module ECGSignal
 * @description Mongoose schema for individual ECG signal data chunks.
 *
 * Each document stores a batch of samples for a single channel within a session.
 * Supports compressed storage via delta encoding + run-length encoding to reduce
 * the storage footprint of 24-bit ADC data by 40-70%.
 *
 * Storage strategy:
 *   - Raw samples are stored as-is when compression is disabled
 *   - When compressed, samples are delta-encoded then run-length encoded
 *   - The compressed data is stored as a Buffer for maximum efficiency
 *   - Original sample count and compression metadata are preserved for decoding
 */

'use strict';

const mongoose = require('mongoose');

const ecgSignalSchema = new mongoose.Schema({
  // ─── Relationships ───────────────────────────────────────────────────────
  sessionId: {
    type: String,
    required: true,
    index: true,
    description: 'References ECGSession.sessionId',
  },

  // ─── Channel Identification ──────────────────────────────────────────────
  channelId: {
    type: String,
    required: true,
    enum: ['8171', '8172', '8173', '8174', '8175', '8176', '8177', '8178'],
    description: 'BLE characteristic UUID identifying the ECG channel (ADS1298)',
  },
  channelIndex: {
    type: Number,
    min: 0,
    max: 7,
    description: 'Zero-based channel index (0-7)',
  },

  // ─── Timing ──────────────────────────────────────────────────────────────
  timestamp: {
    type: Date,
    required: true,
    index: true,
    description: 'Timestamp of this sample batch (from device or server)',
  },
  sequenceNumber: {
    type: Number,
    description: 'Packet sequence number for ordering and gap detection',
  },

  // ─── Signal Data (Raw) ──────────────────────────────────────────────────
  samples: {
    type: [Number],
    description: 'Raw ADC samples (24-bit signed integers). Populated when uncompressed.',
  },
  sampleCount: {
    type: Number,
    required: true,
    description: 'Number of samples in this chunk (always set, even when compressed)',
  },

  // ─── Compressed Data ─────────────────────────────────────────────────────
  compressed: {
    type: Boolean,
    default: false,
  },
  compressedData: {
    type: Buffer,
    description: 'Delta + RLE encoded samples stored as binary buffer',
  },
  compressionMeta: {
    algorithm: { type: String, enum: ['delta-rle', 'none'], default: 'none' },
    originalBytes: { type: Number },
    compressedBytes: { type: Number },
    firstSample: { type: Number, description: 'First sample value (anchor for delta decoding)' },
  },

  // ─── Device Context ──────────────────────────────────────────────────────
  deviceId: {
    type: String,
    required: true,
    trim: true,
    maxlength: 128,
  },
}, {
  timestamps: true,
  collection: 'ecg_signals',
});

// ─── Indexes ─────────────────────────────────────────────────────────────────
ecgSignalSchema.index({ sessionId: 1, channelId: 1, timestamp: 1 });
ecgSignalSchema.index({ sessionId: 1, sequenceNumber: 1 });
ecgSignalSchema.index({ deviceId: 1, timestamp: -1 });

// ─── Instance Methods ────────────────────────────────────────────────────────
ecgSignalSchema.methods.toSafeJSON = function () {
  const obj = this.toObject();
  delete obj.__v;
  // Don't return raw buffer in JSON — decode if needed
  if (obj.compressedData) {
    obj.compressedData = `<Buffer ${obj.compressedData.length} bytes>`;
  }
  return obj;
};

module.exports = mongoose.model('ECGSignal', ecgSignalSchema);
