/**
 * @module Patient
 * @description Mongoose schema for Patient records in the Horizon Medical platform.
 *
 * Stores demographic and identification data for patients using IoT Holter devices.
 * Designed for regulatory compliance (HIPAA-aware field handling).
 */

'use strict';

const mongoose = require('mongoose');

const patientSchema = new mongoose.Schema({
  // ─── Identification ────────────────────────────────────────────────────────
  patientId: {
    type: String,
    required: true,
    unique: true,
    index: true,
    trim: true,
    maxlength: 128,
    description: 'Unique patient identifier (external system ID or UUID)',
  },

  // ─── Demographics ──────────────────────────────────────────────────────────
  firstName: {
    type: String,
    trim: true,
    maxlength: 100,
  },
  lastName: {
    type: String,
    trim: true,
    maxlength: 100,
  },
  dateOfBirth: {
    type: Date,
  },
  gender: {
    type: String,
    enum: ['male', 'female', 'other', 'unknown'],
    default: 'unknown',
  },

  // ─── Medical Context ───────────────────────────────────────────────────────
  medicalRecordNumber: {
    type: String,
    trim: true,
    maxlength: 64,
    index: true,
  },
  attendingPhysician: {
    type: String,
    trim: true,
    maxlength: 200,
  },
  diagnosis: {
    type: String,
    trim: true,
    maxlength: 500,
  },
  notes: {
    type: String,
    trim: true,
    maxlength: 2000,
  },

  // ─── Device Association ────────────────────────────────────────────────────
  assignedDevices: [{
    deviceId: { type: String, required: true, trim: true },
    assignedAt: { type: Date, default: Date.now },
    removedAt: { type: Date },
  }],

  // ─── Metadata ──────────────────────────────────────────────────────────────
  active: {
    type: Boolean,
    default: true,
    index: true,
  },
}, {
  timestamps: true,   // createdAt, updatedAt
  collection: 'patients',
});

// ─── Indexes ─────────────────────────────────────────────────────────────────
patientSchema.index({ lastName: 1, firstName: 1 });
patientSchema.index({ createdAt: -1 });

// ─── Instance Methods ────────────────────────────────────────────────────────
patientSchema.methods.toSafeJSON = function () {
  const obj = this.toObject();
  // Remove internal Mongo fields for API responses
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('Patient', patientSchema);
