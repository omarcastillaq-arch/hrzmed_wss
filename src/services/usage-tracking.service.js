/**
 * @module UsageTrackingService
 * @description Tracks study processing, RPM patients, and enforces usage limits.
 */

'use strict';

const { Organization, UsageTracking, SubscriptionPlan } = require('../models');
const logger = require('../utils/logger');

class UsageTrackingService {
  /**
   * Track a study being processed for an organization.
   */
  async trackStudyProcessed(orgId, studyId) {
    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();

    const org = await Organization.findById(orgId).populate('planId').lean();
    if (!org) throw new Error('Organization not found');

    const plan = org.planId;
    const studyLimit = plan?.isUnlimited ? 0 : (plan?.studyLimit || 0);

    const usage = await UsageTracking.findOneAndUpdate(
      { organizationId: orgId, month, year },
      {
        $inc: { studiesProcessed: 1 },
        $push: { studyIds: studyId },
        $setOnInsert: { studyLimit },
      },
      { upsert: true, new: true }
    );

    // Check if limit reached
    if (!plan?.isUnlimited && studyLimit > 0 && usage.studiesProcessed >= studyLimit) {
      if (!usage.limitReached) {
        usage.limitReached = true;
        usage.limitReachedAt = new Date();
        await usage.save();
        logger.info('Study limit reached', { orgId, used: usage.studiesProcessed, limit: studyLimit });
      }
    }

    return {
      studiesProcessed: usage.studiesProcessed,
      limit: plan?.isUnlimited ? 'unlimited' : studyLimit,
      limitReached: usage.limitReached,
    };
  }

  /**
   * Track RPM patient activity.
   */
  async trackRPMPatient(orgId, patientId) {
    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();

    const usage = await UsageTracking.findOneAndUpdate(
      { organizationId: orgId, month, year },
      {
        $addToSet: { rpmPatientIds: patientId },
      },
      { upsert: true, new: true }
    );

    // Update active RPM patients count
    usage.rpmPatientsActive = usage.rpmPatientIds.length;
    await usage.save();

    return { rpmPatientsActive: usage.rpmPatientsActive };
  }

  /**
   * Get monthly usage.
   */
  async getMonthlyUsage(orgId, month, year) {
    const now = new Date();
    const m = month || now.getMonth() + 1;
    const y = year || now.getFullYear();

    const usage = await UsageTracking.findOne({
      organizationId: orgId,
      month: m,
      year: y,
    }).lean();

    const org = await Organization.findById(orgId).populate('planId').lean();
    const plan = org?.planId;

    return {
      period: { month: m, year: y },
      studies: {
        processed: usage?.studiesProcessed || 0,
        limit: plan?.isUnlimited ? 'unlimited' : (plan?.studyLimit || 0),
        percentage: plan?.isUnlimited ? 0 : (
          plan?.studyLimit ? Math.round(((usage?.studiesProcessed || 0) / plan.studyLimit) * 100) : 0
        ),
      },
      credits: {
        consumed: usage?.creditsConsumed || 0,
        balance: org?.creditsBalance || 0,
      },
      rpm: {
        patientsActive: usage?.rpmPatientsActive || 0,
      },
      limitReached: usage?.limitReached || false,
    };
  }

  /**
   * Check and enforce limits for an organization.
   * Returns { allowed: boolean, reason?: string }
   */
  async checkAndEnforceLimits(orgId) {
    const org = await Organization.findById(orgId).populate('planId').lean();
    if (!org) return { allowed: false, reason: 'Organization not found' };

    // Check if org is active
    if (!org.isActive || org.subscriptionStatus === 'suspended') {
      return { allowed: false, reason: 'Organization is suspended' };
    }

    // Check subscription status
    if (org.subscriptionStatus === 'cancelled' || org.subscriptionStatus === 'expired') {
      return { allowed: false, reason: 'Subscription is not active' };
    }

    const plan = org.planId;
    if (!plan) {
      return { allowed: false, reason: 'No active plan' };
    }

    // Unlimited plans always allowed
    if (plan.isUnlimited) {
      return { allowed: true };
    }

    // Check study limit
    const now = new Date();
    const usage = await UsageTracking.findOne({
      organizationId: orgId,
      month: now.getMonth() + 1,
      year: now.getFullYear(),
    }).lean();

    const used = usage?.studiesProcessed || 0;
    const limit = plan.studyLimit || 0;

    if (limit > 0 && used >= limit) {
      // Check pay-per-study credits
      if (org.creditsBalance > 0) {
        return {
          allowed: true,
          payPerStudy: true,
          message: 'Monthly limit reached. Study will be charged from credits.',
        };
      }
      return {
        allowed: false,
        reason: 'Monthly study limit reached and no credits available',
        used,
        limit,
      };
    }

    return {
      allowed: true,
      remaining: limit > 0 ? limit - used : 'unlimited',
    };
  }

  /**
   * Get usage history for multiple months.
   */
  async getUsageHistory(orgId, months = 6) {
    const now = new Date();
    const history = [];

    for (let i = 0; i < months; i++) {
      const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const month = date.getMonth() + 1;
      const year = date.getFullYear();

      const usage = await UsageTracking.findOne({
        organizationId: orgId,
        month,
        year,
      }).lean();

      history.push({
        month,
        year,
        studiesProcessed: usage?.studiesProcessed || 0,
        creditsConsumed: usage?.creditsConsumed || 0,
        rpmPatientsActive: usage?.rpmPatientsActive || 0,
      });
    }

    return history;
  }
}

module.exports = new UsageTrackingService();
