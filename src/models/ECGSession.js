/**
 * @module ECGSession
 * @description Mongoose schema for ECG recording sessions.
 *
 * An ECGSession represents a continuous recording period from a single device,
 * optionally linked to a patient. It aggregates metadata about the recording
 * while individual signal chunks are stored in ECGSignal documents.
 */

'use strict';

const mongoose = require('mongoose');

// ─── Sub-schemas ─────────────────────────────────────────────────────────────

const deviceInfoSchema = new mongoose.Schema({
  deviceId: { type: String, required: true, trim: true, maxlength: 128 },
  firmwareVersion: { type: String, trim: true, maxlength: 32 },
  hardwareVersion: { type: String, trim: true, maxlength: 32 },
}, { _id: false });

const qualityMetricsSchema = new mongoose.Schema({
  totalSamples: { type: Number, default: 0 },
  droppedPackets: { type: Number, default: 0 },
  avgSignalQuality: { type: Number, min: 0, max: 100 },
  channelsRecorded: { type: [String], default: [] },
  compressionRatio: { type: Number },  // original / compressed size
}, { _id: false });

// ─── Main Schema ─────────────────────────────────────────────────────────────

const ecgSessionSchema = new mongoose.Schema({
  // ─── Identification ──────────────────────────────────────────────────────
  sessionId: {
    type: String,
    required: true,
    unique: true,
    index: true,
    trim: true,
    description: 'UUID for this recording session',
  },

  // ─── Relationships ───────────────────────────────────────────────────────
  patientId: {
    type: String,
    index: true,
    trim: true,
    description: 'References Patient.patientId (optional for anonymous sessions)',
  },
  connectionId: {
    type: String,
    trim: true,
    description: 'WebSocket connection ID that produced this session',
  },

  // ─── Device Info ─────────────────────────────────────────────────────────
  device: {
    type: deviceInfoSchema,
    required: true,
  },

  // ─── Timing ──────────────────────────────────────────────────────────────
  startedAt: {
    type: Date,
    required: true,
    index: true,
  },
  endedAt: {
    type: Date,
    index: true,
  },
  durationMs: {
    type: Number,
    description: 'Session duration in milliseconds',
  },

  // ─── Status ──────────────────────────────────────────────────────────────
  status: {
    type: String,
    enum: ['recording', 'completed', 'interrupted', 'error'],
    default: 'recording',
    index: true,
  },

  // ─── Quality & Stats ────────────────────────────────────────────────────
  quality: {
    type: qualityMetricsSchema,
    default: () => ({}),
  },

  // ─── Metadata ────────────────────────────────────────────────────────────
  signalCount: {
    type: Number,
    default: 0,
    description: 'Number of ECGSignal chunks stored for this session',
  },
  tags: {
    type: [String],
    default: [],
  },
  notes: {
    type: String,
    maxlength: 2000,
    trim: true,
  },
}, {
  timestamps: true,
  collection: 'ecg_sessions',
});

// ─── Compound Indexes ────────────────────────────────────────────────────────
ecgSessionSchema.index({ patientId: 1, startedAt: -1 });
ecgSessionSchema.index({ 'device.deviceId': 1, startedAt: -1 });
ecgSessionSchema.index({ status: 1, startedAt: -1 });
ecgSessionSchema.index({ startedAt: -1, endedAt: -1 });

// ─── Virtual: duration in seconds ────────────────────────────────────────────
ecgSessionSchema.virtual('durationSec').get(function () {
  if (this.durationMs != null) return Math.round(this.durationMs / 1000);
  if (this.startedAt && this.endedAt) {
    return Math.round((this.endedAt - this.startedAt) / 1000);
  }
  return null;
});

// ─── Pre-save: compute duration ──────────────────────────────────────────────
ecgSessionSchema.pre('save', function (next) {
  if (this.startedAt && this.endedAt && !this.durationMs) {
    this.durationMs = this.endedAt.getTime() - this.startedAt.getTime();
  }
  next();
});

// ─── Instance Methods ────────────────────────────────────────────────────────
ecgSessionSchema.methods.toSafeJSON = function () {
  const obj = this.toObject({ virtuals: true });
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('ECGSession', ecgSessionSchema);
