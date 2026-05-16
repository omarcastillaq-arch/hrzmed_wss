/**
 * @module NotificationPreference
 * @description Mongoose schema for user notification preferences.
 * Controls which notifications a user receives and through which channels.
 */

'use strict';

const mongoose = require('mongoose');

const notificationPreferenceSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  email: {
    type: String,
    required: true,
  },
  name: {
    type: String,
    default: '',
  },
  enabled: {
    type: Boolean,
    default: true,
  },
  channels: {
    email: { type: Boolean, default: true },
    websocket: { type: Boolean, default: true },
    dashboard: { type: Boolean, default: true },
  },
  severityFilter: {
    CRITICAL: { type: Boolean, default: true },
    HIGH: { type: Boolean, default: true },
    MEDIUM: { type: Boolean, default: true },
    LOW: { type: Boolean, default: false },
  },
  typeFilter: {
    arrhythmia_detected: { type: Boolean, default: true },
    device_disconnected: { type: Boolean, default: true },
    battery_low: { type: Boolean, default: true },
    signal_quality_degraded: { type: Boolean, default: true },
    system_error: { type: Boolean, default: true },
    session_anomaly: { type: Boolean, default: true },
    connection_lost: { type: Boolean, default: true },
    test_notification: { type: Boolean, default: true },
  },
  quietHours: {
    enabled: { type: Boolean, default: false },
    start: { type: String, default: '22:00' },  // HH:MM
    end: { type: String, default: '07:00' },
    timezone: { type: String, default: 'UTC' },
    overrideForCritical: { type: Boolean, default: true },
  },
  dailyDigest: {
    enabled: { type: Boolean, default: false },
    time: { type: String, default: '08:00' },
  },
}, {
  timestamps: true,
});

notificationPreferenceSchema.methods.shouldNotify = function (type, severity) {
  if (!this.enabled) return false;
  if (this.severityFilter && this.severityFilter[severity] === false) return false;
  if (this.typeFilter && this.typeFilter[type] === false) return false;

  // Quiet hours check
  if (this.quietHours && this.quietHours.enabled) {
    if (severity === 'CRITICAL' && this.quietHours.overrideForCritical) return true;
    const now = new Date();
    const hours = now.getUTCHours();
    const minutes = now.getUTCMinutes();
    const currentTime = hours * 60 + minutes;
    const [startH, startM] = this.quietHours.start.split(':').map(Number);
    const [endH, endM] = this.quietHours.end.split(':').map(Number);
    const startTime = startH * 60 + startM;
    const endTime = endH * 60 + endM;

    if (startTime > endTime) {
      // Overnight quiet hours (e.g., 22:00 - 07:00)
      if (currentTime >= startTime || currentTime < endTime) return false;
    } else {
      if (currentTime >= startTime && currentTime < endTime) return false;
    }
  }

  return true;
};

module.exports = mongoose.model('NotificationPreference', notificationPreferenceSchema);
