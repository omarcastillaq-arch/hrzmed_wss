/**
 * @module MedicalUser
 * @description Mongoose schema for medical staff users (doctors, nurses, administrators).
 *
 * Stores professional information, credentials, and role-based access data
 * for healthcare personnel using the Horizon Medical platform.
 */

'use strict';

const mongoose = require('mongoose');
const crypto = require('crypto');

const medicalUserSchema = new mongoose.Schema({
  // ─── Identification ────────────────────────────────────────────────────────
  userId: {
    type: String,
    required: true,
    unique: true,
    index: true,
    trim: true,
    maxlength: 128,
    description: 'Unique user identifier (UUID)',
  },

  // ─── Authentication ────────────────────────────────────────────────────────
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true,
    maxlength: 255,
    match: [/^\S+@\S+\.\S+$/, 'Invalid email format'],
  },
  passwordHash: {
    type: String,
    required: true,
    select: false,
    description: 'bcrypt/scrypt hashed password — never returned in queries',
  },

  // ─── Personal Info ─────────────────────────────────────────────────────────
  firstName: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100,
  },
  lastName: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100,
  },
  phone: {
    type: String,
    trim: true,
    maxlength: 30,
  },

  // ─── Professional Info ─────────────────────────────────────────────────────
  role: {
    type: String,
    required: true,
    enum: ['doctor', 'nurse', 'admin', 'technician'],
    index: true,
  },
  specialty: {
    type: String,
    trim: true,
    maxlength: 200,
    description: 'Medical specialty (e.g., Cardiology, Internal Medicine)',
  },
  licenseNumber: {
    type: String,
    trim: true,
    maxlength: 64,
    description: 'Professional medical license number',
  },
  department: {
    type: String,
    trim: true,
    maxlength: 200,
  },
  institution: {
    type: String,
    trim: true,
    maxlength: 300,
  },

  // ─── Access Control ────────────────────────────────────────────────────────
  permissions: {
    type: [String],
    default: [],
    description: 'Granular permissions list (e.g., view_ecg, generate_reports)',
  },
  active: {
    type: Boolean,
    default: true,
    index: true,
  },
  lastLogin: {
    type: Date,
  },

  // ─── Assigned Patients ─────────────────────────────────────────────────────
  assignedPatients: [{
    type: String,
    description: 'Patient IDs assigned to this medical user',
  }],
}, {
  timestamps: true,
  collection: 'medical_users',
});

// ─── Indexes ─────────────────────────────────────────────────────────────────
medicalUserSchema.index({ lastName: 1, firstName: 1 });
medicalUserSchema.index({ role: 1, active: 1 });
medicalUserSchema.index({ institution: 1, department: 1 });

// ─── Static: hash password ───────────────────────────────────────────────────
medicalUserSchema.statics.hashPassword = function (plaintext) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(plaintext, salt, 64).toString('hex');
  return `${salt}:${hash}`;
};

// ─── Static: verify password ─────────────────────────────────────────────────
medicalUserSchema.statics.verifyPassword = function (plaintext, stored) {
  const [salt, hash] = stored.split(':');
  const derived = crypto.scryptSync(plaintext, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(derived, 'hex'));
};

// ─── Instance Methods ────────────────────────────────────────────────────────
medicalUserSchema.methods.toSafeJSON = function () {
  const obj = this.toObject();
  delete obj.__v;
  delete obj.passwordHash;
  return obj;
};

module.exports = mongoose.model('MedicalUser', medicalUserSchema);
