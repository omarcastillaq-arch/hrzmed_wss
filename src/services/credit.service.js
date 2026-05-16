/**
 * @module CreditService
 * @description Business logic for pay-per-study credit system.
 */

'use strict';

const { Organization, Credit } = require('../models');
const logger = require('../utils/logger');

class CreditService {
  /**
   * Purchase credits for an organization.
   */
  async purchaseCredits(orgId, amount, pricePerCredit, currency = 'USD', performedBy = null) {
    if (amount <= 0) throw new Error('Amount must be positive');
    if (pricePerCredit < 0) throw new Error('Price must be non-negative');

    const org = await Organization.findById(orgId);
    if (!org) throw new Error('Organization not found');

    const newBalance = org.creditsBalance + amount;
    const totalPrice = amount * pricePerCredit;

    const credit = new Credit({
      organizationId: orgId,
      amount,
      balance: newBalance,
      transactionType: 'purchase',
      description: `Purchased ${amount} credits at $${pricePerCredit} each`,
      unitPrice: pricePerCredit,
      totalPrice,
      currency,
      performedBy,
    });

    await credit.save();

    org.creditsBalance = newBalance;
    await org.save();

    logger.info('Credits purchased', { orgId, amount, newBalance, totalPrice });
    return { transaction: credit, balance: newBalance };
  }

  /**
   * Deduct credit for a study.
   */
  async deductCredit(orgId, studyId, amount = 1, description = null) {
    const org = await Organization.findById(orgId);
    if (!org) throw new Error('Organization not found');

    if (org.creditsBalance < amount) {
      throw new Error('Insufficient credits');
    }

    const newBalance = org.creditsBalance - amount;

    const credit = new Credit({
      organizationId: orgId,
      amount: -amount,
      balance: newBalance,
      transactionType: 'deduction',
      description: description || `Study deduction: ${studyId}`,
      studyId,
    });

    await credit.save();

    org.creditsBalance = newBalance;
    await org.save();

    // Check for low balance alert
    if (newBalance <= 5) {
      this._alertLowBalance(orgId, newBalance);
    }

    logger.info('Credit deducted', { orgId, studyId, amount, newBalance });
    return { transaction: credit, balance: newBalance };
  }

  /**
   * Refund credits.
   */
  async refundCredits(orgId, amount, reason, performedBy = null) {
    if (amount <= 0) throw new Error('Amount must be positive');

    const org = await Organization.findById(orgId);
    if (!org) throw new Error('Organization not found');

    const newBalance = org.creditsBalance + amount;

    const credit = new Credit({
      organizationId: orgId,
      amount,
      balance: newBalance,
      transactionType: 'refund',
      description: reason || `Refund of ${amount} credits`,
      performedBy,
    });

    await credit.save();

    org.creditsBalance = newBalance;
    await org.save();

    logger.info('Credits refunded', { orgId, amount, newBalance });
    return { transaction: credit, balance: newBalance };
  }

  /**
   * Get current balance.
   */
  async getBalance(orgId) {
    const org = await Organization.findById(orgId).lean();
    if (!org) throw new Error('Organization not found');
    return {
      balance: org.creditsBalance,
      organizationId: orgId,
    };
  }

  /**
   * Get credit transaction history.
   */
  async getHistory(orgId, { page = 1, limit = 20, type } = {}) {
    const filter = { organizationId: orgId };
    if (type) filter.transactionType = type;

    const skip = (page - 1) * limit;
    const [transactions, total] = await Promise.all([
      Credit.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Credit.countDocuments(filter),
    ]);

    return {
      transactions,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Alert low balance (internal).
   */
  _alertLowBalance(orgId, balance) {
    logger.info('Low credit balance alert', { orgId, balance });
    // TODO: Integrate with notification service
  }
}

module.exports = new CreditService();
