import type {
  AnalyticsReport,
  AuditCategory,
  AuditLogEntry,
  BackupSnapshotInfo,
  CommerceDatabase,
  OperationalMode,
  Order,
  OrderStatus,
  OwnerOperationalMemory,
  RuntimeConfig,
} from '../../types/commerce.ts';
import type { CommerceStorageAdapter } from '../storage.ts';
import {
  DomainError,
  appendAuditLog,
  computeOrderCashHoldings,
  roundMoney,
  sanitizeOrder,
} from './shared.ts';

export class AnalyticsBackupService {
  private readonly storage: CommerceStorageAdapter;

  constructor(storage: CommerceStorageAdapter) {
    this.storage = storage;
  }

  async getAdminOrders(filters?: {
    shopId?: string;
    volunteerId?: string;
    status?: string;
    dateFrom?: string;
    dateTo?: string;
  }): Promise<Order[]> {
    const db = await this.storage.read();
    return db.orders
      .filter((o) => {
        if (filters?.shopId && filters.shopId !== 'all' && o.shopId !== filters.shopId) return false;
        if (
          filters?.volunteerId &&
          filters.volunteerId !== 'all' &&
          o.volunteerId !== filters.volunteerId
        ) {
          return false;
        }
        if (filters?.status && filters.status !== 'all' && o.status !== filters.status) return false;
        if (filters?.dateFrom && o.createdAt.slice(0, 10) < filters.dateFrom) return false;
        if (filters?.dateTo && o.createdAt.slice(0, 10) > filters.dateTo) return false;
        return true;
      })
      .map(sanitizeOrder);
  }

