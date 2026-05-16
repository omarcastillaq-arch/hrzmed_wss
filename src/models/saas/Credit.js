/**
 * @module Credit
 * @description Mongoose schema for credit transactions (pay-per-study system).
 */

'use strict';

const mongoose = require('mongoose');

const creditSchema = new mongoose.Schema({
  organizationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true,
  },
  amount: {
    type: Number,
    required: true,
    description: 'Amount of credits (positive for purchase/refund, negative for deduction)',
  },
  balance: {
    type: Number,
    required: true,
    description: 'Running balance after this transaction',
  },
  transactionType: {
    type: String,
    required: true,
    enum: ['purchase', 'deduction', 'refund', 'bonus', 'adjustment'],
    index: true,
  },
  description: {
    type: String,
    trim: true,
    maxlength: 500,
  },

  // ─── References ────────────────────────────────────────────────────────────
  studyId: {
    type: String,
    default: null,
    description: 'Associated study ID for deduction transactions',
  },
  invoiceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Invoice',
    default: null,
  },

  // ─── Financial ─────────────────────────────────────────────────────────────
  unitPrice: {
    type: Number,
    default: 0,
    description: 'Price per credit at time of purchase',
  },
  totalPrice: {
    type: Number,
    default: 0,
    description: 'Total monetary amount for this transaction',
  },
  currency: {
    type: String,
    default: 'USD',
    maxlength: 3,
  },

  // ─── Metadata ──────────────────────────────────────────────────────────────
  performedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MedicalUser',
    default: null,
  },
}, {
  timestamps: true,
  collection: 'credits',
});

// ─── Indexes ─────────────────────────────────────────────────────────────────
creditSchema.index({ organizationId: 1, createdAt: -1 });
creditSchema.index({ organizationId: 1, transactionType: 1 });

module.exports = mongoose.model('Credit', creditSchema);
