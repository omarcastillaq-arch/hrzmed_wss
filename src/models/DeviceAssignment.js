/**
 * @module DeviceAssignment
 * @description Mongoose schema for tracking device-to-patient assignments.
 *
 * Records the full lifecycle of a medical device assignment: who assigned it,
 * when it was assigned/returned, and its current status.
 */

'use strict';

const mongoose = require('mongoose');

const deviceAssignmentSchema = new mongoose.Schema({
  // ─── Identification ────────────────────────────────────────────────────────
  assignmentId: {
    type: String,
    required: true,
    unique: true,
    index: true,
    trim: true,
  },

  // ─── Device Info ───────────────────────────────────────────────────────────
  deviceId: {
    type: String,
    required: true,
    index: true,
    trim: true,
    maxlength: 128,
  },
  deviceName: {
    type: String,
    trim: true,
    maxlength: 200,
    default: 'IoT Holter',
  },
  deviceType: {
    type: String,
    enum: ['holter', 'monitor', 'wearable', 'other'],
    default: 'holter',
  },

  // ─── Patient ───────────────────────────────────────────────────────────────
  patientId: {
    type: String,
    required: true,
    index: true,
    trim: true,
  },

  // ─── Assigned By ───────────────────────────────────────────────────────────
  assignedBy: {
    type: String,
    required: true,
    trim: true,
    description: 'userId of the medical user who made the assignment',
  },

  // ─── Timing ────────────────────────────────────────────────────────────────
  assignedAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
  returnedAt: {
    type: Date,
  },
  expectedReturnAt: {
    type: Date,
  },

  // ─── Status ────────────────────────────────────────────────────────────────
  status: {
    type: String,
    enum: ['active', 'returned', 'lost', 'maintenance'],
    default: 'active',
    index: true,
  },

  // ─── Notes ─────────────────────────────────────────────────────────────────
  notes: {
    type: String,
    trim: true,
    maxlength: 2000,
  },
  monitoringConfig: {
    duration: { type: Number, description: 'Expected monitoring duration in hours' },
    channels: { type: [String], default: [] },
    sampleRate: { type: Number, default: 250 },
  },
}, {
  timestamps: true,
  collection: 'device_assignments',
});

// ─── Indexes ─────────────────────────────────────────────────────────────────
deviceAssignmentSchema.index({ deviceId: 1, status: 1 });
deviceAssignmentSchema.index({ patientId: 1, status: 1 });
deviceAssignmentSchema.index({ assignedBy: 1, assignedAt: -1 });

// ─── Instance Methods ────────────────────────────────────────────────────────
deviceAssignmentSchema.methods.toSafeJSON = function () {
  const obj = this.toObject();
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('DeviceAssignment', deviceAssignmentSchema);