  async getAnalytics(filters?: {
    shopId?: string;
    volunteerId?: string;
    dateFrom?: string;
    dateTo?: string;
    status?: string;
  }): Promise<AnalyticsReport> {
    const db = await this.storage.read();
    const filteredOrders = await this.getAdminOrders(filters);

    const activeStatuses: OrderStatus[] = ['new', 'confirmed', 'preparing', 'ready'];
    const activeOrders = filteredOrders.filter((o) => activeStatuses.includes(o.status));
    const completedOrders = filteredOrders.filter((o) => o.status === 'completed');
    const cancelledOrders = filteredOrders.filter((o) => o.status === 'cancelled');
    const failedDeliveryOrders = filteredOrders.filter(
      (o) => o.deliveryStatus === 'delivery_failed',
    );

    let platformGMV = 0;
    let totalDeliveryFees = 0;
    let totalShopDues = 0;
    let totalVolunteerEarnings = 0;
    let totalOperatingCosts = 0;
    let netOperatingContribution = 0;
    let unsettledShopBalance = 0;
    let unsettledVolunteerBalance = 0;
    let receivableFromShopsEGP = 0;
    let receivableFromVolunteersEGP = 0;
    let totalCashDiscrepancy = 0;

    for (const o of completedOrders) {
      platformGMV = roundMoney(platformGMV + o.financials.itemsTotalEGP);
      totalDeliveryFees = roundMoney(totalDeliveryFees + o.financials.deliveryFeeEGP);
      totalShopDues = roundMoney(totalShopDues + o.financials.shopDueEGP);
      totalVolunteerEarnings = roundMoney(totalVolunteerEarnings + o.financials.volunteerShareEGP);
      totalOperatingCosts = roundMoney(totalOperatingCosts + o.financials.operatingCostEGP);
      netOperatingContribution = roundMoney(
        netOperatingContribution + o.financials.platformRevenueEGP,
      );
      totalCashDiscrepancy = roundMoney(
        totalCashDiscrepancy + o.financials.collectionDiscrepancyEGP,
      );
      if (!o.financials.shopSettledAt) {
        unsettledShopBalance = roundMoney(unsettledShopBalance + o.financials.shopDueEGP);
      }
      if (!o.financials.volunteerSettledAt) {
        unsettledVolunteerBalance = roundMoney(
          unsettledVolunteerBalance + o.financials.volunteerShareEGP,
        );
      }
      const holdings = computeOrderCashHoldings(o);
      receivableFromShopsEGP = roundMoney(receivableFromShopsEGP + holdings.platformAtShopEGP);
      receivableFromVolunteersEGP = roundMoney(
        receivableFromVolunteersEGP + holdings.courierCashCustodyEGP,
      );
    }

    const prepDurations: number[] = [];
    const deliveryDurations: number[] = [];

    for (const o of filteredOrders) {
      if (o.confirmedAt && o.readyAt) {
        const diff = (new Date(o.readyAt).getTime() - new Date(o.confirmedAt).getTime()) / 60000;
        if (diff >= 0) prepDurations.push(diff);
      }
      if (o.pickedUpAt && o.deliveredAt) {
        const diff = (new Date(o.deliveredAt).getTime() - new Date(o.pickedUpAt).getTime()) / 60000;
        if (diff >= 0) deliveryDurations.push(diff);
      }
    }

    const avgShopPrepMinutes =
      prepDurations.length > 0
        ? roundMoney(prepDurations.reduce((a, b) => a + b, 0) / prepDurations.length)
        : 0;
    const avgDeliveryMinutes =
      deliveryDurations.length > 0
        ? roundMoney(deliveryDurations.reduce((a, b) => a + b, 0) / deliveryDurations.length)
        : 0;

    const ordersPerCustomer = new Map<string, number>();
    for (const o of filteredOrders) {
      ordersPerCustomer.set(o.customerPhone, (ordersPerCustomer.get(o.customerPhone) ?? 0) + 1);
    }
    let newCustomersCount = 0;
    let returningCustomersCount = 0;
    for (const count of ordersPerCustomer.values()) {
      if (count > 1) returningCustomersCount += 1;
      else newCustomersCount += 1;
    }

    const productStats = new Map<
      string,
      { productId: string; productName: string; totalQuantity: number; totalRevenueEGP: number }
    >();
    let totalItemLines = 0;
    let totalUnavailableEvents = 0;

    for (const o of filteredOrders) {
      totalUnavailableEvents += o.unavailableItemCount;
      for (const item of o.items) {
        totalItemLines += 1;
        if (item.status === 'unavailable_removed' || o.status === 'cancelled') continue;
        const curr = productStats.get(item.productId) ?? {
          productId: item.productId,
          productName: item.productName,
          totalQuantity: 0,
          totalRevenueEGP: 0,
        };
        curr.totalQuantity = roundMoney(curr.totalQuantity + item.quantity);
        curr.totalRevenueEGP = roundMoney(curr.totalRevenueEGP + item.lineTotalEGP);
        productStats.set(item.productId, curr);
      }
    }

    const topProducts = Array.from(productStats.values())
      .sort((a, b) => b.totalQuantity - a.totalQuantity)
      .slice(0, 8);

    const shopBreakdown = db.shops.map((shop) => {
      const sOrders = filteredOrders.filter((o) => o.shopId === shop.id);
      const sCompleted = sOrders.filter((o) => o.status === 'completed');
      const sPreps = sOrders
        .filter((o) => o.confirmedAt && o.readyAt)
        .map((o) => (new Date(o.readyAt!).getTime() - new Date(o.confirmedAt!).getTime()) / 60000);
      const sRated = sCompleted.filter((o) => Boolean(o.rating));
      return {
        shopId: shop.id,
        shopName: shop.name,
        ordersCount: sOrders.length,
        completedCount: sCompleted.length,
        gmvEGP: roundMoney(sCompleted.reduce((acc, o) => acc + o.financials.itemsTotalEGP, 0)),
        avgPrepMinutes:
          sPreps.length > 0 ? roundMoney(sPreps.reduce((a, b) => a + b, 0) / sPreps.length) : 0,
        averageRating:
          sRated.length > 0
            ? roundMoney(
                sRated.reduce((acc, o) => acc + o.rating!.overallRating, 0) / sRated.length,
              )
            : null,
        ratingsCount: sRated.length,
      };
    });

    const mostActiveShop =
      [...shopBreakdown].sort((a, b) => b.ordersCount - a.ordersCount)[0] ?? null;

    const totalOrdersCount = filteredOrders.length;
    const completedCount = completedOrders.length;
    const ratedCompleted = completedOrders.filter((o) => Boolean(o.rating));
    const averageRating =
      ratedCompleted.length > 0
        ? roundMoney(
            ratedCompleted.reduce((acc, o) => acc + o.rating!.overallRating, 0) /
              ratedCompleted.length,
          )
        : null;

    return {
      totalShops: db.shops.length,
      totalVolunteers: db.volunteers.length,
      totalOrders: totalOrdersCount,
      activeOrders: activeOrders.length,
      completedOrders: completedCount,
      cancelledOrders: cancelledOrders.length,
      failedDeliveryOrders: failedDeliveryOrders.length,
      platformGMV,
      totalDeliveryFees,
      totalShopDues,
      totalVolunteerEarnings,
      totalOperatingCosts,
      netOperatingContribution,
      unsettledShopBalance,
      unsettledVolunteerBalance,
      receivableFromShopsEGP,
      receivableFromVolunteersEGP,
      totalCashDiscrepancy,
      avgOrderValueEGP: completedCount > 0 ? roundMoney(platformGMV / completedCount) : 0,
      avgShopPrepMinutes,
      avgDeliveryMinutes,
      cancellationRatePercent:
        totalOrdersCount > 0 ? roundMoney((cancelledOrders.length / totalOrdersCount) * 100) : 0,
      unavailableItemRatePercent:
        totalItemLines > 0 ? roundMoney((totalUnavailableEvents / totalItemLines) * 100) : 0,
      fulfillmentCostPerOrderEGP:
        completedCount > 0
          ? roundMoney((totalVolunteerEarnings + totalOperatingCosts) / completedCount)
          : 0,
      netContributionPerOrderEGP:
        completedCount > 0 ? roundMoney(netOperatingContribution / completedCount) : 0,
      newCustomersCount,
      returningCustomersCount,
      averageRating,
      ratingsCount: ratedCompleted.length,
      mostActiveShop: mostActiveShop && mostActiveShop.ordersCount > 0 ? mostActiveShop : null,
      topProducts,
      shopBreakdown,
    };
  }

