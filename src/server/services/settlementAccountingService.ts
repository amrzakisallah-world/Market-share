import type {
  DistributionRules,
  Order,
  ShopDailyEntry,
  ShopDailyEntryType,
  ShopStatement,
  VolunteerStatement,
} from '../../types/commerce.ts';
import type { CommerceStorageAdapter } from '../storage.ts';
import {
  DomainError,
  appendAuditLog,
  computeOrderCashHoldings,
  computeSettlementStatus,
  makeId,
  roundMoney,
  roundStockQty,
  sanitizeOrder,
} from './shared.ts';

export class SettlementAccountingService {
  private readonly storage: CommerceStorageAdapter;

  constructor(storage: CommerceStorageAdapter) {
    this.storage = storage;
  }

  async shopConfirmRemittanceReceipt(input: {
    shopId: string;
    orderNumber: string;
    confirmedBy: string;
    shiftId?: string;
    note?: string;
  }): Promise<Order> {
    return this.storage.transact((db) => {
      const order = db.orders.find((o) => o.orderNumber === input.orderNumber);
      if (!order) {
        throw new DomainError('الطلب غير موجود', 404);
      }
      if (order.shopId !== input.shopId) {
        throw new DomainError('هذا الطلب يتبع محلًا آخر', 403);
      }
      if (order.status !== 'completed' || !order.financials.collectedAt) {
        throw new DomainError('لم يكتمل تسليم وتحصيل هذا الطلب بعد');
      }
      const rem = order.financials.remittance;
      if (!rem) {
        throw new DomainError('لم يسجل المندوب توريد المبلغ لهذا الطلب بعد');
      }
      if (rem.mode === 'full_to_platform_instapay') {
        throw new DomainError('هذا الطلب محول مباشرة للإدارة عبر إنستاباي وليس عبر المحل');
      }
      if (rem.shopConfirmedAt) {
        throw new DomainError('تم تأكيد استلام هذا التحصيل من المندوب مسبقًا');
      }

      const now = new Date().toISOString();
      rem.shopConfirmedAt = now;
      rem.shopConfirmedBy = input.confirmedBy;
      rem.shopConfirmedShiftId = input.shiftId;
      if (input.note?.trim()) {
        rem.note = rem.note ? `${rem.note} | تأكيد المحل: ${input.note.trim()}` : input.note.trim();
      }

      order.financials.shopSettledAt = now;

      if (rem.mode === 'full_to_shop') {
        if (rem.amountPlatformAtShopEGP <= 0) {
          rem.status = 'settled';
          rem.verificationStage = 'closed_by_admin';
          rem.platformConfirmedAt = now;
          rem.platformConfirmedBy = 'تلقائي (لا يوجد رصيد إضافي للمنصة)';
        } else {
          rem.status = 'pending_platform_confirmation';
          rem.verificationStage = 'confirmed_by_shop';
        }
      } else {
        if (rem.amountWithCourierForPlatformEGP <= 0) {
          rem.status = 'settled';
          rem.verificationStage = 'closed_by_admin';
          rem.platformConfirmedAt = now;
          rem.platformConfirmedBy = 'تلقائي (لا يوجد رصيد متبقي مع المندوب)';
        } else {
          rem.status = 'pending_platform_confirmation';
          rem.verificationStage = 'confirmed_by_shop';
        }
      }

      order.financials.settlementStatus = computeSettlementStatus(order);
      if (order.financials.settlementStatus === 'fully_settled') {
        order.financials.fullySettledAt = now;
      }

      if (input.shiftId) {
        const openShift = db.shopShiftSessions.find(
          (sh) => sh.id === input.shiftId && sh.shopId === input.shopId && sh.status === 'open',
        );
        if (openShift) {
          openShift.onlineOrdersHandledCount += 1;
        }
      }

      const channelLabel =
        rem.shopTransferChannel === 'instapay' ? 'عبر إنستاباي' : 'نقديًا في المحل';
      const outcomeSummary =
        rem.mode === 'full_to_shop'
          ? `استلم المحل المبلغ كاملًا (${rem.amountToShopEGP} ج.م ${channelLabel}). اتقفلت تسوية المحل وعهدة المندوب أصبحت 0، وفلوسنا عند السوبر ماركت = ${rem.amountPlatformAtShopEGP} ج.م.`
          : `استلم المحل حصته (${rem.amountToShopEGP} ج.م ${channelLabel}). اتقفلت تسوية السوبر ماركت بالكامل، والجزء بتاعنا مع المندوب = ${rem.amountWithCourierForPlatformEGP} ج.م.`;

      order.timeline.push({
        id: makeId('tl'),
        timestamp: now,
        actorRole: 'shop_owner',
        actorName: input.confirmedBy,
        eventType: 'shop_remittance_confirmed',
        title: 'أكد المحل استلام التحصيل من المندوب — اتقفلت تسوية المحل',
        details: outcomeSummary,
      });

      appendAuditLog(db, {
        actorRole: input.shiftId ? 'pos_staff' : 'shop_owner',
        actorName: input.confirmedBy,
        shopId: order.shopId,
        category: 'finance',
        action: 'shop_confirm_remittance',
        targetId: order.orderNumber,
        summary: `تأكيد استلام المحل لتوريد الطلب ${order.orderNumber} (${rem.amountToShopEGP} ج.م)`,
      });

      return sanitizeOrder(order);
    });
  }

