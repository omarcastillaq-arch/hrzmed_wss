/**
 * @module RPMEnrollment
 * @description Mongoose schema for Remote Patient Monitoring enrollments.
 */

'use strict';

const mongoose = require('mongoose');

const rpmEnrollmentSchema = new mongoose.Schema({
  organizationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true,
  },
  patientId: {
    type: String,
    required: true,
    index: true,
  },
  status: {
    type: String,
    enum: ['active', 'paused', 'completed', 'cancelled'],
    default: 'active',
    index: true,
  },

  // ─── Monitoring Config ─────────────────────────────────────────────────────
  monitoringType: {
    type: String,
    enum: ['continuous', 'event_based', 'scheduled'],
    default: 'continuous',
  },
  alertThresholds: {
    heartRateHigh: { type: Number, default: 120 },
    heartRateLow: { type: Number, default: 50 },
    arrhythmiaDetection: { type: Boolean, default: true },
  },
  assignedDeviceId: {
    type: String,
    default: null,
  },
  assignedPhysicianId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MedicalUser',
    default: null,
  },

  // ─── Dates ─────────────────────────────────────────────────────────────────
  enrolledAt: {
    type: Date,
    default: Date.now,
  },
  completedAt: {
    type: Date,
    default: null,
  },
  lastDataReceivedAt: {
    type: Date,
    default: null,
  },

  // ─── Billing ───────────────────────────────────────────────────────────────
  pricePerMonth: {
    type: Number,
    default: 0,
    min: 0,
  },
  billingStartDate: {
    type: Date,
    default: Date.now,
  },

  // ─── Notes ─────────────────────────────────────────────────────────────────
  notes: {
    type: String,
    maxlength: 1000,
  },
  diagnosis: {
    type: String,
    maxlength: 500,
  },
}, {
  timestamps: true,
  collection: 'rpm_enrollments',
});

// ─── Indexes ─────────────────────────────────────────────────────────────────
rpmEnrollmentSchema.index({ organizationId: 1, patientId: 1 }, { unique: true });
rpmEnrollmentSchema.index({ organizationId: 1, status: 1 });

module.exports = mongoose.model('RPMEnrollment', rpmEnrollmentSchema);