  async getRuntimeConfig(): Promise<RuntimeConfig> {
    const db = await this.storage.read();
    return (
      db.runtimeConfig ?? {
        mode: 'experiment',
        pilotNotice:
          'إعدادات تجريبية استرشادية للمرحلة الأولى (عمولة 0%، دفع نقدي عند الاستلام فقط، رسوم توصيل منفصلة 20 ج.م).',
        updatedAt: new Date().toISOString(),
      }
    );
  }

  async setRuntimeMode(
    mode: OperationalMode,
    actorName: string,
  ): Promise<RuntimeConfig> {
    if (mode !== 'experiment' && mode !== 'live') {
      throw new DomainError('وضع التشغيل يجب أن يكون experiment أو live');
    }
    return this.storage.transact((db) => {
      const prevMode = db.runtimeConfig?.mode ?? 'experiment';
      const now = new Date().toISOString();
      db.runtimeConfig = {
        mode,
        pilotNotice:
          db.runtimeConfig?.pilotNotice ??
          'إعدادات تجريبية استرشادية للمرحلة الأولى (عمولة 0%، دفع نقدي عند الاستلام فقط، رسوم توصيل منفصلة 20 ج.م).',
        updatedAt: now,
        updatedBy: actorName,
      };
      appendAuditLog(db, {
        actorRole: 'super_admin',
        actorName,
        category: 'admin',
        action: 'switch_runtime_mode',
        summary: `تبديل وضع المنظومة من "${prevMode}" إلى "${mode}"`,
      });
      return db.runtimeConfig;
    });
  }

  async getAuditLogs(options?: {
    category?: AuditCategory | 'all';
    shopId?: string;
    limit?: number;
  }): Promise<AuditLogEntry[]> {
    const db = await this.storage.read();
    const limit = Math.min(200, Math.max(10, Number(options?.limit ?? 80)));
    return (db.auditLogs ?? [])
      .filter((entry) => {
        if (options?.category && options.category !== 'all' && entry.category !== options.category) {
          return false;
        }
        if (options?.shopId && options.shopId !== 'all' && entry.shopId !== options.shopId) {
          return false;
        }
        return true;
      })
      .slice(0, limit);
  }