  async adminConfirmRemittance(input: {
    orderNumber: string;
    target: 'from_shop' | 'from_volunteer' | 'full';
    actorName: string;
    settleVolunteerShareToo?: boolean;
    overrideReason?: string;
  }): Promise<Order> {
    return this.storage.transact((db) => {
      const order = db.orders.find((o) => o.orderNumber === input.orderNumber);
      if (!order) {
        throw new DomainError('الطلب غير موجود', 404);
      }
      if (order.status !== 'completed' || !order.financials.collectedAt) {
        throw new DomainError('لا يمكن تأكيد التوريد قبل تسليم الطلب وتحصيله');
      }

      const rem = order.financials.remittance;
      if (!rem) {
        throw new DomainError('لا يوجد سجل توريد مسجل لهذا الطلب بعد');
      }

      const now = new Date().toISOString();

      if (input.target === 'from_shop') {
        if (rem.mode !== 'full_to_shop') {
          throw new DomainError('الرصيد على هذا الطلب ليس عند السوبر ماركت');
        }
        if (!rem.shopConfirmedAt) {
          throw new DomainError('يجب أن يؤكد المحل استلام المبلغ من المندوب أولًا');
        }
        rem.platformConfirmedAt = now;
        rem.platformConfirmedBy = input.actorName;
        rem.status = 'settled';
        rem.verificationStage = 'closed_by_admin';
        if (!order.financials.shopSettledAt) {
          order.financials.shopSettledAt = now;
        }
        if (input.settleVolunteerShareToo && !order.financials.volunteerSettledAt) {
          order.financials.volunteerSettledAt = now;
        }
        order.timeline.push({
          id: makeId('tl'),
          timestamp: now,
          actorRole: 'super_admin',
          actorName: input.actorName,
          eventType: 'admin_collected_from_shop',
          title: `تأكيد استلام حصة المنصة من السوبر ماركت (${rem.amountPlatformAtShopEGP} ج.م)`,
        });
      } else if (input.target === 'from_volunteer') {
        if (rem.mode === 'split_shop_and_courier' && !rem.shopConfirmedAt) {
          throw new DomainError('يجب أن يؤكد المحل استلام حصته من المندوب أولًا');
        }
        const amt =
          rem.mode === 'full_to_platform_instapay'
            ? rem.amountDirectToPlatformEGP
            : rem.amountWithCourierForPlatformEGP;
        rem.platformConfirmedAt = now;
        rem.platformConfirmedBy = input.actorName;
        rem.status = 'settled';
        rem.verificationStage = 'closed_by_admin';
        if (input.settleVolunteerShareToo && !order.financials.volunteerSettledAt) {
          order.financials.volunteerSettledAt = now;
        }
        order.timeline.push({
          id: makeId('tl'),
          timestamp: now,
          actorRole: 'super_admin',
          actorName: input.actorName,
          eventType: 'admin_collected_from_volunteer',
          title: `تأكيد استلام حصة المنصة من المندوب (${amt} ج.م)`,
        });
      } else {
        // Explicit admin override close if shop hasn't confirmed yet
        if (rem.mode !== 'full_to_platform_instapay' && !rem.shopConfirmedAt) {
          const reason = (input.overrideReason ?? '').trim();
          if (!reason) {
            throw new DomainError(
              'لم يؤكد المحل استلام المبلغ بعد — يجب تأكيد المحل أولًا أو كتابة سبب التجاوز الإداري الصريح.',
              409,
            );
          }
          rem.shopConfirmedAt = now;
          rem.shopConfirmedBy = `${input.actorName} (تجاوز إداري موثق)`;
          rem.adminOverrideReason = reason;
          rem.verificationStage = 'admin_override_closed';
        } else {
          rem.verificationStage = 'closed_by_admin';
        }
        rem.platformConfirmedAt = now;
        rem.platformConfirmedBy = input.actorName;
        rem.status = 'settled';
        if (!order.financials.shopSettledAt) order.financials.shopSettledAt = now;
        if (!order.financials.volunteerSettledAt) order.financials.volunteerSettledAt = now;
        order.timeline.push({
          id: makeId('tl'),
          timestamp: now,
          actorRole: 'super_admin',
          actorName: input.actorName,
          eventType: 'remittance_fully_closed',
          title: 'تقفيل وتسوية مسار التوريد والأطراف بالكامل',
          details: rem.adminOverrideReason ? `سبب التجاوز الإداري: ${rem.adminOverrideReason}` : undefined,
        });
      }

      order.financials.settlementStatus = computeSettlementStatus(order);
      if (order.financials.settlementStatus === 'fully_settled') {
        order.financials.fullySettledAt = now;
      }

      appendAuditLog(db, {
        actorRole: 'super_admin',
        actorName: input.actorName,
        shopId: order.shopId,
        category: 'finance',
        action: `admin_confirm_remittance_${input.target}`,
        targetId: order.orderNumber,
        summary: `تأكيد إداري لتوريد الطلب ${order.orderNumber} (${input.target})`,
      });

      return sanitizeOrder(order);
    });
  }

