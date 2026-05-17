/**
 * @module Organization
 * @description Mongoose schema for Organizations (clinics, hospitals, insurance, B2C patients).
 * Core entity for multi-tenant SaaS architecture.
 */

'use strict';

const mongoose = require('mongoose');

const organizationSchema = new mongoose.Schema({
  // ─── Identification ────────────────────────────────────────────────────────
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 255,
    index: true,
  },
  slug: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true,
    maxlength: 128,
    match: [/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'],
  },
  type: {
    type: String,
    required: true,
    enum: ['clinic', 'hospital', 'insurance', 'b2c_patient', 'enterprise'],
    default: 'clinic',
    index: true,
  },

  // ─── Contact ───────────────────────────────────────────────────────────────
  email: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    maxlength: 255,
    match: [/^\S+@\S+\.\S+$/, 'Invalid email format'],
  },
  phone: {
    type: String,
    trim: true,
    maxlength: 20,
  },
  address: {
    street: { type: String, trim: true, maxlength: 255 },
    city: { type: String, trim: true, maxlength: 128 },
    state: { type: String, trim: true, maxlength: 128 },
    country: { type: String, trim: true, maxlength: 64 },
    zipCode: { type: String, trim: true, maxlength: 20 },
  },

  // ─── Subscription & Billing ────────────────────────────────────────────────
  planId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SubscriptionPlan',
    default: null,
  },
  subscriptionStatus: {
    type: String,
    enum: ['active', 'trial', 'suspended', 'cancelled', 'expired'],
    default: 'trial',
    index: true,
  },
  creditsBalance: {
    type: Number,
    default: 0,
    min: 0,
  },
  studyLimitMonthly: {
    type: Number,
    default: 0,
  },

  // ─── Settings ──────────────────────────────────────────────────────────────
  settings: {
    timezone: { type: String, default: 'America/Mexico_City' },
    language: { type: String, default: 'es' },
    currency: { type: String, default: 'MXN' },
    logoUrl: { type: String, default: null },
    primaryColor: { type: String, default: '#0891b2' },
  },

  // ─── Status ────────────────────────────────────────────────────────────────
  isActive: {
    type: Boolean,
    default: true,
    index: true,
  },
  suspendedAt: {
    type: Date,
    default: null,
  },
  suspendReason: {
    type: String,
    default: null,
  },

  // ─── Metadata ──────────────────────────────────────────────────────────────
  onboardingCompleted: {
    type: Boolean,
    default: false,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MedicalUser',
    default: null,
  },
}, {
  timestamps: true,
  collection: 'organizations',
});

// ─── Indexes ─────────────────────────────────────────────────────────────────
organizationSchema.index({ subscriptionStatus: 1, isActive: 1 });
organizationSchema.index({ type: 1, isActive: 1 });
organizationSchema.index({ createdAt: -1 });

// ─── Methods ─────────────────────────────────────────────────────────────────
organizationSchema.methods.toSafeObject = function () {
  const obj = this.toObject();
  return obj;
};

organizationSchema.methods.isSuspended = function () {
  return !this.isActive || this.subscriptionStatus === 'suspended';
};

organizationSchema.methods.isTrialExpired = function () {
  if (this.subscriptionStatus !== 'trial') return false;
  const trialDays = 14;
  const trialEnd = new Date(this.createdAt.getTime() + trialDays * 24 * 60 * 60 * 1000);
  return new Date() > trialEnd;
};

// ─── Pre-save slug generation ────────────────────────────────────────────────
organizationSchema.pre('validate', function (next) {
  if (!this.slug && this.name) {
    this.slug = this.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 128);
  }
  next();
});

module.exports = mongoose.model('Organization', organizationSchema);