  async getOperationalMemory(): Promise<OwnerOperationalMemory> {
    const db = await this.storage.read();
    const mode = db.runtimeConfig?.mode ?? 'experiment';
    const pilotNotice =
      db.runtimeConfig?.pilotNotice ??
      'إعدادات تجريبية استرشادية للمرحلة الأولى (عمولة 0%، دفع نقدي عند الاستلام فقط).';

    const newOrders = db.orders.filter((o) => o.status === 'new');
    const prepOrReady = db.orders.filter(
      (o) => o.status === 'confirmed' || o.status === 'preparing' || o.status === 'ready',
    );
    const pendingCustomerApprovals = db.orders.filter((o) => Boolean(o.pendingModification));
    const pendingShopRemittances = db.orders.filter(
      (o) =>
        o.status === 'completed' &&
        o.financials.remittance &&
        o.financials.remittance.mode !== 'full_to_platform_instapay' &&
        !o.financials.remittance.shopConfirmedAt,
    );
    const pendingPlatformRemittances = db.orders.filter(
      (o) =>
        o.status === 'completed' &&
        o.financials.remittance &&
        o.financials.remittance.status === 'pending_platform_confirmation',
    );
    const unsettledCompleted = db.orders.filter(
      (o) => o.status === 'completed' && o.financials.settlementStatus !== 'fully_settled',
    );
    const openShifts = db.shopShiftSessions.filter((s) => s.status === 'open');
    const lowStockItems = db.shopListings.filter(
      (l) => Math.max(0, l.currentStock - l.reservedStock) <= l.lowStockThreshold,
    );

    const lastLog = db.auditLogs?.[0];
    const lastCompletedAction = lastLog
      ? {
          summary: lastLog.summary,
          actorName: lastLog.actorName,
          timestamp: lastLog.timestamp,
          category: lastLog.category,
        }
      : null;

    let suggestedNextAction: OwnerOperationalMemory['suggestedNextAction'];
    if (pendingCustomerApprovals.length > 0) {
      suggestedNextAction = {
        title: `بانتظار رد العميل على تعديل/بديل (${pendingCustomerApprovals.length})`,
        description: `الطلب ${pendingCustomerApprovals[0].orderNumber} معلق لحين موافقة العميل أو تسجيل القرار هاتفيًا.`,
        targetRole: 'customer',
        urgent: true,
      };
    } else if (newOrders.length > 0) {
      suggestedNextAction = {
        title: `تأكيد الطلبات الجديدة (${newOrders.length})`,
        description: `الطلب ${newOrders[0].orderNumber} في ${newOrders[0].shopName} بانتظار موافقة المحل وبدء التجهيز.`,
        targetRole: 'shop',
        targetShopId: newOrders[0].shopId,
        urgent: true,
      };
    } else if (pendingShopRemittances.length > 0) {
      suggestedNextAction = {
        title: `تأكيد استلام المحل لتحصيل المندوب (${pendingShopRemittances.length})`,
        description: `الطلب ${pendingShopRemittances[0].orderNumber} سجل المندوب توريد المبلغ وبانتظار تأكيد الاستلام في ${pendingShopRemittances[0].shopName}.`,
        targetRole: 'shop',
        targetShopId: pendingShopRemittances[0].shopId,
        urgent: true,
      };
    } else if (prepOrReady.some((o) => o.status === 'ready' && o.deliveryStatus !== 'delivered')) {
      const readyOrd = prepOrReady.find((o) => o.status === 'ready' && o.deliveryStatus !== 'delivered')!;
      suggestedNextAction = {
        title: readyOrd.volunteerId ? 'متابعة توصيل طلب جاهز' : 'إسناد أو استلام طلب جاهز للتوصيل',
        description: `الطلب ${readyOrd.orderNumber} جاهز في ${readyOrd.shopName} للتسليم.`,
        targetRole: 'volunteer',
        urgent: false,
      };
    } else if (pendingPlatformRemittances.length > 0 || unsettledCompleted.length > 0) {
      suggestedNextAction = {
        title: `مراجعة وإغلاق التسويات المعلقة (${unsettledCompleted.length})`,
        description: 'راجع كشف الإدارة المركزية لتأكيد استلام حصة المنصة وإغلاق العهدة.',
        targetRole: 'admin',
        urgent: false,
      };
    } else {
      suggestedNextAction = {
        title: 'إنشاء طلب تجريبي أو فحص شاشة التاجر',
        description: 'لا توجد مهام معلقة حاليًا — يمكنك البدء بطلب جديد من المتجر أو فتح الكاشير.',
        targetRole: 'customer',
        urgent: false,
      };
    }

    return {
      mode,
      pilotNotice,
      lastCompletedAction,
      pendingBacklog: {
        newOrdersCount: newOrders.length,
        preparingOrReadyOrdersCount: prepOrReady.length,
        pendingCustomerApprovalsCount: pendingCustomerApprovals.length,
        pendingShopRemittanceConfirmationsCount: pendingShopRemittances.length,
        pendingPlatformRemittancesCount: pendingPlatformRemittances.length,
        unsettledCompletedOrdersCount: unsettledCompleted.length,
        openShiftsCount: openShifts.length,
        lowStockItemsCount: lowStockItems.length,
      },
      suggestedNextAction,
      lastBackupAt: db.lastBackupAt,
    };
  }