  async settleOrderParty(input: {
    orderNumber: string;
    party: 'shop' | 'volunteer' | 'both';
    actorName: string;
    forceOverrideReason?: string;
  }): Promise<Order> {
    return this.storage.transact((db) => {
      const order = db.orders.find((o) => o.orderNumber === input.orderNumber);
      if (!order) {
        throw new DomainError('الطلب غير موجود', 404);
      }
      if (order.status !== 'completed' || !order.financials.collectedAt) {
        throw new DomainError('لا يمكن تسوية طلب لم يكتمل تسليمه وتحصيله بعد');
      }

      const rem = order.financials.remittance;
      const needsShopOverride = Boolean(
        rem &&
          rem.mode !== 'full_to_platform_instapay' &&
          !rem.shopConfirmedAt &&
          (input.party === 'shop' || input.party === 'both'),
      );

      if (needsShopOverride && !(input.forceOverrideReason ?? '').trim()) {
        throw new DomainError(
          'المندوب سجل توريدًا بانتظار تأكيد المحل للاستلام الفعلي. يجب أن يؤكد المحل الاستلام أولًا أو إرفاق سبب التجاوز الإداري.',
          409,
        );
      }

      const now = new Date().toISOString();
      const overrideReason = input.forceOverrideReason?.trim() || undefined;

      if ((input.party === 'shop' || input.party === 'both') && !order.financials.shopSettledAt) {
        order.financials.shopSettledAt = now;
        order.timeline.push({
          id: makeId('tl'),
          timestamp: now,
          actorRole: 'super_admin',
          actorName: input.actorName,
          eventType: 'shop_settled',
          title: `تمت تسوية مستحقات المحل (${order.financials.shopDueEGP} ج.م)`,
          details: overrideReason ? `تجاوز إداري: ${overrideReason}` : undefined,
        });
      }
      if (
        (input.party === 'volunteer' || input.party === 'both') &&
        !order.financials.volunteerSettledAt
      ) {
        order.financials.volunteerSettledAt = now;
        order.timeline.push({
          id: makeId('tl'),
          timestamp: now,
          actorRole: 'super_admin',
          actorName: input.actorName,
          eventType: 'volunteer_settled',
          title: `تمت تسوية مستحق المتطوع (${order.financials.volunteerShareEGP} ج.م)`,
        });
      }
      if (input.party === 'both' && rem && !rem.platformConfirmedAt) {
        if (rem.mode !== 'full_to_platform_instapay' && !rem.shopConfirmedAt) {
          rem.shopConfirmedAt = now;
          rem.shopConfirmedBy = `${input.actorName} (تجاوز إداري موثق)`;
          rem.adminOverrideReason = overrideReason;
          rem.verificationStage = 'admin_override_closed';
        } else {
          rem.verificationStage = 'closed_by_admin';
        }
        rem.platformConfirmedAt = now;
        rem.platformConfirmedBy = input.actorName;
        rem.status = 'settled';
      }

      order.financials.settlementStatus = computeSettlementStatus(order);
      if (order.financials.settlementStatus === 'fully_settled') {
        order.financials.fullySettledAt = now;
      }

      appendAuditLog(db, {
        actorRole: 'super_admin',
        actorName: input.actorName,
        shopId: order.shopId,
        category: 'finance',
        action: `settle_${input.party}`,
        targetId: order.orderNumber,
        summary: `تسوية مالية (${input.party}) للطلب ${order.orderNumber}${overrideReason ? ` — تجاوز: ${overrideReason}` : ''}`,
      });

      return sanitizeOrder(order);
    });
  }

