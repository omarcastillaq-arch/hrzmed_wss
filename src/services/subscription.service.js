/**
 * @module SubscriptionService
 * @description Business logic for subscription management.
 */

'use strict';

const { Organization, SubscriptionPlan, Subscription } = require('../models');
const logger = require('../utils/logger');

class SubscriptionService {
  /**
   * List all available plans.
   */
  async listPlans(includeInactive = false) {
    const filter = includeInactive ? {} : { isActive: true };
    return SubscriptionPlan.find(filter).sort({ sortOrder: 1 }).lean();
  }

  /**
   * Get plan by ID or tier.
   */
  async getPlan(idOrTier) {
    const plan = await SubscriptionPlan.findOne({
      $or: [{ _id: idOrTier }, { tier: idOrTier }],
    }).lean();
    if (!plan) throw new Error('Plan not found');
    return plan;
  }

  /**
   * Assign a plan to an organization.
   */
  async assignPlan(orgId, planId, options = {}) {
    const [org, plan] = await Promise.all([
      Organization.findById(orgId),
      SubscriptionPlan.findById(planId),
    ]);

    if (!org) throw new Error('Organization not found');
    if (!plan) throw new Error('Plan not found');

    // Cancel existing active subscription
    await Subscription.updateMany(
      { organizationId: orgId, status: { $in: ['active', 'trial'] } },
      { status: 'cancelled', cancelledAt: new Date() }
    );

    // Create new subscription
    const startDate = new Date();
    const subscription = new Subscription({
      organizationId: orgId,
      planId: plan._id,
      status: options.isTrial ? 'trial' : 'active',
      startDate,
      trialEndsAt: options.isTrial ? new Date(startDate.getTime() + 14 * 24 * 60 * 60 * 1000) : null,
      billingCycle: options.billingCycle || 'monthly',
      autoRenew: options.autoRenew !== false,
      nextBillingDate: this._calculateNextBilling(startDate, options.billingCycle || 'monthly'),
      customPricing: options.customPricing || null,
      notes: options.notes || null,
    });

    await subscription.save();

    // Update organization
    org.planId = plan._id;
    org.subscriptionStatus = options.isTrial ? 'trial' : 'active';
    org.studyLimitMonthly = plan.isUnlimited ? -1 : plan.studyLimit;
    await org.save();

    logger.info('Plan assigned', { orgId, planId: plan._id, tier: plan.tier });
    return subscription.populate('planId');
  }

  /**
   * Upgrade plan.
   */
  async upgradePlan(orgId, newPlanId) {
    const currentSub = await this.getCurrentSubscription(orgId);
    const newPlan = await SubscriptionPlan.findById(newPlanId);
    if (!newPlan) throw new Error('New plan not found');

    if (currentSub) {
      const currentPlan = await SubscriptionPlan.findById(currentSub.planId);
      if (currentPlan && newPlan.priceMonthly <= currentPlan.priceMonthly) {
        throw new Error('New plan must be higher tier for upgrade. Use downgrade instead.');
      }
    }

    return this.assignPlan(orgId, newPlanId, { notes: `Upgraded from ${currentSub?.planId}` });
  }

  /**
   * Downgrade plan.
   */
  async downgradePlan(orgId, newPlanId) {
    const currentSub = await this.getCurrentSubscription(orgId);
    if (!currentSub) throw new Error('No active subscription to downgrade');

    // Downgrade takes effect at end of current billing cycle
    const subscription = await this.assignPlan(orgId, newPlanId, {
      notes: `Downgraded from ${currentSub.planId}. Effective at next billing cycle.`,
    });

    logger.info('Plan downgraded', { orgId, newPlanId });
    return subscription;
  }

  /**
   * Cancel subscription.
   */
  async cancelSubscription(orgId) {
    const sub = await Subscription.findOne({
      organizationId: orgId,
      status: { $in: ['active', 'trial'] },
    });

    if (!sub) throw new Error('No active subscription to cancel');

    sub.status = 'cancelled';
    sub.cancelledAt = new Date();
    sub.autoRenew = false;
    await sub.save();

    const org = await Organization.findById(orgId);
    if (org) {
      org.subscriptionStatus = 'cancelled';
      await org.save();
    }

    logger.info('Subscription cancelled', { orgId, subscriptionId: sub._id });
    return sub;
  }

  /**
   * Get current active subscription for an organization.
   */
  async getCurrentSubscription(orgId) {
    return Subscription.findOne({
      organizationId: orgId,
      status: { $in: ['active', 'trial'] },
    }).populate('planId').lean();
  }

  /**
   * Check if organization can process more studies.
   */
  async checkLimits(orgId) {
    const org = await Organization.findById(orgId).populate('planId').lean();
    if (!org) throw new Error('Organization not found');

    const plan = org.planId;
    if (!plan) {
      return { allowed: false, reason: 'No active plan' };
    }

    if (plan.isUnlimited) {
      return { allowed: true, remaining: 'unlimited' };
    }

    const now = new Date();
    const { UsageTracking } = require('../models');
    const usage = await UsageTracking.findOne({
      organizationId: orgId,
      month: now.getMonth() + 1,
      year: now.getFullYear(),
    }).lean();

    const used = usage?.studiesProcessed || 0;
    const limit = plan.studyLimit || 0;

    if (used >= limit) {
      // Check if they have credits for pay-per-study
      if (org.creditsBalance > 0 && plan.payPerStudyPrice > 0) {
        return {
          allowed: true,
          payPerStudy: true,
          creditCost: plan.payPerStudyPrice,
          creditsRemaining: org.creditsBalance,
        };
      }
      return { allowed: false, reason: 'Monthly study limit reached', used, limit };
    }

    return { allowed: true, remaining: limit - used, used, limit };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────
  _calculateNextBilling(startDate, cycle) {
    const next = new Date(startDate);
    if (cycle === 'yearly') {
      next.setFullYear(next.getFullYear() + 1);
    } else {
      next.setMonth(next.getMonth() + 1);
    }
    return next;
  }
}

module.exports = new SubscriptionService();