  async createBackupSnapshot(label: string, actorName: string): Promise<BackupSnapshotInfo> {
    const info = await this.storage.createBackupSnapshot(label);
    await this.storage.transact((db) => {
      appendAuditLog(db, {
        actorRole: 'super_admin',
        actorName,
        category: 'backup',
        action: 'create_backup_snapshot',
        targetId: info.filename,
        summary: `إنشاء نسخة احتياطية آمنة (${info.filename})`,
      });
    });
    return info;
  }

  async listBackupSnapshots(): Promise<BackupSnapshotInfo[]> {
    return this.storage.listBackupSnapshots();
  }

  async exportBackupPayload(actorName: string): Promise<CommerceDatabase> {
    const db = await this.storage.transact((draft) => {
      appendAuditLog(draft, {
        actorRole: 'super_admin',
        actorName,
        category: 'backup',
        action: 'export_backup',
        summary: 'تصدير نسخة احتياطية كاملة بصيغة JSON',
      });
      return structuredClone(draft);
    });
    return db;
  }

  async restoreBackupFromSnapshot(
    filename: string,
    actorName: string,
  ): Promise<{ restoredAt: string; ordersCount: number }> {
    const data = await this.storage.readBackupSnapshot(filename);
    const restored = await this.storage.restoreDatabase(data);
    await this.storage.transact((draft) => {
      appendAuditLog(draft, {
        actorRole: 'super_admin',
        actorName,
        category: 'backup',
        action: 'restore_backup_snapshot',
        targetId: filename,
        summary: `استعادة النظام من النسخة الاحتياطية ${filename} (بعد أخذ نسخة أمان مسبقة)`,
      });
    });
    return { restoredAt: new Date().toISOString(), ordersCount: restored.orders.length };
  }

  async restoreBackupFromPayload(
    payload: unknown,
    actorName: string,
  ): Promise<{ restoredAt: string; ordersCount: number }> {
    if (
      !payload ||
      typeof payload !== 'object' ||
      !Array.isArray((payload as CommerceDatabase).shops) ||
      !Array.isArray((payload as CommerceDatabase).masterProducts) ||
      !Array.isArray((payload as CommerceDatabase).shopListings) ||
      !Array.isArray((payload as CommerceDatabase).orders)
    ) {
      throw new DomainError('ملف النسخة الاحتياطية غير مكتمل أو بصيغة غير صالحة');
    }
    const restored = await this.storage.restoreDatabase(payload as CommerceDatabase);
    await this.storage.transact((draft) => {
      appendAuditLog(draft, {
        actorRole: 'super_admin',
        actorName,
        category: 'backup',
        action: 'restore_backup_json',
        summary: `استعادة النظام من ملف JSON خارجي (${restored.orders.length} طلب)`,
      });
    });
    return { restoredAt: new Date().toISOString(), ordersCount: restored.orders.length };
  }
}
