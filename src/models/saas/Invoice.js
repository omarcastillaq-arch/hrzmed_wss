/**
 * @module Invoice
 * @description Mongoose schema for manual invoices/billing.
 */

'use strict';

const mongoose = require('mongoose');

const invoiceItemSchema = new mongoose.Schema({
  description: { type: String, required: true, maxlength: 255 },
  quantity: { type: Number, required: true, min: 0 },
  unitPrice: { type: Number, required: true, min: 0 },
  total: { type: Number, required: true, min: 0 },
  type: {
    type: String,
    enum: ['subscription', 'credit_purchase', 'rpm', 'overage', 'setup', 'other'],
    default: 'other',
  },
}, { _id: false });

const invoiceSchema = new mongoose.Schema({
  organizationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true,
  },
  invoiceNumber: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    maxlength: 50,
  },

  // ─── Amounts ───────────────────────────────────────────────────────────────
  subtotal: {
    type: Number,
    required: true,
    min: 0,
  },
  tax: {
    type: Number,
    default: 0,
    min: 0,
  },
  taxRate: {
    type: Number,
    default: 0,
    min: 0,
    max: 100,
  },
  total: {
    type: Number,
    required: true,
    min: 0,
  },
  currency: {
    type: String,
    default: 'USD',
    maxlength: 3,
  },

  // ─── Status ────────────────────────────────────────────────────────────────
  status: {
    type: String,
    required: true,
    enum: ['draft', 'pending', 'paid', 'overdue', 'cancelled', 'refunded'],
    default: 'pending',
    index: true,
  },

  // ─── Dates ─────────────────────────────────────────────────────────────────
  issueDate: {
    type: Date,
    required: true,
    default: Date.now,
  },
  dueDate: {
    type: Date,
    required: true,
  },
  paidAt: {
    type: Date,
    default: null,
  },

  // ─── Period ────────────────────────────────────────────────────────────────
  periodMonth: {
    type: Number,
    min: 1,
    max: 12,
  },
  periodYear: {
    type: Number,
  },

  // ─── Items ─────────────────────────────────────────────────────────────────
  items: [invoiceItemSchema],

  // ─── PDF ───────────────────────────────────────────────────────────────────
  pdfUrl: {
    type: String,
    default: null,
  },
  pdfGeneratedAt: {
    type: Date,
    default: null,
  },

  // ─── Notes ─────────────────────────────────────────────────────────────────
  notes: {
    type: String,
    maxlength: 1000,
  },
  internalNotes: {
    type: String,
    maxlength: 1000,
  },

  // ─── Payment ───────────────────────────────────────────────────────────────
  paymentMethod: {
    type: String,
    enum: ['bank_transfer', 'cash', 'check', 'card', 'other'],
    default: null,
  },
  paymentReference: {
    type: String,
    maxlength: 255,
  },

  // ─── Metadata ──────────────────────────────────────────────────────────────
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MedicalUser',
    default: null,
  },
}, {
  timestamps: true,
  collection: 'invoices',
});

// ─── Indexes ─────────────────────────────────────────────────────────────────
invoiceSchema.index({ organizationId: 1, status: 1 });
invoiceSchema.index({ organizationId: 1, issueDate: -1 });
invoiceSchema.index({ dueDate: 1, status: 1 });

// ─── Static: Generate invoice number ─────────────────────────────────────────
invoiceSchema.statics.generateInvoiceNumber = async function () {
  const count = await this.countDocuments();
  const year = new Date().getFullYear();
  const num = String(count + 1).padStart(5, '0');
  return `HZN-${year}-${num}`;
};

module.exports = mongoose.model('Invoice', invoiceSchema);
