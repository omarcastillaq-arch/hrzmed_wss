/**
 * @module OrganizationService
 * @description Business logic for organization management in multi-tenant SaaS.
 */

'use strict';

const { Organization, SubscriptionPlan, Subscription, UsageTracking, MedicalUser } = require('../models');
const logger = require('../utils/logger');

class OrganizationService {
  /**
   * Create a new organization with optional admin user.
   */
  async createOrganization(data) {
    const existing = await Organization.findOne({
      $or: [{ email: data.email }, { slug: data.slug }],
    });
    if (existing) {
      throw new Error('Organization with this email or slug already exists');
    }

    const org = new Organization({
      name: data.name,
      slug: data.slug || data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      type: data.type || 'clinic',
      email: data.email,
      phone: data.phone,
      address: data.address,
      subscriptionStatus: 'trial',
      settings: data.settings || {},
    });

    await org.save();
    logger.info('Organization created', { orgId: org._id, name: org.name, type: org.type });
    return org;
  }

  /**
   * Get organization by ID.
   */
  async getOrganization(id) {
    const org = await Organization.findById(id).populate('planId').lean();
    if (!org) throw new Error('Organization not found');
    return org;
  }

  /**
   * List all organizations with pagination and filters.
   */
  async listOrganizations({ page = 1, limit = 20, type, status, search } = {}) {
    const filter = {};
    if (type) filter.type = type;
    if (status) filter.subscriptionStatus = status;
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ];
    }

    const skip = (page - 1) * limit;
    const [organizations, total] = await Promise.all([
      Organization.find(filter).populate('planId').sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Organization.countDocuments(filter),
    ]);

    return {
      organizations,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Update organization.
   */
  async updateOrganization(id, data) {
    const org = await Organization.findById(id);
    if (!org) throw new Error('Organization not found');

    const allowedFields = ['name', 'email', 'phone', 'address', 'settings', 'type'];
    for (const field of allowedFields) {
      if (data[field] !== undefined) {
        org[field] = data[field];
      }
    }

    await org.save();
    logger.info('Organization updated', { orgId: id });
    return org;
  }

  /**
   * Suspend an organization.
   */
  async suspendOrganization(id, reason) {
    const org = await Organization.findById(id);
    if (!org) throw new Error('Organization not found');

    org.isActive = false;
    org.subscriptionStatus = 'suspended';
    org.suspendedAt = new Date();
    org.suspendReason = reason || 'Suspended by administrator';

    await org.save();

    // Also suspend active subscription
    await Subscription.updateMany(
      { organizationId: id, status: 'active' },
      { status: 'suspended' }
    );

    logger.info('Organization suspended', { orgId: id, reason });
    return org;
  }

  /**
   * Reactivate a suspended organization.
   */
  async reactivateOrganization(id) {
    const org = await Organization.findById(id);
    if (!org) throw new Error('Organization not found');

    org.isActive = true;
    org.subscriptionStatus = 'active';
    org.suspendedAt = null;
    org.suspendReason = null;

    await org.save();
    logger.info('Organization reactivated', { orgId: id });
    return org;
  }

  /**
   * Get organization usage summary.
   */
  async getOrganizationUsage(id, month, year) {
    const now = new Date();
    const m = month || now.getMonth() + 1;
    const y = year || now.getFullYear();

    const usage = await UsageTracking.findOne({
      organizationId: id,
      month: m,
      year: y,
    }).lean();

    const org = await Organization.findById(id).populate('planId').lean();
    const userCount = await MedicalUser.countDocuments({ organizationId: id, active: true });

    return {
      organization: { id: org._id, name: org.name },
      period: { month: m, year: y },
      usage: usage || { studiesProcessed: 0, creditsConsumed: 0, rpmPatientsActive: 0 },
      limits: {
        studyLimit: org.studyLimitMonthly || org.planId?.studyLimit || 0,
        isUnlimited: org.planId?.isUnlimited || false,
      },
      credits: { balance: org.creditsBalance || 0 },
      users: { active: userCount },
    };
  }

  /**
   * Get organization statistics (for dashboard).
   */
  async getOrganizationStatistics(id) {
    const org = await Organization.findById(id).populate('planId').lean();
    if (!org) throw new Error('Organization not found');

    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();

    const [usage, userCount, patientCount] = await Promise.all([
      UsageTracking.findOne({ organizationId: id, month, year }).lean(),
      MedicalUser.countDocuments({ organizationId: id, active: true }),
      require('../models').Patient.countDocuments({ organizationId: id, active: true }),
    ]);

    return {
      plan: org.planId ? { name: org.planId.name, tier: org.planId.tier } : null,
      subscriptionStatus: org.subscriptionStatus,
      credits: org.creditsBalance,
      currentMonth: {
        studiesProcessed: usage?.studiesProcessed || 0,
        studyLimit: org.planId?.isUnlimited ? 'unlimited' : (org.planId?.studyLimit || 0),
        creditsConsumed: usage?.creditsConsumed || 0,
        rpmPatientsActive: usage?.rpmPatientsActive || 0,
      },
      totals: {
        users: userCount,
        patients: patientCount,
      },
    };
  }
}

module.exports = new OrganizationService();
