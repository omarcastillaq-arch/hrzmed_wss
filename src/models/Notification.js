/**
 * @module Notification
 * @description Mongoose schema for system notifications (alerts, events, warnings).
 * Stores notification history with severity, status, recipients, and delivery tracking.
 */

'use strict';

const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  // ─── Multi-Tenant ──────────────────────────────────────────────────────────
  organizationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    default: null,
    index: true,
  },

  notificationId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  type: {
    type: String,
    required: true,
    enum: [
      'arrhythmia_detected',
      'device_disconnected',
      'battery_low',
      'signal_quality_degraded',
      'system_error',
      'session_anomaly',
      'connection_lost',
      'test_notification',
    ],
    index: true,
  },
  severity: {
    type: String,
    required: true,
    enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'],
    index: true,
  },
  title: {
    type: String,
    required: true,
    maxlength: 200,
  },
  message: {
    type: String,
    required: true,
    maxlength: 2000,
  },
  source: {
    deviceId: { type: String, default: null },
    patientId: { type: String, default: null },
    sessionId: { type: String, default: null },
    connectionId: { type: String, default: null },
  },
  recipients: [{
    email: String,
    name: String,
    sentAt: Date,
    deliveryStatus: {
      type: String,
      enum: ['pending', 'sent', 'failed', 'skipped'],
      default: 'pending',
    },
    error: String,
  }],
  status: {
    type: String,
    enum: ['pending', 'sent', 'read', 'acknowledged', 'failed', 'suppressed'],
    default: 'pending',
    index: true,
  },
  readAt: { type: Date, default: null },
  acknowledgedAt: { type: Date, default: null },
  acknowledgedBy: { type: String, default: null },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  retryCount: { type: Number, default: 0 },
  maxRetries: { type: Number, default: 3 },
  lastRetryAt: { type: Date, default: null },
  suppressedReason: { type: String, default: null },
}, {
  timestamps: true,
});

// Compound indexes for common queries
notificationSchema.index({ createdAt: -1 });
notificationSchema.index({ severity: 1, status: 1, createdAt: -1 });
notificationSchema.index({ 'source.deviceId': 1, createdAt: -1 });
notificationSchema.index({ 'source.patientId': 1, createdAt: -1 });
notificationSchema.index({ type: 1, severity: 1, createdAt: -1 });
notificationSchema.index({ status: 1, createdAt: -1 });

// TTL index: auto-delete notifications older than 90 days
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

notificationSchema.methods.toSafeJSON = function () {
  const obj = this.toObject();
  delete obj.__v;
  return obj;
};

notificationSchema.statics.getStats = async function (days = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const [bySeverity, byType, byStatus, total, unread] = await Promise.all([
    this.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: '$severity', count: { $sum: 1 } } },
    ]),
    this.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: '$type', count: { $sum: 1 } } },
    ]),
    this.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    this.countDocuments({ createdAt: { $gte: since } }),
    this.countDocuments({ status: { $in: ['pending', 'sent'] }, createdAt: { $gte: since } }),
  ]);

  return {
    period: `${days} days`,
    total,
    unread,
    bySeverity: Object.fromEntries(bySeverity.map(s => [s._id, s.count])),
    byType: Object.fromEntries(byType.map(t => [t._id, t.count])),
    byStatus: Object.fromEntries(byStatus.map(s => [s._id, s.count])),
  };
};

module.exports = mongoose.model('Notification', notificationSchema);
