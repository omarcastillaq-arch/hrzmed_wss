/**
 * @module Subscription
 * @description Mongoose schema for active subscriptions linking organizations to plans.
 */

'use strict';

const mongoose = require('mongoose');

const subscriptionSchema = new mongoose.Schema({
  organizationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true,
  },
  planId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SubscriptionPlan',
    required: true,
  },
  status: {
    type: String,
    required: true,
    enum: ['active', 'cancelled', 'suspended', 'trial', 'expired', 'past_due'],
    default: 'active',
    index: true,
  },

  // ─── Dates ─────────────────────────────────────────────────────────────────
  startDate: {
    type: Date,
    required: true,
    default: Date.now,
  },
  endDate: {
    type: Date,
    default: null,
  },
  trialEndsAt: {
    type: Date,
    default: null,
  },
  cancelledAt: {
    type: Date,
    default: null,
  },

  // ─── Billing ───────────────────────────────────────────────────────────────
  billingCycle: {
    type: String,
    enum: ['monthly', 'yearly'],
    default: 'monthly',
  },
  autoRenew: {
    type: Boolean,
    default: true,
  },
  nextBillingDate: {
    type: Date,
    default: null,
  },

  // ─── Metadata ──────────────────────────────────────────────────────────────
  notes: {
    type: String,
    maxlength: 1000,
  },
  customPricing: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
    description: 'Custom pricing overrides for enterprise plans',
  },
}, {
  timestamps: true,
  collection: 'subscriptions',
});

// ─── Indexes ─────────────────────────────────────────────────────────────────
subscriptionSchema.index({ organizationId: 1, status: 1 });
subscriptionSchema.index({ endDate: 1 });
subscriptionSchema.index({ nextBillingDate: 1 });

// ─── Methods ─────────────────────────────────────────────────────────────────
subscriptionSchema.methods.isExpired = function () {
  if (!this.endDate) return false;
  return new Date() > this.endDate;
};

subscriptionSchema.methods.isTrialActive = function () {
  if (this.status !== 'trial' || !this.trialEndsAt) return false;
  return new Date() < this.trialEndsAt;
};

module.exports = mongoose.model('Subscription', subscriptionSchema);
