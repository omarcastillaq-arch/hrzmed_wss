/**
 * @module models
 * @description Central export for all Mongoose models.
 */

'use strict';

const Patient = require('./Patient');
const ECGSession = require('./ECGSession');
const ECGSignal = require('./ECGSignal');
const MedicalUser = require('./MedicalUser');
const DeviceAssignment = require('./DeviceAssignment');
const Notification = require('./Notification');
const NotificationPreference = require('./NotificationPreference');

// ─── SaaS Multi-Tenant Models ───────────────────────────────────────────────
const {
  Organization,
  SubscriptionPlan,
  Subscription,
  Credit,
  UsageTracking,
  Invoice,
  Invitation,
  RPMEnrollment,
} = require('./saas');

module.exports = {
  // Core models
  Patient, ECGSession, ECGSignal, MedicalUser, DeviceAssignment, Notification, NotificationPreference,
  // SaaS models
  Organization, SubscriptionPlan, Subscription, Credit, UsageTracking, Invoice, Invitation, RPMEnrollment,
};
