/**
 * @module Invitation
 * @description Mongoose schema for user invitations to organizations.
 */

'use strict';

const mongoose = require('mongoose');
const crypto = require('crypto');

const invitationSchema = new mongoose.Schema({
  organizationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true,
  },
  email: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    maxlength: 255,
  },
  role: {
    type: String,
    required: true,
    enum: ['clinic_admin', 'cardiologist', 'technician', 'patient_b2c'],
    default: 'technician',
  },
  token: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  status: {
    type: String,
    enum: ['pending', 'accepted', 'expired', 'revoked'],
    default: 'pending',
    index: true,
  },
  expiresAt: {
    type: Date,
    required: true,
  },
  acceptedAt: {
    type: Date,
    default: null,
  },
  invitedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MedicalUser',
    required: true,
  },
  message: {
    type: String,
    maxlength: 500,
  },
}, {
  timestamps: true,
  collection: 'invitations',
});

// ─── Indexes ─────────────────────────────────────────────────────────────────
invitationSchema.index({ organizationId: 1, email: 1 });
invitationSchema.index({ expiresAt: 1 });

// ─── Pre-validate: Generate token ───────────────────────────────────────────
invitationSchema.pre('validate', function (next) {
  if (!this.token) {
    this.token = crypto.randomBytes(32).toString('hex');
  }
  if (!this.expiresAt) {
    // Default 7 days expiry
    this.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  }
  next();
});

// ─── Methods ─────────────────────────────────────────────────────────────────
invitationSchema.methods.isExpired = function () {
  return new Date() > this.expiresAt;
};

invitationSchema.methods.isValid = function () {
  return this.status === 'pending' && !this.isExpired();
};

module.exports = mongoose.model('Invitation', invitationSchema);
