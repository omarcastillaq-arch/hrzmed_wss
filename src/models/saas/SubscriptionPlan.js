/**
 * @module SubscriptionPlan
 * @description Mongoose schema for subscription plans (Básico, Pro, Enterprise, RPM, B2C).
 */

'use strict';

const mongoose = require('mongoose');

const subscriptionPlanSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100,
  },
  tier: {
    type: String,
    required: true,
    unique: true,
    enum: ['basic', 'pro', 'enterprise', 'rpm', 'b2c'],
    index: true,
  },
  description: {
    type: String,
    trim: true,
    maxlength: 500,
  },

  // ─── Pricing ───────────────────────────────────────────────────────────────
  priceMonthly: {
    type: Number,
    default: 0,
    min: 0,
  },
  priceYearly: {
    type: Number,
    default: 0,
    min: 0,
  },
  currency: {
    type: String,
    default: 'USD',
    maxlength: 3,
  },

  // ─── Limits ────────────────────────────────────────────────────────────────
  studyLimit: {
    type: Number,
    default: 0,
    description: 'Monthly study limit. 0 = use pay-per-study.',
  },
  isUnlimited: {
    type: Boolean,
    default: false,
  },
  maxUsers: {
    type: Number,
    default: 5,
  },
  maxDevices: {
    type: Number,
    default: 3,
  },

  // ─── Pay-per-study ─────────────────────────────────────────────────────────
  payPerStudyPrice: {
    type: Number,
    default: 0,
    min: 0,
  },

  // ─── RPM ───────────────────────────────────────────────────────────────────
  rpmPricePerPatient: {
    type: Number,
    default: 0,
    min: 0,
  },
  rpmMaxPatients: {
    type: Number,
    default: 0,
  },

  // ─── Features ──────────────────────────────────────────────────────────────
  features: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
    description: 'JSON object with feature flags for this plan',
  },

  // ─── Status ────────────────────────────────────────────────────────────────
  isActive: {
    type: Boolean,
    default: true,
    index: true,
  },
  sortOrder: {
    type: Number,
    default: 0,
  },
}, {
  timestamps: true,
  collection: 'subscription_plans',
});

module.exports = mongoose.model('SubscriptionPlan', subscriptionPlanSchema);