  async getShopDailyEntries(shopId: string): Promise<ShopDailyEntry[]> {
    const db = await this.storage.read();
    return db.shopDailyEntries.filter((e) => e.shopId === shopId);
  }

  async addShopDailyEntry(input: {
    shopId: string;
    type: ShopDailyEntryType;
    category: string;
    description: string;
    amountEGP: number;
    supplierName?: string;
    invoiceRef?: string;
    relatedProductId?: string;
    quantityRestocked?: number;
    createdBy: string;
  }): Promise<ShopDailyEntry> {
    const amount = Number(input.amountEGP);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new DomainError('المبلغ يجب أن يكون أكبر من صفر');
    }
    if (!input.description?.trim()) {
      throw new DomainError('يرجى إدخال وصف العملية');
    }

    return this.storage.transact((db) => {
      const shop = db.shops.find((s) => s.id === input.shopId);
      if (!shop) {
        throw new DomainError('المحل غير موجود', 404);
      }

      const now = new Date().toISOString();
      let relatedProductName: string | undefined;

      if (
        input.type === 'purchase' &&
        input.relatedProductId &&
        input.quantityRestocked &&
        input.quantityRestocked > 0
      ) {
        const listing = db.shopListings.find(
          (l) => l.shopId === input.shopId && l.productId === input.relatedProductId,
        );
        const product = db.masterProducts.find((p) => p.id === input.relatedProductId);
        if (listing && product) {
          const qty = product.isWeighted
            ? roundStockQty(Number(input.quantityRestocked))
            : Math.floor(Number(input.quantityRestocked));
          if (qty > 0) {
            listing.currentStock = roundStockQty(listing.currentStock + qty);
            listing.isAvailable = listing.currentStock - listing.reservedStock > 0;
            relatedProductName = product.name;
            db.inventoryMovements.unshift({
              id: makeId('mov'),
              shopId: input.shopId,
              productId: product.id,
              productName: product.name,
              type: 'purchase_restock',
              quantityDelta: qty,
              reservedDelta: 0,
              stockAfter: listing.currentStock,
              reservedAfter: listing.reservedStock,
              actorRole: 'shop_owner',
              actorName: input.createdBy,
              reason: `توريد مشتريات${input.supplierName ? ` (${input.supplierName.trim()})` : ''}: ${input.description.trim()}`,
              createdAt: now,
            });
          }
        }
      }

      const entry: ShopDailyEntry = {
        id: makeId('entry'),
        shopId: input.shopId,
        type: input.type,
        category: input.category?.trim() || 'عام',
        description: input.description.trim(),
        amountEGP: roundMoney(amount),
        supplierName: input.supplierName?.trim() || undefined,
        invoiceRef: input.invoiceRef?.trim() || undefined,
        relatedProductId: input.relatedProductId,
        relatedProductName,
        quantityRestocked: input.quantityRestocked,
        entryDate: now.slice(0, 10),
        createdBy: input.createdBy,
        createdAt: now,
      };

      db.shopDailyEntries.unshift(entry);
      appendAuditLog(db, {
        actorRole: 'shop_owner',
        actorName: input.createdBy,
        shopId: input.shopId,
        category: 'finance',
        action: `daily_entry_${input.type}`,
        targetId: entry.id,
        summary: `قيد ${input.type} بمبلغ ${entry.amountEGP} ج.م: ${entry.description}`,
      });

      return entry;
    });
  }

  async getDistributionRules(): Promise<DistributionRules> {
    const db = await this.storage.read();
    return db.distributionRules;
  }

  async updateDistributionRules(
    input: Partial<DistributionRules>,
    actorName = 'الإدارة المركزية',
  ): Promise<DistributionRules> {
    return this.storage.transact((db) => {
      const next = { ...db.distributionRules };
      if (input.defaultDeliveryFeeEGP !== undefined) {
        const fee = Number(input.defaultDeliveryFeeEGP);
        if (!Number.isFinite(fee) || fee < 0) {
          throw new DomainError('رسوم التوصيل غير صالحة');
        }
        next.defaultDeliveryFeeEGP = roundMoney(fee);
        for (const shop of db.shops) {
          shop.defaultDeliveryFeeEGP = next.defaultDeliveryFeeEGP;
        }
      }
      if (input.volunteerShareMode === 'percentage' || input.volunteerShareMode === 'fixed') {
        next.volunteerShareMode = input.volunteerShareMode;
      }
      if (input.volunteerShareValue !== undefined) {
        const val = Number(input.volunteerShareValue);
        if (!Number.isFinite(val) || val < 0) {
          throw new DomainError('قيمة حصة المتطوع غير صالحة');
        }
        if (next.volunteerShareMode === 'percentage' && val > 100) {
          throw new DomainError('نسبة المتطوع لا يمكن أن تتجاوز 100%');
        }
        next.volunteerShareValue = roundMoney(val);
      }
      if (input.operatingCostPerOrderEGP !== undefined) {
        const cost = Number(input.operatingCostPerOrderEGP);
        if (!Number.isFinite(cost) || cost < 0) {
          throw new DomainError('تكلفة التشغيل غير صالحة');
        }
        next.operatingCostPerOrderEGP = roundMoney(cost);
      }
      if (input.platformCommissionPercent !== undefined) {
        const comm = Number(input.platformCommissionPercent);
        if (!Number.isFinite(comm) || comm < 0 || comm > 30) {
          throw new DomainError('نسبة العمولة يجب أن تكون بين 0% و 30%');
        }
        next.platformCommissionPercent = roundMoney(comm);
      }
      next.updatedAt = new Date().toISOString();
      db.distributionRules = next;

      appendAuditLog(db, {
        actorRole: 'super_admin',
        actorName,
        category: 'admin',
        action: 'update_distribution_rules',
        summary: `تحديث قواعد التوزيع (توصيل: ${next.defaultDeliveryFeeEGP} ج.م، عمولة: ${next.platformCommissionPercent}%)`,
      });

      return next;
    });
  }

  async getShopStatement(shopId: string): Promise<ShopStatement> {
    const db = await this.storage.read();
    const shop = db.shops.find((s) => s.id === shopId);
    if (!shop) {
      throw new DomainError('المحل غير موجود', 404);
    }

    const shopOrders = db.orders.filter((o) => o.shopId === shopId);
    const completedOrders = shopOrders.filter((o) => o.status === 'completed');

    let platformSalesGMV = 0;
    let totalShopDueEGP = 0;
    let settledToShopEGP = 0;
    let platformReceivableFromShopEGP = 0;
    let pendingShopRemittanceConfirmationsCount = 0;

    for (const o of completedOrders) {
      platformSalesGMV = roundMoney(platformSalesGMV + o.financials.itemsTotalEGP);
      totalShopDueEGP = roundMoney(totalShopDueEGP + o.financials.shopDueEGP);
      if (o.financials.shopSettledAt) {
        settledToShopEGP = roundMoney(settledToShopEGP + o.financials.shopDueEGP);
      }
      const rem = o.financials.remittance;
      if (
        rem &&
        (rem.mode === 'full_to_shop' || rem.mode === 'split_shop_and_courier') &&
        !rem.shopConfirmedAt
      ) {
        pendingShopRemittanceConfirmationsCount += 1;
      }
      const holdings = computeOrderCashHoldings(o);
      platformReceivableFromShopEGP = roundMoney(
        platformReceivableFromShopEGP + holdings.platformAtShopEGP,
      );
    }

    const entries = db.shopDailyEntries.filter((e) => e.shopId === shopId);
    const offlineSalesEGP = roundMoney(
      entries.filter((e) => e.type === 'offline_sale').reduce((s, e) => s + e.amountEGP, 0),
    );
    const totalPurchasesEGP = roundMoney(
      entries.filter((e) => e.type === 'purchase').reduce((s, e) => s + e.amountEGP, 0),
    );
    const totalExpensesEGP = roundMoney(
      entries.filter((e) => e.type === 'expense').reduce((s, e) => s + e.amountEGP, 0),
    );

    const ratedShopOrders = completedOrders.filter((o) => Boolean(o.rating));
    const averageRating =
      ratedShopOrders.length > 0
        ? roundMoney(
            ratedShopOrders.reduce(
              (acc, o) => acc + (o.rating!.shopRating ?? o.rating!.overallRating),
              0,
            ) / ratedShopOrders.length,
          )
        : null;

    const pendingSettlementToShopEGP = roundMoney(totalShopDueEGP - settledToShopEGP);

    return {
      shopId: shop.id,
      shopName: shop.name,
      completedOrdersCount: completedOrders.length,
      platformSalesGMV,
      totalShopDueEGP,
      settledToShopEGP,
      pendingSettlementToShopEGP,
      platformReceivableFromShopEGP,
      pendingShopRemittanceConfirmationsCount,
      netBalanceWithShopEGP: roundMoney(
        pendingSettlementToShopEGP - platformReceivableFromShopEGP,
      ),
      offlineSalesEGP,
      totalPurchasesEGP,
      totalExpensesEGP,
      estimatedNetCashFlowEGP: roundMoney(
        totalShopDueEGP + offlineSalesEGP - totalPurchasesEGP - totalExpensesEGP,
      ),
      averageRating,
      ratingsCount: ratedShopOrders.length,
      orderRows: shopOrders.map((o) => ({
        orderNumber: o.orderNumber,
        createdAt: o.createdAt,
        status: o.status,
        itemsTotalEGP: o.financials.itemsTotalEGP,
        shopDueEGP: o.financials.shopDueEGP,
        collectedAmountEGP: o.financials.collectedAmountEGP,
        settlementStatus: o.financials.settlementStatus,
        remittance: o.financials.remittance,
      })),
    };
  }

  async getVolunteerStatement(volunteerId: string): Promise<VolunteerStatement> {
    const db = await this.storage.read();
    const volunteer = db.volunteers.find((v) => v.id === volunteerId);
    if (!volunteer) {
      throw new DomainError('المتطوع غير موجود', 404);
    }

    const volOrders = db.orders.filter((o) => o.volunteerId === volunteerId);
    const delivered = volOrders.filter((o) => o.deliveryStatus === 'delivered');
    const failed = volOrders.filter((o) => o.deliveryStatus === 'delivery_failed');

    let totalCashCollectedEGP = 0;
    let totalDeliveryFeesEGP = 0;
    let totalVolunteerEarningsEGP = 0;
    let settledEarningsEGP = 0;
    let cashToRemitEGP = 0;
    let heldWithCourierForPlatformEGP = 0;
    let remittedToShopTotalEGP = 0;
    let remittedDirectInstapayEGP = 0;

    for (const o of delivered) {
      totalCashCollectedEGP = roundMoney(totalCashCollectedEGP + o.financials.collectedAmountEGP);
      totalDeliveryFeesEGP = roundMoney(totalDeliveryFeesEGP + o.financials.deliveryFeeEGP);
      totalVolunteerEarningsEGP = roundMoney(
        totalVolunteerEarningsEGP + o.financials.volunteerShareEGP,
      );
      if (o.financials.volunteerSettledAt) {
        settledEarningsEGP = roundMoney(settledEarningsEGP + o.financials.volunteerShareEGP);
      }
      const holdings = computeOrderCashHoldings(o);
      cashToRemitEGP = roundMoney(cashToRemitEGP + holdings.courierCashCustodyEGP);
      remittedToShopTotalEGP = roundMoney(remittedToShopTotalEGP + holdings.remittedToShopEGP);
      remittedDirectInstapayEGP = roundMoney(
        remittedDirectInstapayEGP + holdings.remittedDirectInstapayEGP,
      );
      if (
        o.financials.remittance?.mode === 'split_shop_and_courier' &&
        o.financials.remittance.shopConfirmedAt &&
        !o.financials.remittance.platformConfirmedAt
      ) {
        heldWithCourierForPlatformEGP = roundMoney(
          heldWithCourierForPlatformEGP + o.financials.remittance.amountWithCourierForPlatformEGP,
        );
      }
    }

    const pendingEarningsEGP = roundMoney(totalVolunteerEarningsEGP - settledEarningsEGP);
    const ratedDeliveries = delivered.filter((o) => Boolean(o.rating));
    const averageDeliveryRating =
      ratedDeliveries.length > 0
        ? roundMoney(
            ratedDeliveries.reduce(
              (acc, o) => acc + (o.rating!.deliveryRating ?? o.rating!.overallRating),
              0,
            ) / ratedDeliveries.length,
          )
        : null;

    return {
      volunteerId: volunteer.id,
      volunteerName: volunteer.name,
      assignedCount: volOrders.length,
      deliveredCount: delivered.length,
      failedCount: failed.length,
      totalCashCollectedEGP,
      totalDeliveryFeesEGP,
      totalVolunteerEarningsEGP,
      settledEarningsEGP,
      pendingEarningsEGP,
      cashToRemitEGP,
      heldWithCourierForPlatformEGP,
      remittedToShopTotalEGP,
      remittedDirectInstapayEGP,
      averageDeliveryRating,
      ratingsCount: ratedDeliveries.length,
      orderRows: volOrders.map((o) => ({
        orderNumber: o.orderNumber,
        shopName: o.shopName,
        customerName: o.customerName,
        deliveryStatus: o.deliveryStatus,
        customerExpectedTotalEGP: o.financials.customerExpectedTotalEGP,
        collectedAmountEGP: o.financials.collectedAmountEGP,
        collectionDiscrepancyEGP: o.financials.collectionDiscrepancyEGP,
        deliveryFeeEGP: o.financials.deliveryFeeEGP,
        shopDueEGP: o.financials.shopDueEGP,
        volunteerShareEGP: o.financials.volunteerShareEGP,
        settlementStatus: o.financials.settlementStatus,
        remittance: o.financials.remittance,
        deliveredAt: o.deliveredAt,
        ratingScore: o.rating ? (o.rating.deliveryRating ?? o.rating.overallRating) : undefined,
        ratingComment: o.rating?.comment,
        complimentTags: o.rating?.complimentTags,
      })),
    };
  }
}
