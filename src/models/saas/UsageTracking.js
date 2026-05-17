/**
 * @module UsageTracking
 * @description Mongoose schema for monthly usage tracking per organization.
 */

'use strict';

const mongoose = require('mongoose');

const usageTrackingSchema = new mongoose.Schema({
  organizationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true,
  },
  month: {
    type: Number,
    required: true,
    min: 1,
    max: 12,
  },
  year: {
    type: Number,
    required: true,
    min: 2024,
  },

  // ─── Usage Metrics ─────────────────────────────────────────────────────────
  studiesProcessed: {
    type: Number,
    default: 0,
    min: 0,
  },
  creditsConsumed: {
    type: Number,
    default: 0,
    min: 0,
  },
  rpmPatientsActive: {
    type: Number,
    default: 0,
    min: 0,
  },

  // ─── Detail Tracking ──────────────────────────────────────────────────────
  studyIds: [{
    type: String,
  }],
  rpmPatientIds: [{
    type: String,
  }],

  // ─── Limits ────────────────────────────────────────────────────────────────
  studyLimit: {
    type: Number,
    default: 0,
    description: 'Limit snapshot at the time of tracking',
  },
  limitReached: {
    type: Boolean,
    default: false,
  },
  limitReachedAt: {
    type: Date,
    default: null,
  },
}, {
  timestamps: true,
  collection: 'usage_tracking',
});

// ─── Compound Index for unique month/year per org ────────────────────────────
usageTrackingSchema.index({ organizationId: 1, year: 1, month: 1 }, { unique: true });

// ─── Methods ─────────────────────────────────────────────────────────────────
usageTrackingSchema.methods.usagePercentage = function () {
  if (this.studyLimit <= 0) return 0;
  return Math.round((this.studiesProcessed / this.studyLimit) * 100);
};

usageTrackingSchema.methods.isOverLimit = function () {
  if (this.studyLimit <= 0) return false; // unlimited
  return this.studiesProcessed >= this.studyLimit;
};

module.exports = mongoose.model('UsageTracking', usageTrackingSchema);
