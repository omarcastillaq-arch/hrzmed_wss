/**
 * @module saas/models
 * @description Central export for all SaaS multi-tenant Mongoose models.
 */

'use strict';

const Organization = require('./Organization');
const SubscriptionPlan = require('./SubscriptionPlan');
const Subscription = require('./Subscription');
const Credit = require('./Credit');
const UsageTracking = require('./UsageTracking');
const Invoice = require('./Invoice');
const Invitation = require('./Invitation');
const RPMEnrollment = require('./RPMEnrollment');

module.exports = {
  Organization,
  SubscriptionPlan,
  Subscription,
  Credit,
  UsageTracking,
  Invoice,
  Invitation,
  RPMEnrollment,
};
