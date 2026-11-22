import crypto from 'node:crypto';
import type {
  AnalyticsReport,
  CashRemittanceMode,
  CatalogItemView,
  CommerceDatabase,
  DeliveryStatus,
  DistributionRules,
  InventoryMovement,
  MasterProduct,
  Order,
  OrderItem,
  OrderModificationRequest,
  OrderRemittanceRecord,
  OrderStatus,
  ProductCategory,
  PublicShopStaffView,
  RemittanceChannel,
  SettlementStatus,
  ShopDailyEntry,
  ShopDailyEntryType,
  ShopPosQrConfig,
  ShopShiftSession,
  ShopStaffAccount,
  ShopStaffPermissions,
  ShopStaffRole,
  ShopStatement,
  UserRole,
  VerificationStepResult,
  VolunteerStatement,
} from '../types/commerce.ts';
import { InMemoryStorageAdapter, type CommerceStorageAdapter } from './storage.ts';

export class DomainError extends Error {
  public readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'DomainError';
    this.statusCode = statusCode;
  }
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

function hashStaffPasscode(passcode: string, saltHex?: string): { hashHex: string; saltHex: string } {
  const salt = saltHex || crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(passcode, salt, 64).toString('hex');
  return { hashHex: derived, saltHex: salt };
}

function verifyStaffPasscode(passcode: string, expectedHashHex: string, saltHex: string): boolean {
  if (!expectedHashHex || !saltHex) return false;
  const { hashHex } = hashStaffPasscode(passcode, saltHex);
  const a = Buffer.from(hashHex, 'hex');
  const b = Buffer.from(expectedHashHex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sanitizeStaffView(s: ShopStaffAccount): PublicShopStaffView {
  return {
    id: s.id,
    shopId: s.shopId,
    name: s.name,
    shiftLabel: s.shiftLabel,
    deviceLabel: s.deviceLabel,
    roleTier: s.roleTier,
    permissions: s.permissions,
    hasPasscode: Boolean(s.passcodeHash && s.passcodeSalt),
    isActive: s.isActive,
    tokenVersion: s.tokenVersion,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

function calculateFinancialSplit(
  itemsTotalEGP: number,
  deliveryFeeEGP: number,
  rules: DistributionRules,
): {
  shopDueEGP: number;
  volunteerShareEGP: number;
  operatingCostEGP: number;
  platformRevenueEGP: number;
} {
  const commission = roundMoney((itemsTotalEGP * rules.platformCommissionPercent) / 100);
  const shopDueEGP = roundMoney(itemsTotalEGP - commission);
  const volunteerShareEGP =
    rules.volunteerShareMode === 'percentage'
      ? roundMoney((deliveryFeeEGP * rules.volunteerShareValue) / 100)
      : roundMoney(Math.min(deliveryFeeEGP, rules.volunteerShareValue));
  const operatingCostEGP = roundMoney(rules.operatingCostPerOrderEGP);
  const platformRevenueEGP = roundMoney(
    deliveryFeeEGP + commission - volunteerShareEGP - operatingCostEGP,
  );

  return {
    shopDueEGP,
    volunteerShareEGP,
    operatingCostEGP,
    platformRevenueEGP,
  };
}

function computeSettlementStatus(order: Order): SettlementStatus {
  const f = order.financials;
  if (!f.collectedAt) {
    return 'uncollected';
  }
  const rem = f.remittance;
  const hasPendingPlatformCollection = Boolean(
    rem &&
      !rem.platformConfirmedAt &&
      (rem.amountPlatformAtShopEGP > 0 ||
        rem.amountWithCourierForPlatformEGP > 0 ||
        rem.amountDirectToPlatformEGP > 0),
  );
  const shopSettled = Boolean(f.shopSettledAt);
  const volSettled = Boolean(f.volunteerSettledAt);
  if (shopSettled && volSettled && !hasPendingPlatformCollection) {
    return 'fully_settled';
  }
  if (shopSettled) {
    return 'shop_settled';
  }
  if (volSettled) {
    return 'volunteer_settled';
  }
  return 'shop_unsettled';
}

function buildOrderRemittanceRecord(
  order: Order,
  input: {
    mode: CashRemittanceMode;
    shopTransferChannel?: RemittanceChannel;
    platformTransferChannel?: RemittanceChannel;
    instapayReference?: string;
    note?: string;
  },
  submittedBy: string,
  now: string,
): OrderRemittanceRecord {
  const collected = roundMoney(order.financials.collectedAmountEGP);
  const shopDue = roundMoney(order.financials.shopDueEGP);
  const validModes: CashRemittanceMode[] = [
    'full_to_shop',
    'split_shop_and_courier',
    'full_to_platform_instapay',
  ];
  if (!validModes.includes(input.mode)) {
    throw new DomainError('طريقة توريد التحصيل غير صالحة');
  }

  const shopChannel: RemittanceChannel =
    input.shopTransferChannel === 'instapay' ? 'instapay' : 'cash';
  const ref = input.instapayReference?.trim() || undefined;
  const note = input.note?.trim() || undefined;

  if (input.mode === 'full_to_shop') {
    const excessAtShop = roundMoney(Math.max(0, collected - shopDue));
    return {
      mode: 'full_to_shop',
      shopTransferChannel: shopChannel,
      amountToShopEGP: collected,
      amountWithCourierForPlatformEGP: 0,
      amountDirectToPlatformEGP: 0,
      amountPlatformAtShopEGP: excessAtShop,
      instapayReference: ref,
      note,
      status: 'pending_shop_confirmation',
      submittedBy,
      submittedAt: now,
    };
  }

  if (input.mode === 'split_shop_and_courier') {
    const toShop = roundMoney(Math.min(collected, shopDue));
    const withCourier = roundMoney(Math.max(0, collected - shopDue));
    return {
      mode: 'split_shop_and_courier',
      shopTransferChannel: shopChannel,
      platformTransferChannel:
        input.platformTransferChannel === 'cash' ? 'cash' : 'instapay',
      amountToShopEGP: toShop,
      amountWithCourierForPlatformEGP: withCourier,
      amountDirectToPlatformEGP: 0,
      amountPlatformAtShopEGP: 0,
      instapayReference: ref,
      note,
      status: 'pending_shop_confirmation',
      submittedBy,
      submittedAt: now,
    };
  }

  return {
    mode: 'full_to_platform_instapay',
    platformTransferChannel: 'instapay',
    amountToShopEGP: 0,
    amountWithCourierForPlatformEGP: 0,
    amountDirectToPlatformEGP: collected,
    amountPlatformAtShopEGP: 0,
    instapayReference: ref,
    note,
    status: 'pending_platform_confirmation',
    submittedBy,
    submittedAt: now,
  };
}

function computeOrderCashHoldings(order: Order): {
  platformAtShopEGP: number;
  courierCashCustodyEGP: number;
  remittedToShopEGP: number;
  remittedDirectInstapayEGP: number;
} {
  const f = order.financials;
  const rem = f.remittance;
  if (!rem) {
    return {
      platformAtShopEGP: 0,
      courierCashCustodyEGP: roundMoney(
        Math.max(0, f.collectedAmountEGP - (f.volunteerSettledAt ? f.volunteerShareEGP : 0)),
      ),
      remittedToShopEGP: 0,
      remittedDirectInstapayEGP: 0,
    };
  }

  if (rem.mode === 'full_to_shop') {
    const shopConfirmed = Boolean(rem.shopConfirmedAt);
    const platformConfirmed = Boolean(rem.platformConfirmedAt);
    return {
      platformAtShopEGP: shopConfirmed && !platformConfirmed ? rem.amountPlatformAtShopEGP : 0,
      courierCashCustodyEGP: shopConfirmed ? 0 : f.collectedAmountEGP,
      remittedToShopEGP: shopConfirmed ? rem.amountToShopEGP : 0,
      remittedDirectInstapayEGP: 0,
    };
  }

  if (rem.mode === 'split_shop_and_courier') {
    const shopConfirmed = Boolean(rem.shopConfirmedAt);
    const platformConfirmed = Boolean(rem.platformConfirmedAt);
    return {
      platformAtShopEGP: 0,
      courierCashCustodyEGP: platformConfirmed
        ? 0
        : shopConfirmed
          ? rem.amountWithCourierForPlatformEGP
          : f.collectedAmountEGP,
      remittedToShopEGP: shopConfirmed ? rem.amountToShopEGP : 0,
      remittedDirectInstapayEGP: 0,
    };
  }

  // full_to_platform_instapay
  const platformConfirmed = Boolean(rem.platformConfirmedAt);
  return {
    platformAtShopEGP: 0,
    courierCashCustodyEGP: platformConfirmed ? 0 : rem.amountDirectToPlatformEGP,
    remittedToShopEGP: 0,
    remittedDirectInstapayEGP: platformConfirmed ? rem.amountDirectToPlatformEGP : 0,
  };
}

export class CommerceService {
  private readonly storage: CommerceStorageAdapter;

  constructor(storage: CommerceStorageAdapter) {
    this.storage = storage;
  }

  async getDatabaseSnapshot(): Promise<CommerceDatabase> {
    return this.storage.read();
  }

  async resetDemoData(): Promise<CommerceDatabase> {
    return this.storage.resetDemoData();
  }

  async getShops() {
    const db = await this.storage.read();
    return db.shops;
  }

  async getDemoCustomers() {
    const db = await this.storage.read();
    return db.customers;
  }

  async getVolunteers() {
    const db = await this.storage.read();
    return db.volunteers;
  }

  async getShopCatalog(shopId: string, includeUnavailable = false): Promise<CatalogItemView[]> {
    const db = await this.storage.read();
    const shop = db.shops.find((s) => s.id === shopId);
    if (!shop) {
      throw new DomainError('المحل المطلوب غير موجود', 404);
    }
    const productById = new Map(db.masterProducts.map((p) => [p.id, p]));
    const result: CatalogItemView[] = [];

    for (const listing of db.shopListings) {
      if (listing.shopId !== shopId) continue;
      const product = productById.get(listing.productId);
      if (!product) continue;
      const availableToSell = Math.max(0, listing.currentStock - listing.reservedStock);
      if (!includeUnavailable && (!listing.isAvailable || availableToSell <= 0)) {
        // Still include unavailable items in storefront if they belong to shop so customer sees "غير متوفر" or filter?
        // Wait: returning all items with clear availableToSell & isAvailable lets UI show out-of-stock cleanly!
      }
      result.push({
        listingId: listing.id,
        shopId: listing.shopId,
        productId: product.id,
        sku: product.sku,
        barcode: product.barcode,
        isWeighted: product.isWeighted,
        scalePlu: product.scalePlu,
        name: product.name,
        brand: product.brand,
        category: product.category,
        packSize: product.packSize,
        unit: product.unit,
        description: product.description,
        priceEGP: listing.priceEGP,
        priceUpdatedAt: listing.priceUpdatedAt,
        priceSourceNote: listing.priceSourceNote,
        isAvailable: listing.isAvailable,
        currentStock: listing.currentStock,
        reservedStock: listing.reservedStock,
        availableToSell,
        lowStockThreshold: listing.lowStockThreshold,
        isLowStock: availableToSell <= listing.lowStockThreshold,
      });
    }
    return result;
  }

  async createCustomerOrder(input: {
    shopId: string;
    customerName: string;
    customerPhone: string;
    deliveryAddress: string;
    deliveryLocation?: { lat: number; lng: number };
    deliveryNotes?: string;
    items: Array<{ productId: string; quantity: number }>;
  }): Promise<Order> {
    const name = input.customerName?.trim();
    const phone = input.customerPhone?.trim();
    const address = input.deliveryAddress?.trim();
    if (!name || name.length < 2) {
      throw new DomainError('يرجى إدخال اسم العميل بشكل صحيح');
    }
    if (!phone || phone.length < 8) {
      throw new DomainError('يرجى إدخال رقم هاتف صحيح');
    }
    if (!address || address.length < 5) {
      throw new DomainError('يرجى إدخال عنوان التوصيل بالتفصيل');
    }
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new DomainError('السلة فارغة، يرجى إضافة منتج واحد على الأقل');
    }

    const db = await this.storage.read();
    const shop = db.shops.find((s) => s.id === input.shopId);
    if (!shop) {
      throw new DomainError('المحل المختار غير موجود', 404);
    }

    const now = new Date().toISOString();
    const orderNumber = `ORD-${db.nextOrderSeq}`;
    db.nextOrderSeq += 1;

    // Register or locate customer by phone for New vs Returning analytics
    let customer = db.customers.find((c) => c.phone === phone);
    if (!customer) {
      customer = {
        id: makeId('cust'),
        name,
        phone,
        address,
        area: shop.area,
        createdAt: now,
      };
      db.customers.push(customer);
    }

    const productById = new Map(db.masterProducts.map((p) => [p.id, p]));
    const orderItems: OrderItem[] = [];
    const movementsToAppend: InventoryMovement[] = [];
    let itemsTotalEGP = 0;

    // Deduplicate requested productIds
    const mergedMap = new Map<string, number>();
    for (const rawItem of input.items) {
      const qty = Math.floor(Number(rawItem.quantity));
      if (!Number.isFinite(qty) || qty <= 0) {
        throw new DomainError('الكمية المطلوبة يجب أن تكون رقمًا صحيحًا موجبًا');
      }
      mergedMap.set(rawItem.productId, (mergedMap.get(rawItem.productId) ?? 0) + qty);
    }

    for (const [productId, quantity] of mergedMap.entries()) {
      const listing = db.shopListings.find(
        (l) => l.shopId === shop.id && l.productId === productId,
      );
      const product = productById.get(productId);
      if (!listing || !product) {
        throw new DomainError('أحد المنتجات المختارة غير مدرج في هذا المحل');
      }
      if (!listing.isAvailable) {
        throw new DomainError(`المنتج "${product.name}" غير متوفر حاليًا في ${shop.name}`);
      }
      const availableToSell = listing.currentStock - listing.reservedStock;
      if (availableToSell < quantity) {
        throw new DomainError(
          `الكمية المتاحة من "${product.name}" هي ${availableToSell} ${product.unit} فقط`,
        );
      }

      // Reserve inventory on order placement so no two orders can oversell
      listing.reservedStock += quantity;
      const lineTotalEGP = roundMoney(listing.priceEGP * quantity);
      itemsTotalEGP = roundMoney(itemsTotalEGP + lineTotalEGP);

      orderItems.push({
        id: makeId('oi'),
        productId: product.id,
        productName: product.name,
        brand: product.brand,
        packSize: product.packSize,
        unit: product.unit,
        quantity,
        unitPriceEGP: listing.priceEGP,
        lineTotalEGP,
        status: 'active',
      });

      movementsToAppend.push({
        id: makeId('mov'),
        shopId: shop.id,
        productId: product.id,
        productName: product.name,
        type: 'reserve',
        quantityDelta: 0,
        reservedDelta: quantity,
        stockAfter: listing.currentStock,
        reservedAfter: listing.reservedStock,
        orderNumber,
        actorRole: 'customer',
        actorName: name,
        reason: `حجز كمية للطلب الجديد ${orderNumber}`,
        createdAt: now,
      });
    }

    const deliveryFeeEGP = shop.defaultDeliveryFeeEGP || db.distributionRules.defaultDeliveryFeeEGP;
    const customerExpectedTotalEGP = roundMoney(itemsTotalEGP + deliveryFeeEGP);
    const split = calculateFinancialSplit(itemsTotalEGP, deliveryFeeEGP, db.distributionRules);

    const order: Order = {
      id: makeId('ord'),
      orderNumber,
      shopId: shop.id,
      shopName: shop.name,
      customerId: customer.id,
      customerName: name,
      customerPhone: phone,
      deliveryAddress: address,
      deliveryLocation:
        input.deliveryLocation &&
        Number.isFinite(Number(input.deliveryLocation.lat)) &&
        Number.isFinite(Number(input.deliveryLocation.lng))
          ? {
              lat: Number(input.deliveryLocation.lat),
              lng: Number(input.deliveryLocation.lng),
            }
          : undefined,
      deliveryNotes: (input.deliveryNotes ?? '').trim(),
      paymentMethod: 'cash_on_delivery',
      status: 'new',
      deliveryStatus: 'unassigned',
      items: orderItems,
      modificationHistory: [],
      financials: {
        itemsTotalEGP,
        deliveryFeeEGP,
        customerExpectedTotalEGP,
        collectedAmountEGP: 0,
        collectionDiscrepancyEGP: 0,
        shopDueEGP: split.shopDueEGP,
        volunteerShareEGP: split.volunteerShareEGP,
        operatingCostEGP: split.operatingCostEGP,
        platformRevenueEGP: split.platformRevenueEGP,
        settlementStatus: 'uncollected',
      },
      timeline: [
        {
          id: makeId('tl'),
          timestamp: now,
          actorRole: 'customer',
          actorName: name,
          eventType: 'order_created',
          title: 'إنشاء طلب جديد (الدفع نقدي عند الاستلام)',
          details: `قيمة المنتجات ${itemsTotalEGP} ج.م + توصيل ${deliveryFeeEGP} ج.م = ${customerExpectedTotalEGP} ج.م، وتم حجز المخزون.`,
        },
      ],
      stockState: 'reserved',
      unavailableItemCount: 0,
      createdAt: now,
    };

    db.orders.unshift(order);
    db.inventoryMovements.unshift(...movementsToAppend);
    await this.storage.write(db);
    return order;
  }

  async getOrderByNumber(orderNumber: string): Promise<Order> {
    const db = await this.storage.read();
    const order = db.orders.find(
      (o) => o.orderNumber.toLowerCase() === orderNumber.trim().toLowerCase(),
    );
    if (!order) {
      throw new DomainError('لم يتم العثور على طلب بهذا الرقم', 404);
    }
    return order;
  }

  async getOrdersForShop(shopId: string): Promise<Order[]> {
    const db = await this.storage.read();
    return db.orders.filter((o) => o.shopId === shopId);
  }

  async shopUpdateOrderStatus(input: {
    shopId: string;
    orderNumber: string;
    nextStatus: OrderStatus;
    reason?: string;
    actorName: string;
    actorRole: UserRole;
  }): Promise<Order> {
    const db = await this.storage.read();
    const order = db.orders.find((o) => o.orderNumber === input.orderNumber);
    if (!order) {
      throw new DomainError('الطلب غير موجود', 404);
    }
    if (order.shopId !== input.shopId) {
      throw new DomainError('لا تملك صلاحية تعديل طلب خاص بمحل آخر', 403);
    }

    const now = new Date().toISOString();

    if (input.nextStatus === 'cancelled') {
      if (order.status === 'completed' || order.status === 'cancelled') {
        throw new DomainError('لا يمكن إلغاء طلب مكتمل أو ملغى بالفعل');
      }
      const reason = (input.reason ?? '').trim();
      if (!reason) {
        throw new DomainError('يجب إدخال سبب إلغاء أو رفض الطلب');
      }
      this.releaseOrReturnOrderStock(db, order, input.actorRole, input.actorName, `إلغاء الطلب: ${reason}`);
      order.status = 'cancelled';
      order.cancellationReason = reason;
      order.cancelledAt = now;
      order.financials.shopDueEGP = 0;
      order.financials.volunteerShareEGP = 0;
      order.financials.operatingCostEGP = 0;
      order.financials.platformRevenueEGP = 0;
      order.timeline.push({
        id: makeId('tl'),
        timestamp: now,
        actorRole: input.actorRole,
        actorName: input.actorName,
        eventType: 'order_cancelled',
        title: 'تم إلغاء الطلب وإرجاع الكميات للمخزون',
        details: reason,
      });
      await this.storage.write(db);
      return order;
    }

    if (order.pendingModification) {
      throw new DomainError(
        'يوجد تعديل/بديل معلق بانتظار موافقة العميل، يجب تسجيل قرار العميل أولًا قبل متابعة التجهيز',
      );
    }

    const allowedTransitions: Record<OrderStatus, OrderStatus[]> = {
      new: ['confirmed'],
      confirmed: ['preparing'],
      preparing: ['ready'],
      ready: [],
      completed: [],
      cancelled: [],
    };

    if (!allowedTransitions[order.status].includes(input.nextStatus)) {
      throw new DomainError(
        `انتقال الحالة غير مسموح من "${order.status}" إلى "${input.nextStatus}"`,
      );
    }

    if (input.nextStatus === 'confirmed') {
      if (order.items.filter((i) => i.status !== 'unavailable_removed').length === 0) {
        throw new DomainError('لا يمكن تأكيد طلب بدون منتجات فعّالة');
      }
      order.status = 'confirmed';
      order.confirmedAt = now;
      order.timeline.push({
        id: makeId('tl'),
        timestamp: now,
        actorRole: input.actorRole,
        actorName: input.actorName,
        eventType: 'order_confirmed',
        title: 'تم تأكيد الطلب من المحل',
        details: 'المنتجات محجوزة وجاهزة لبدء التجهيز',
      });
    } else if (input.nextStatus === 'preparing') {
      order.status = 'preparing';
      order.preparingAt = now;
      order.timeline.push({
        id: makeId('tl'),
        timestamp: now,
        actorRole: input.actorRole,
        actorName: input.actorName,
        eventType: 'order_preparing',
        title: 'بدء تجهيز وتعبئة الطلب داخل المحل',
      });
    } else if (input.nextStatus === 'ready') {
      // Actual stock deduction happens when shop completes preparation (ready for pickup)
      if (order.stockState === 'reserved') {
        for (const item of order.items) {
          if (item.status === 'unavailable_removed') continue;
          const listing = db.shopListings.find(
            (l) => l.shopId === order.shopId && l.productId === item.productId,
          );
          if (!listing) continue;
          if (listing.currentStock < item.quantity) {
            throw new DomainError(
              `الرصيد الفعلي للمنتج "${item.productName}" غير كافٍ للخصم عند الجاهزية`,
            );
          }
          listing.currentStock -= item.quantity;
          listing.reservedStock = Math.max(0, listing.reservedStock - item.quantity);
          if (listing.currentStock === 0) {
            listing.isAvailable = false;
          }
          db.inventoryMovements.unshift({
            id: makeId('mov'),
            shopId: order.shopId,
            productId: item.productId,
            productName: item.productName,
            type: 'deduct_on_fulfill',
            quantityDelta: -item.quantity,
            reservedDelta: -item.quantity,
            stockAfter: listing.currentStock,
            reservedAfter: listing.reservedStock,
            orderNumber: order.orderNumber,
            actorRole: input.actorRole,
            actorName: input.actorName,
            reason: `خصم فعلي من المخزون عند جاهزية الطلب ${order.orderNumber}`,
            createdAt: now,
          });
        }
        order.stockState = 'deducted';
      }
      order.status = 'ready';
      order.readyAt = now;
      order.timeline.push({
        id: makeId('tl'),
        timestamp: now,
        actorRole: input.actorRole,
        actorName: input.actorName,
        eventType: 'order_ready',
        title: 'الطلب جاهز للاستلام وتم خصم المخزون الفعلي',
      });
    }

    await this.storage.write(db);
    return order;
  }

  async customerCancelOrder(input: {
    orderNumber: string;
    reason: string;
  }): Promise<Order> {
    const db = await this.storage.read();
    const order = db.orders.find((o) => o.orderNumber === input.orderNumber);
    if (!order) {
      throw new DomainError('الطلب غير موجود', 404);
    }
    if (order.status === 'completed' || order.status === 'cancelled') {
      throw new DomainError('لا يمكن إلغاء طلب مكتمل أو ملغى بالفعل');
    }
    if (
      order.deliveryStatus === 'picked_up' ||
      order.deliveryStatus === 'heading_to_customer' ||
      order.deliveryStatus === 'delivered'
    ) {
      throw new DomainError('لا يمكن إلغاء الطلب بعد استلامه من المتطوع');
    }
    const reason = (input.reason ?? '').trim() || 'إلغاء بناءً على رغبة العميل';
    const now = new Date().toISOString();
    this.releaseOrReturnOrderStock(db, order, 'customer', order.customerName, `إلغاء العميل: ${reason}`);
    order.status = 'cancelled';
    order.cancellationReason = reason;
    order.cancelledAt = now;
    order.financials.shopDueEGP = 0;
    order.financials.volunteerShareEGP = 0;
    order.financials.operatingCostEGP = 0;
    order.financials.platformRevenueEGP = 0;
    order.timeline.push({
      id: makeId('tl'),
      timestamp: now,
      actorRole: 'customer',
      actorName: order.customerName,
      eventType: 'customer_cancelled',
      title: 'ألغى العميل الطلب وتم فك حجز/إرجاع المخزون',
      details: reason,
    });
    await this.storage.write(db);
    return order;
  }

  async submitOrderRating(input: {
    orderNumber: string;
    overallRating: number;
    shopRating?: number;
    deliveryRating?: number;
    complimentTags?: string[];
    comment?: string;
  }): Promise<Order> {
    const db = await this.storage.read();
    const order = db.orders.find((o) => o.orderNumber === input.orderNumber?.trim());
    if (!order) {
      throw new DomainError('الطلب غير موجود', 404);
    }
    if (order.status !== 'completed' || order.deliveryStatus !== 'delivered') {
      throw new DomainError('يمكن تقييم الطلب بعد استلامه بالكامل فقط، شكرًا لتفهمك');
    }
    if (order.rating) {
      throw new DomainError('تم تسجيل تقييمك اللطيف لهذا الطلب مسبقًا، شكرًا لذوقك!', 409);
    }

    const overall = Number(input.overallRating);
    if (!Number.isInteger(overall) || overall < 1 || overall > 5) {
      throw new DomainError('يرجى اختيار تقييم من 1 إلى 5 نجوم');
    }

    const parseOptionalStars = (val: unknown, label: string): number | undefined => {
      if (val === undefined || val === null || val === '') return undefined;
      const n = Number(val);
      if (!Number.isInteger(n) || n < 1 || n > 5) {
        throw new DomainError(`تقييم ${label} يجب أن يكون من 1 إلى 5 نجوم`);
      }
      return n;
    };

    const shopRating = parseOptionalStars(input.shopRating, 'المحل');
    const deliveryRating = parseOptionalStars(input.deliveryRating, 'المتطوع');

    const complimentTags = Array.isArray(input.complimentTags)
      ? Array.from(
          new Set(
            input.complimentTags
              .map((t) => String(t ?? '').trim())
              .filter((t) => t.length > 0 && t.length <= 45),
          ),
        ).slice(0, 6)
      : [];

    const comment = input.comment ? String(input.comment).trim().slice(0, 400) : undefined;
    const now = new Date().toISOString();

    order.rating = {
      overallRating: overall,
      shopRating,
      deliveryRating,
      complimentTags,
      comment: comment || undefined,
      customerName: order.customerName,
      submittedAt: now,
    };

    const detailParts = [`التقييم العام: ${overall}/5`];
    if (shopRating) detailParts.push(`المحل: ${shopRating}/5`);
    if (deliveryRating) detailParts.push(`التوصيل: ${deliveryRating}/5`);
    if (complimentTags.length > 0) detailParts.push(complimentTags.join('، '));
    if (comment) detailParts.push(`"${comment}"`);

    order.timeline.push({
      id: makeId('tl'),
      timestamp: now,
      actorRole: 'customer',
      actorName: order.customerName,
      eventType: 'customer_rated',
      title: `أرسل العميل تقييمًا لطيفًا للطلب (${overall}/5 ★)`,
      details: detailParts.join(' · '),
    });

    await this.storage.write(db);
    return order;
  }

  async proposeOrderModification(input: {
    shopId: string;
    orderNumber: string;
    type: OrderModificationRequest['type'];
    targetItemId: string;
    proposedProductId?: string;
    proposedQuantity?: number;
    proposedUnitPriceEGP?: number;
    reason: string;
    actorName: string;
  }): Promise<Order> {
    const db = await this.storage.read();
    const order = db.orders.find((o) => o.orderNumber === input.orderNumber);
    if (!order) {
      throw new DomainError('الطلب غير موجود', 404);
    }
    if (order.shopId !== input.shopId) {
      throw new DomainError('لا تملك صلاحية تعديل هذا الطلب', 403);
    }
    if (order.status === 'completed' || order.status === 'cancelled' || order.status === 'ready') {
      throw new DomainError('لا يمكن اقتراح تعديل على طلب جاهز أو مكتمل أو ملغى');
    }
    if (order.pendingModification) {
      throw new DomainError('يوجد طلب تعديل معلق بالفعل لهذا الطلب');
    }
    const reason = (input.reason ?? '').trim();
    if (!reason) {
      throw new DomainError('يجب ذكر سبب التعديل للتواصل مع العميل');
    }
    const item = order.items.find((i) => i.id === input.targetItemId && i.status === 'active');
    if (!item) {
      throw new DomainError('العنصر المطلوب تعديله غير موجود أو تم تعديله مسبقًا');
    }

    let proposedProductName: string | undefined;
    let proposedPackSize: string | undefined;
    let proposedUnit: string | undefined;
    let proposedUnitPriceEGP = input.proposedUnitPriceEGP;

    if (input.type === 'substitute_item') {
      if (!input.proposedProductId) {
        throw new DomainError('يجب اختيار المنتج البديل');
      }
      const subListing = db.shopListings.find(
        (l) => l.shopId === order.shopId && l.productId === input.proposedProductId,
      );
      const subProduct = db.masterProducts.find((p) => p.id === input.proposedProductId);
      if (!subListing || !subProduct || !subListing.isAvailable) {
        throw new DomainError('المنتج البديل غير متوفر في المحل');
      }
      const qtyNeeded = input.proposedQuantity ?? item.quantity;
      if (subListing.currentStock - subListing.reservedStock < qtyNeeded) {
        throw new DomainError('الكمية المتاحة من المنتج البديل لا تكفي');
      }
      proposedProductName = subProduct.name;
      proposedPackSize = subProduct.packSize;
      proposedUnit = subProduct.unit;
      proposedUnitPriceEGP = subListing.priceEGP;
    } else if (input.type === 'adjust_quantity') {
      const qty = Math.floor(Number(input.proposedQuantity));
      if (!Number.isFinite(qty) || qty <= 0) {
        throw new DomainError('الكمية المقترحة يجب أن تكون أكبر من صفر');
      }
      if (qty > item.quantity) {
        const listing = db.shopListings.find(
          (l) => l.shopId === order.shopId && l.productId === item.productId,
        );
        if (!listing || listing.currentStock - listing.reservedStock < qty - item.quantity) {
          throw new DomainError('المخزون المتاح لا يكفي لزيادة الكمية');
        }
      }
    } else if (input.type === 'price_adjustment') {
      const price = Number(input.proposedUnitPriceEGP);
      if (!Number.isFinite(price) || price <= 0) {
        throw new DomainError('السعر المقترح يجب أن يكون أكبر من صفر');
      }
      proposedUnitPriceEGP = roundMoney(price);
    }

    const now = new Date().toISOString();
    const request: OrderModificationRequest = {
      id: makeId('mod'),
      type: input.type,
      targetItemId: item.id,
      targetProductName: item.productName,
      proposedProductId: input.proposedProductId,
      proposedProductName,
      proposedPackSize,
      proposedUnit,
      proposedQuantity: input.proposedQuantity ?? item.quantity,
      proposedUnitPriceEGP,
      reason,
      status: 'pending_customer',
      requestedBy: input.actorName,
      requestedAt: now,
    };

    if (input.type === 'substitute_item' || input.type === 'remove_unavailable') {
      order.unavailableItemCount += 1;
    }

    order.pendingModification = request;
    order.timeline.push({
      id: makeId('tl'),
      timestamp: now,
      actorRole: 'shop_owner',
      actorName: input.actorName,
      eventType: 'modification_proposed',
      title: 'إرسال مقترح تعديل للعميل بانتظار الموافقة',
      details: `${item.productName}: ${reason}`,
    });

    await this.storage.write(db);
    return order;
  }

  async resolveOrderModification(input: {
    orderNumber: string;
    decision: 'approved' | 'rejected';
    resolutionChannel: 'customer_app' | 'phone_recorded_by_shop';
    resolutionNote?: string;
    actorRole: UserRole;
    actorName: string;
  }): Promise<Order> {
    const db = await this.storage.read();
    const order = db.orders.find((o) => o.orderNumber === input.orderNumber);
    if (!order || !order.pendingModification) {
      throw new DomainError('لا يوجد مقترح تعديل معلق لهذا الطلب', 404);
    }
    const mod = order.pendingModification;
    const item = order.items.find((i) => i.id === mod.targetItemId);
    if (!item) {
      throw new DomainError('العنصر المستهدف غير موجود', 404);
    }

    const now = new Date().toISOString();
    mod.status = input.decision;
    mod.resolvedAt = now;
    mod.resolutionChannel = input.resolutionChannel;
    mod.resolutionNote = input.resolutionNote?.trim();

    if (input.decision === 'approved') {
      const oldListing = db.shopListings.find(
        (l) => l.shopId === order.shopId && l.productId === item.productId,
      );

      if (mod.type === 'remove_unavailable') {
        if (oldListing && order.stockState === 'reserved') {
          oldListing.reservedStock = Math.max(0, oldListing.reservedStock - item.quantity);
          db.inventoryMovements.unshift({
            id: makeId('mov'),
            shopId: order.shopId,
            productId: item.productId,
            productName: item.productName,
            type: 'release_reservation',
            quantityDelta: 0,
            reservedDelta: -item.quantity,
            stockAfter: oldListing.currentStock,
            reservedAfter: oldListing.reservedStock,
            orderNumber: order.orderNumber,
            actorRole: input.actorRole,
            actorName: input.actorName,
            reason: `فك حجز منتج غير متوفر بعد موافقة العميل (${order.orderNumber})`,
            createdAt: now,
          });
        }
        item.status = 'unavailable_removed';
        item.lineTotalEGP = 0;
      } else if (mod.type === 'substitute_item' && mod.proposedProductId) {
        const newListing = db.shopListings.find(
          (l) => l.shopId === order.shopId && l.productId === mod.proposedProductId,
        );
        if (!newListing) {
          throw new DomainError('المنتج البديل لم يعد متاحًا');
        }
        const newQty = mod.proposedQuantity ?? item.quantity;
        if (newListing.currentStock - newListing.reservedStock < newQty) {
          throw new DomainError('الكمية المتاحة من المنتج البديل لم تعد كافية');
        }
        if (oldListing && order.stockState === 'reserved') {
          oldListing.reservedStock = Math.max(0, oldListing.reservedStock - item.quantity);
          db.inventoryMovements.unshift({
            id: makeId('mov'),
            shopId: order.shopId,
            productId: item.productId,
            productName: item.productName,
            type: 'release_reservation',
            quantityDelta: 0,
            reservedDelta: -item.quantity,
            stockAfter: oldListing.currentStock,
            reservedAfter: oldListing.reservedStock,
            orderNumber: order.orderNumber,
            actorRole: input.actorRole,
            actorName: input.actorName,
            reason: `فك حجز المنتج الأصلي بعد قبول البديل (${order.orderNumber})`,
            createdAt: now,
          });
        }
        if (order.stockState === 'reserved') {
          newListing.reservedStock += newQty;
          db.inventoryMovements.unshift({
            id: makeId('mov'),
            shopId: order.shopId,
            productId: mod.proposedProductId,
            productName: mod.proposedProductName ?? item.productName,
            type: 'reserve',
            quantityDelta: 0,
            reservedDelta: newQty,
            stockAfter: newListing.currentStock,
            reservedAfter: newListing.reservedStock,
            orderNumber: order.orderNumber,
            actorRole: input.actorRole,
            actorName: input.actorName,
            reason: `حجز المنتج البديل بعد موافقة العميل (${order.orderNumber})`,
            createdAt: now,
          });
        }
        item.originalProductId = item.productId;
        item.originalProductName = item.productName;
        item.productId = mod.proposedProductId;
        item.productName = mod.proposedProductName ?? item.productName;
        item.packSize = mod.proposedPackSize ?? item.packSize;
        item.unit = mod.proposedUnit ?? item.unit;
        item.quantity = newQty;
        item.unitPriceEGP = mod.proposedUnitPriceEGP ?? newListing.priceEGP;
        item.lineTotalEGP = roundMoney(item.quantity * item.unitPriceEGP);
        item.status = 'substituted';
      } else if (mod.type === 'adjust_quantity' && mod.proposedQuantity) {
        const delta = mod.proposedQuantity - item.quantity;
        if (oldListing && order.stockState === 'reserved' && delta !== 0) {
          if (delta > 0 && oldListing.currentStock - oldListing.reservedStock < delta) {
            throw new DomainError('المخزون لا يكفي لزيادة الكمية');
          }
          oldListing.reservedStock = Math.max(0, oldListing.reservedStock + delta);
          db.inventoryMovements.unshift({
            id: makeId('mov'),
            shopId: order.shopId,
            productId: item.productId,
            productName: item.productName,
            type: delta > 0 ? 'reserve' : 'release_reservation',
            quantityDelta: 0,
            reservedDelta: delta,
            stockAfter: oldListing.currentStock,
            reservedAfter: oldListing.reservedStock,
            orderNumber: order.orderNumber,
            actorRole: input.actorRole,
            actorName: input.actorName,
            reason: `تعديل كمية الحجز بعد موافقة العميل (${order.orderNumber})`,
            createdAt: now,
          });
        }
        item.quantity = mod.proposedQuantity;
        item.lineTotalEGP = roundMoney(item.quantity * item.unitPriceEGP);
      } else if (mod.type === 'price_adjustment' && mod.proposedUnitPriceEGP) {
        item.unitPriceEGP = mod.proposedUnitPriceEGP;
        item.lineTotalEGP = roundMoney(item.quantity * item.unitPriceEGP);
      }
    } else {
      // Customer rejected substitution / price adjustment -> remove the unavailable item if substitution/unavailable, or keep original price if price_adjustment
      if (mod.type === 'substitute_item' || mod.type === 'remove_unavailable') {
        const oldListing = db.shopListings.find(
          (l) => l.shopId === order.shopId && l.productId === item.productId,
        );
        if (oldListing && order.stockState === 'reserved') {
          oldListing.reservedStock = Math.max(0, oldListing.reservedStock - item.quantity);
          db.inventoryMovements.unshift({
            id: makeId('mov'),
            shopId: order.shopId,
            productId: item.productId,
            productName: item.productName,
            type: 'release_reservation',
            quantityDelta: 0,
            reservedDelta: -item.quantity,
            stockAfter: oldListing.currentStock,
            reservedAfter: oldListing.reservedStock,
            orderNumber: order.orderNumber,
            actorRole: input.actorRole,
            actorName: input.actorName,
            reason: `إزالة صنف غير متوفر بعد رفض العميل للبديل (${order.orderNumber})`,
            createdAt: now,
          });
        }
        item.status = 'unavailable_removed';
        item.lineTotalEGP = 0;
      }
    }

    // Recalculate order financials accurately
    const activeItemsTotal = roundMoney(
      order.items
        .filter((i) => i.status !== 'unavailable_removed')
        .reduce((acc, i) => acc + i.lineTotalEGP, 0),
    );
    const split = calculateFinancialSplit(
      activeItemsTotal,
      order.financials.deliveryFeeEGP,
      db.distributionRules,
    );
    order.financials.itemsTotalEGP = activeItemsTotal;
    order.financials.customerExpectedTotalEGP = roundMoney(
      activeItemsTotal + order.financials.deliveryFeeEGP,
    );
    order.financials.shopDueEGP = split.shopDueEGP;
    order.financials.volunteerShareEGP = split.volunteerShareEGP;
    order.financials.operatingCostEGP = split.operatingCostEGP;
    order.financials.platformRevenueEGP = split.platformRevenueEGP;

    order.modificationHistory.push(mod);
    order.pendingModification = undefined;
    order.timeline.push({
      id: makeId('tl'),
      timestamp: now,
      actorRole: input.actorRole,
      actorName: input.actorName,
      eventType: input.decision === 'approved' ? 'modification_approved' : 'modification_rejected',
      title:
        input.decision === 'approved'
          ? 'وافق العميل على التعديل وتم تحديث الفاتورة'
          : 'رفض العميل البديل/التعديل المقترح',
      details: `${mod.targetProductName} — القناة: ${
        input.resolutionChannel === 'customer_app' ? 'تطبيق العميل' : 'تواصل هاتفي موثق'
      }${mod.resolutionNote ? ` (${mod.resolutionNote})` : ''}`,
    });

    await this.storage.write(db);
    return order;
  }

  async assignVolunteer(input: {
    orderNumber: string;
    volunteerId: string;
    reason?: string;
    actorName: string;
    actorRole: UserRole;
  }): Promise<Order> {
    const db = await this.storage.read();
    const order = db.orders.find((o) => o.orderNumber === input.orderNumber);
    if (!order) {
      throw new DomainError('الطلب غير موجود', 404);
    }
    if (order.status !== 'ready') {
      throw new DomainError('يمكن إسناد الطلب للمتطوع فقط عندما يصبح جاهزًا للاستلام');
    }
    if (
      order.deliveryStatus === 'delivered' ||
      order.deliveryStatus === 'delivery_failed'
    ) {
      throw new DomainError('لا يمكن إعادة إسناد طلب تم تسليمه أو فشل تسليمه');
    }
    const volunteer = db.volunteers.find((v) => v.id === input.volunteerId);
    if (!volunteer) {
      throw new DomainError('المتطوع المحدد غير موجود', 404);
    }

    const isReassignment = Boolean(order.volunteerId && order.volunteerId !== volunteer.id);
    if (isReassignment && !(input.reason ?? '').trim()) {
      throw new DomainError('يجب تسجيل سبب إعادة إسناد الطلب لمتطوع آخر');
    }

    const now = new Date().toISOString();
    const prevName = order.volunteerName;
    order.volunteerId = volunteer.id;
    order.volunteerName = volunteer.name;
    order.deliveryStatus = 'assigned';

    order.timeline.push({
      id: makeId('tl'),
      timestamp: now,
      actorRole: input.actorRole,
      actorName: input.actorName,
      eventType: isReassignment ? 'volunteer_reassigned' : 'volunteer_assigned',
      title: isReassignment
        ? `إعادة إسناد الطلب من ${prevName} إلى ${volunteer.name}`
        : `إسناد الطلب إلى المتطوع ${volunteer.name}`,
      details: input.reason?.trim(),
    });

    await this.storage.write(db);
    return order;
  }

  async getVolunteerOrders(volunteerId: string) {
    const db = await this.storage.read();
    const volunteer = db.volunteers.find((v) => v.id === volunteerId);
    if (!volunteer) {
      throw new DomainError('المتطوع غير موجود', 404);
    }
    const shopById = new Map(db.shops.map((s) => [s.id, s]));
    const attachShop = (order: Order) => ({
      ...order,
      shopAddress: shopById.get(order.shopId)?.address ?? '',
      shopPhone: shopById.get(order.shopId)?.phone ?? '',
    });

    const availableOrders = db.orders
      .filter((o) => o.status === 'ready' && o.deliveryStatus === 'unassigned')
      .map(attachShop);

    const assignedOrders = db.orders
      .filter((o) => o.volunteerId === volunteerId)
      .map(attachShop);

    return {
      volunteer,
      availableOrders,
      assignedOrders,
    };
  }

  async volunteerClaimOrder(input: {
    volunteerId: string;
    orderNumber: string;
  }): Promise<Order> {
    const db = await this.storage.read();
    const volunteer = db.volunteers.find((v) => v.id === input.volunteerId);
    if (!volunteer) {
      throw new DomainError('المتطوع غير موجود', 404);
    }
    const order = db.orders.find((o) => o.orderNumber === input.orderNumber);
    if (!order) {
      throw new DomainError('الطلب غير موجود', 404);
    }
    if (order.status !== 'ready' || order.deliveryStatus !== 'unassigned') {
      throw new DomainError('هذا الطلب غير متاح للاستلام الذاتي حاليًا');
    }
    const now = new Date().toISOString();
    order.volunteerId = volunteer.id;
    order.volunteerName = volunteer.name;
    order.deliveryStatus = 'assigned';
    order.timeline.push({
      id: makeId('tl'),
      timestamp: now,
      actorRole: 'delivery_volunteer',
      actorName: volunteer.name,
      eventType: 'volunteer_claimed',
      title: `قبل المتطوع ${volunteer.name} توصيل الطلب`,
    });
    await this.storage.write(db);
    return order;
  }

  async volunteerUpdateDeliveryStatus(input: {
    volunteerId: string;
    orderNumber: string;
    nextDeliveryStatus: DeliveryStatus;
    collectedAmountEGP?: number;
    discrepancyNote?: string;
    failureReason?: string;
    remittance?: {
      mode: CashRemittanceMode;
      shopTransferChannel?: RemittanceChannel;
      platformTransferChannel?: RemittanceChannel;
      instapayReference?: string;
      note?: string;
    };
  }): Promise<Order> {
    const db = await this.storage.read();
    const volunteer = db.volunteers.find((v) => v.id === input.volunteerId);
    if (!volunteer) {
      throw new DomainError('المتطوع غير موجود', 404);
    }
    const order = db.orders.find((o) => o.orderNumber === input.orderNumber);
    if (!order) {
      throw new DomainError('الطلب غير موجود', 404);
    }
    if (order.volunteerId !== volunteer.id) {
      throw new DomainError('هذا الطلب غير مسند إليك', 403);
    }

    const allowed: Record<DeliveryStatus, DeliveryStatus[]> = {
      unassigned: [],
      assigned: ['heading_to_shop', 'picked_up', 'delivery_failed'],
      heading_to_shop: ['picked_up', 'delivery_failed'],
      picked_up: ['heading_to_customer', 'delivered', 'delivery_failed'],
      heading_to_customer: ['delivered', 'delivery_failed'],
      delivered: [],
      delivery_failed: [],
    };

    if (!allowed[order.deliveryStatus].includes(input.nextDeliveryStatus)) {
      throw new DomainError(
        `انتقال حالة التوصيل غير مسموح من "${order.deliveryStatus}" إلى "${input.nextDeliveryStatus}"`,
      );
    }

    const now = new Date().toISOString();

    if (input.nextDeliveryStatus === 'heading_to_shop') {
      order.deliveryStatus = 'heading_to_shop';
      order.timeline.push({
        id: makeId('tl'),
        timestamp: now,
        actorRole: 'delivery_volunteer',
        actorName: volunteer.name,
        eventType: 'heading_to_shop',
        title: 'المتطوع في الطريق إلى المحل',
      });
    } else if (input.nextDeliveryStatus === 'picked_up') {
      order.deliveryStatus = 'picked_up';
      order.pickedUpAt = now;
      order.timeline.push({
        id: makeId('tl'),
        timestamp: now,
        actorRole: 'delivery_volunteer',
        actorName: volunteer.name,
        eventType: 'picked_up',
        title: 'تم استلام الطلب من المحل',
      });
    } else if (input.nextDeliveryStatus === 'heading_to_customer') {
      order.deliveryStatus = 'heading_to_customer';
      order.timeline.push({
        id: makeId('tl'),
        timestamp: now,
        actorRole: 'delivery_volunteer',
        actorName: volunteer.name,
        eventType: 'heading_to_customer',
        title: 'المتطوع في الطريق إلى العميل',
      });
    } else if (input.nextDeliveryStatus === 'delivered') {
      const collected = Number(input.collectedAmountEGP);
      if (!Number.isFinite(collected) || collected < 0) {
        throw new DomainError('يرجى إدخال المبلغ المحصل نقدًا بشكل صحيح');
      }
      const roundedCollected = roundMoney(collected);
      const discrepancy = roundMoney(roundedCollected - order.financials.customerExpectedTotalEGP);
      if (Math.abs(discrepancy) > 0.01 && !(input.discrepancyNote ?? '').trim()) {
        throw new DomainError(
          `المبلغ المحصل (${roundedCollected} ج.م) يختلف عن المطلوب (${order.financials.customerExpectedTotalEGP} ج.م). يرجى توضيح سبب الاختلاف.`,
        );
      }

      order.deliveryStatus = 'delivered';
      order.status = 'completed';
      order.deliveredAt = now;
      order.financials.collectedAmountEGP = roundedCollected;
      order.financials.collectionDiscrepancyEGP = discrepancy;
      order.financials.discrepancyNote = input.discrepancyNote?.trim();
      order.financials.collectedAt = now;

      if (input.remittance) {
        order.financials.remittance = buildOrderRemittanceRecord(
          order,
          input.remittance,
          volunteer.name,
          now,
        );
      }

      order.financials.settlementStatus = computeSettlementStatus(order);

      order.timeline.push({
        id: makeId('tl'),
        timestamp: now,
        actorRole: 'delivery_volunteer',
        actorName: volunteer.name,
        eventType: 'delivered_and_collected',
        title: 'تم تسليم الطلب وتحصيل المبلغ النقدي',
        details:
          Math.abs(discrepancy) > 0.01
            ? `تم تحصيل ${roundedCollected} ج.م بدلًا من ${order.financials.customerExpectedTotalEGP} ج.م (فرق ${discrepancy} ج.م: ${order.financials.discrepancyNote})`
            : `تم تحصيل ${roundedCollected} ج.م بالكامل نقدًا عند الاستلام`,
      });

      if (order.financials.remittance) {
        const rem = order.financials.remittance;
        const channelText =
          rem.shopTransferChannel === 'instapay' ? 'إنستاباي للمحل' : 'نقدي في المحل';
        const remDetails =
          rem.mode === 'full_to_shop'
            ? `تسليم المبلغ كاملًا (${rem.amountToShopEGP} ج.م — ${channelText}) بانتظار تأكيد المحل (يبقى للمنصة لدى المحل ${rem.amountPlatformAtShopEGP} ج.م)`
            : rem.mode === 'split_shop_and_courier'
              ? `تسليم حصة المحل (${rem.amountToShopEGP} ج.م — ${channelText}) ويبقى جزء المنصة (${rem.amountWithCourierForPlatformEGP} ج.م) مع المندوب`
              : `تحويل كامل المبلغ (${rem.amountDirectToPlatformEGP} ج.م) إنستاباي للإدارة مباشرة${rem.instapayReference ? ` (مرجع: ${rem.instapayReference})` : ''}`;
        order.timeline.push({
          id: makeId('tl'),
          timestamp: now,
          actorRole: 'delivery_volunteer',
          actorName: volunteer.name,
          eventType: 'remittance_submitted',
          title: 'سجل المندوب مسار توريد التحصيل',
          details: remDetails,
        });
      }
    } else if (input.nextDeliveryStatus === 'delivery_failed') {
      const reason = (input.failureReason ?? '').trim();
      if (!reason) {
        throw new DomainError('يجب تسجيل سبب فشل التسليم');
      }
      this.releaseOrReturnOrderStock(
        db,
        order,
        'delivery_volunteer',
        volunteer.name,
        `إرجاع مخزون بسبب فشل التسليم: ${reason}`,
      );
      order.deliveryStatus = 'delivery_failed';
      order.status = 'cancelled';
      order.deliveryFailureReason = reason;
      order.cancelledAt = now;
      order.financials.shopDueEGP = 0;
      order.financials.volunteerShareEGP = 0;
      order.financials.operatingCostEGP = 0;
      order.financials.platformRevenueEGP = 0;
      order.timeline.push({
        id: makeId('tl'),
        timestamp: now,
        actorRole: 'delivery_volunteer',
        actorName: volunteer.name,
        eventType: 'delivery_failed',
        title: 'فشل توصيل الطلب وتم إرجاع البضاعة لمخزون المحل',
        details: reason,
      });
    }

    await this.storage.write(db);
    return order;
  }

  async volunteerSubmitRemittance(input: {
    volunteerId: string;
    orderNumber: string;
    mode: CashRemittanceMode;
    shopTransferChannel?: RemittanceChannel;
    platformTransferChannel?: RemittanceChannel;
    instapayReference?: string;
    note?: string;
  }): Promise<Order> {
    const db = await this.storage.read();
    const volunteer = db.volunteers.find((v) => v.id === input.volunteerId);
    if (!volunteer) {
      throw new DomainError('المتطوع غير موجود', 404);
    }
    const order = db.orders.find((o) => o.orderNumber === input.orderNumber);
    if (!order) {
      throw new DomainError('الطلب غير موجود', 404);
    }
    if (order.volunteerId !== volunteer.id) {
      throw new DomainError('هذا الطلب غير مسند إليك', 403);
    }
    if (order.status !== 'completed' || !order.financials.collectedAt) {
      throw new DomainError('يجب إتمام التسليم والتحصيل أولًا قبل تسجيل توريد المبلغ');
    }
    if (order.financials.remittance?.shopConfirmedAt) {
      throw new DomainError('أكد المحل استلام هذا التحصيل بالفعل ولا يمكن تغيير طريقة التوريد الآن');
    }
    if (order.financials.remittance?.platformConfirmedAt) {
      throw new DomainError('تم تأكيد إغلاق هذا التوريد مسبقًا');
    }

    const now = new Date().toISOString();
    const rem = buildOrderRemittanceRecord(
      order,
      {
        mode: input.mode,
        shopTransferChannel: input.shopTransferChannel,
        platformTransferChannel: input.platformTransferChannel,
        instapayReference: input.instapayReference,
        note: input.note,
      },
      volunteer.name,
      now,
    );
    order.financials.remittance = rem;
    order.financials.settlementStatus = computeSettlementStatus(order);

    const channelText =
      rem.shopTransferChannel === 'instapay' ? 'تحويل إنستاباي للمحل' : 'نقدي في إيد المحل';
    const remDetails =
      rem.mode === 'full_to_shop'
        ? `توريد المبلغ كاملًا للمحل (${rem.amountToShopEGP} ج.م — ${channelText}). عند تأكيد المحل تصبح حصة المنصة (${rem.amountPlatformAtShopEGP} ج.م) عند السوبر ماركت.`
        : rem.mode === 'split_shop_and_courier'
          ? `توريد حصة المحل (${rem.amountToShopEGP} ج.م — ${channelText})، ويبقى جزء المنصة (${rem.amountWithCourierForPlatformEGP} ج.م) مع المندوب لحين توريده.`
          : `تحويل كامل المبلغ (${rem.amountDirectToPlatformEGP} ج.م) إنستاباي للإدارة مباشرة${rem.instapayReference ? ` — مرجع: ${rem.instapayReference}` : ''}.`;

    order.timeline.push({
      id: makeId('tl'),
      timestamp: now,
      actorRole: 'delivery_volunteer',
      actorName: volunteer.name,
      eventType: 'remittance_submitted',
      title: 'تسجيل طريقة توريد المبلغ المحصل',
      details: remDetails,
    });

    await this.storage.write(db);
    return order;
  }

  async shopConfirmRemittanceReceipt(input: {
    shopId: string;
    orderNumber: string;
    confirmedBy: string;
    shiftId?: string;
    note?: string;
  }): Promise<Order> {
    const db = await this.storage.read();
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

    // Shop received its money -> shop settlement is closed!
    order.financials.shopSettledAt = now;

    if (rem.mode === 'full_to_shop') {
      if (rem.amountPlatformAtShopEGP <= 0) {
        rem.status = 'settled';
        rem.platformConfirmedAt = now;
        rem.platformConfirmedBy = 'تلقائي (لا يوجد رصيد إضافي للمنصة)';
      } else {
        rem.status = 'pending_platform_confirmation';
      }
    } else {
      // split_shop_and_courier
      if (rem.amountWithCourierForPlatformEGP <= 0) {
        rem.status = 'settled';
        rem.platformConfirmedAt = now;
        rem.platformConfirmedBy = 'تلقائي (لا يوجد رصيد متبقي مع المندوب)';
      } else {
        rem.status = 'pending_platform_confirmation';
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

    await this.storage.write(db);
    return order;
  }

  async adminConfirmRemittance(input: {
    orderNumber: string;
    target: 'from_shop' | 'from_volunteer' | 'full';
    actorName: string;
    settleVolunteerShareToo?: boolean;
  }): Promise<Order> {
    const db = await this.storage.read();
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
      // 'full'
      if (rem.mode !== 'full_to_platform_instapay' && !rem.shopConfirmedAt) {
        rem.shopConfirmedAt = now;
        rem.shopConfirmedBy = `${input.actorName} (تسوية شاملة)`;
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
      });
    }

    order.financials.settlementStatus = computeSettlementStatus(order);
    if (order.financials.settlementStatus === 'fully_settled') {
      order.financials.fullySettledAt = now;
    }

    await this.storage.write(db);
    return order;
  }

  async settleOrderParty(input: {
    orderNumber: string;
    party: 'shop' | 'volunteer' | 'both';
    actorName: string;
  }): Promise<Order> {
    const db = await this.storage.read();
    const order = db.orders.find((o) => o.orderNumber === input.orderNumber);
    if (!order) {
      throw new DomainError('الطلب غير موجود', 404);
    }
    if (order.status !== 'completed' || !order.financials.collectedAt) {
      throw new DomainError('لا يمكن تسوية طلب لم يكتمل تسليمه وتحصيله بعد');
    }

    const now = new Date().toISOString();
    if ((input.party === 'shop' || input.party === 'both') && !order.financials.shopSettledAt) {
      order.financials.shopSettledAt = now;
      order.timeline.push({
        id: makeId('tl'),
        timestamp: now,
        actorRole: 'super_admin',
        actorName: input.actorName,
        eventType: 'shop_settled',
        title: `تمت تسوية مستحقات المحل (${order.financials.shopDueEGP} ج.م)`,
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
    if (input.party === 'both' && order.financials.remittance && !order.financials.remittance.platformConfirmedAt) {
      if (
        order.financials.remittance.mode !== 'full_to_platform_instapay' &&
        !order.financials.remittance.shopConfirmedAt
      ) {
        order.financials.remittance.shopConfirmedAt = now;
        order.financials.remittance.shopConfirmedBy = input.actorName;
      }
      order.financials.remittance.platformConfirmedAt = now;
      order.financials.remittance.platformConfirmedBy = input.actorName;
      order.financials.remittance.status = 'settled';
    }

    order.financials.settlementStatus = computeSettlementStatus(order);
    if (order.financials.settlementStatus === 'fully_settled') {
      order.financials.fullySettledAt = now;
    }

    await this.storage.write(db);
    return order;
  }

  async updateShopProductListing(input: {
    shopId: string;
    productId: string;
    priceEGP?: number;
    isAvailable?: boolean;
    stockDelta?: number;
    lowStockThreshold?: number;
    reason: string;
    actorName: string;
  }): Promise<CatalogItemView> {
    const reason = (input.reason ?? '').trim();
    if (!reason) {
      throw new DomainError('لا يُسمح بتعديل السعر أو المخزون بدون تسجيل سبب العملية');
    }

    const db = await this.storage.read();
    const listing = db.shopListings.find(
      (l) => l.shopId === input.shopId && l.productId === input.productId,
    );
    const product = db.masterProducts.find((p) => p.id === input.productId);
    if (!listing || !product) {
      throw new DomainError('المنتج غير موجود في كتالوج هذا المحل', 404);
    }

    const now = new Date().toISOString();

    if (input.priceEGP !== undefined) {
      const price = Number(input.priceEGP);
      if (!Number.isFinite(price) || price <= 0) {
        throw new DomainError('السعر يجب أن يكون أكبر من صفر');
      }
      listing.priceEGP = roundMoney(price);
      listing.priceUpdatedAt = now;
      listing.priceSourceNote = `تحديث يدوي بواسطة ${input.actorName}: ${reason}`;
    }

    if (input.lowStockThreshold !== undefined) {
      const threshold = Math.max(0, Math.floor(Number(input.lowStockThreshold)));
      listing.lowStockThreshold = threshold;
    }

    if (input.stockDelta !== undefined && input.stockDelta !== 0) {
      const delta = Math.trunc(Number(input.stockDelta));
      const newStock = listing.currentStock + delta;
      if (newStock < listing.reservedStock) {
        throw new DomainError(
          `لا يمكن خفض المخزون عن الكمية المحجوزة حاليًا للطلبات (${listing.reservedStock})`,
        );
      }
      listing.currentStock = newStock;
      db.inventoryMovements.unshift({
        id: makeId('mov'),
        shopId: input.shopId,
        productId: product.id,
        productName: product.name,
        type: delta > 0 ? 'manual_add' : 'manual_deduct',
        quantityDelta: delta,
        reservedDelta: 0,
        stockAfter: listing.currentStock,
        reservedAfter: listing.reservedStock,
        actorRole: 'shop_owner',
        actorName: input.actorName,
        reason,
        createdAt: now,
      });
    }

    if (input.isAvailable !== undefined) {
      if (input.isAvailable && listing.currentStock - listing.reservedStock <= 0) {
        throw new DomainError('لا يمكن تفعيل توفر منتج رصيده المتاح صفر');
      }
      listing.isAvailable = input.isAvailable;
    } else if (listing.currentStock - listing.reservedStock <= 0) {
      listing.isAvailable = false;
    }

    await this.storage.write(db);
    const catalog = await this.getShopCatalog(input.shopId, true);
    return catalog.find((c) => c.productId === input.productId)!;
  }

  async addProductToShop(input: {
    shopId: string;
    name: string;
    brand: string;
    category: ProductCategory;
    packSize: string;
    unit: string;
    barcode?: string;
    isWeighted?: boolean;
    scalePlu?: string;
    description?: string;
    priceEGP: number;
    initialStock: number;
    lowStockThreshold?: number;
    actorName: string;
  }): Promise<CatalogItemView> {
    const name = input.name?.trim();
    const brand = input.brand?.trim() || 'عام';
    const packSize = input.packSize?.trim();
    const unit = input.unit?.trim();
    const price = Number(input.priceEGP);
    const initialStock = Math.floor(Number(input.initialStock));

    if (!name || !packSize || !unit) {
      throw new DomainError('يرجى إدخال اسم المنتج والحجم والوحدة');
    }
    if (!Number.isFinite(price) || price <= 0) {
      throw new DomainError('يرجى إدخال سعر صحيح أكبر من صفر');
    }
    if (!Number.isFinite(initialStock) || initialStock < 0) {
      throw new DomainError('الكمية الافتتاحية يجب أن تكون صفر أو أكثر');
    }

    const db = await this.storage.read();
    const shop = db.shops.find((s) => s.id === input.shopId);
    if (!shop) {
      throw new DomainError('المحل غير موجود', 404);
    }

    const now = new Date().toISOString();
    const productId = makeId('prod');
    const sku = `EG-CUS-${String(db.masterProducts.length + 1).padStart(3, '0')}`;

    const masterProduct: MasterProduct = {
      id: productId,
      sku,
      barcode: input.barcode?.trim() || undefined,
      isWeighted: Boolean(input.isWeighted),
      scalePlu: input.scalePlu?.trim() || undefined,
      name,
      brand,
      category: input.category,
      packSize,
      unit,
      description: input.description?.trim() || `${name} ${packSize}`,
    };
    db.masterProducts.push(masterProduct);

    db.shopListings.push({
      id: makeId('lst'),
      shopId: input.shopId,
      productId,
      priceEGP: roundMoney(price),
      priceUpdatedAt: now,
      priceSourceNote: 'سعر مدخل من صاحب المحل',
      isAvailable: initialStock > 0,
      currentStock: initialStock,
      reservedStock: 0,
      lowStockThreshold: Math.max(1, Math.floor(input.lowStockThreshold ?? 5)),
    });

    db.inventoryMovements.unshift({
      id: makeId('mov'),
      shopId: input.shopId,
      productId,
      productName: name,
      type: 'manual_add',
      quantityDelta: initialStock,
      reservedDelta: 0,
      stockAfter: initialStock,
      reservedAfter: 0,
      actorRole: 'shop_owner',
      actorName: input.actorName,
      reason: 'إضافة منتج جديد لكتالوج المحل',
      createdAt: now,
    });

    await this.storage.write(db);
    const catalog = await this.getShopCatalog(input.shopId, true);
    return catalog.find((c) => c.productId === productId)!;
  }

  async recordPosOfflineSale(input: {
    shopId: string;
    items: Array<{
      productId: string;
      quantity: number;
      lineTotalEGP: number;
      weightKg?: number;
      scannedBarcode?: string;
      entryMethod: 'camera_scan' | 'scale_barcode' | 'manual_entry';
    }>;
    deductInventory: boolean;
    note?: string;
    createdBy: string;
    shiftId?: string;
    staffId?: string;
    staffName?: string;
  }): Promise<{ entry: ShopDailyEntry; receiptNumber: string }> {
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new DomainError('لا توجد أصناف في فاتورة الكاشير');
    }

    const db = await this.storage.read();
    const shop = db.shops.find((s) => s.id === input.shopId);
    if (!shop) {
      throw new DomainError('المحل غير موجود', 404);
    }

    const now = new Date().toISOString();
    const receiptNumber = `POS-${String(Date.now()).slice(-5)}`;
    const productMap = new Map(db.masterProducts.map((p) => [p.id, p]));
    const summaryParts: string[] = [];
    let totalAmountEGP = 0;

    for (const row of input.items) {
      const product = productMap.get(row.productId);
      const listing = db.shopListings.find(
        (l) => l.shopId === input.shopId && l.productId === row.productId,
      );
      if (!product || !listing) {
        throw new DomainError('أحد الأصناف غير مدرج في هذا المحل');
      }
      const lineTotal = roundMoney(Number(row.lineTotalEGP));
      const qty = Number(row.quantity);
      if (!Number.isFinite(lineTotal) || lineTotal <= 0 || !Number.isFinite(qty) || qty <= 0) {
        throw new DomainError(`قيمة غير صالحة للصنف "${product.name}"`);
      }

      totalAmountEGP = roundMoney(totalAmountEGP + lineTotal);

      const qtyLabel = product.isWeighted
        ? `${Math.round((row.weightKg ?? qty) * 1000)} جم`
        : `${qty} ${product.unit}`;
      summaryParts.push(`${product.name} (${qtyLabel})`);

      if (input.deductInventory) {
        const deductAmt = product.isWeighted
          ? Math.round((row.weightKg ?? qty) * 1000) / 1000
          : Math.floor(qty);
        const available = listing.currentStock - listing.reservedStock;
        if (available < deductAmt) {
          throw new DomainError(
            `الكمية المتاحة من "${product.name}" (${available}) أقل من المطلوب بيعه (${deductAmt}) مع وجود طلبات أونلاين محجوزة`,
          );
        }
        listing.currentStock = Math.max(
          0,
          Math.round((listing.currentStock - deductAmt) * 1000) / 1000,
        );
        if (listing.currentStock - listing.reservedStock <= 0) {
          listing.isAvailable = false;
        }
        db.inventoryMovements.unshift({
          id: makeId('mov'),
          shopId: input.shopId,
          productId: product.id,
          productName: product.name,
          type: 'pos_offline_sale',
          quantityDelta: -deductAmt,
          reservedDelta: 0,
          stockAfter: listing.currentStock,
          reservedAfter: listing.reservedStock,
          actorRole: 'shop_owner',
          actorName: input.createdBy,
          reason: `بيع كاشير سريع ${receiptNumber} (${
            row.entryMethod === 'scale_barcode'
              ? 'باركود ميزان'
              : row.entryMethod === 'camera_scan'
                ? 'مسح كاميرا'
                : 'إدخال يدوي'
          })`,
          createdAt: now,
        });
      }
    }

    const entry: ShopDailyEntry = {
      id: makeId('entry'),
      shopId: input.shopId,
      type: 'offline_sale',
      category: 'مبيعات كاشير الموبايل (خارج المنصة)',
      description: `فاتورة ${receiptNumber}: ${summaryParts.join('، ')}${
        input.note?.trim() ? ` — ${input.note.trim()}` : ''
      }`,
      amountEGP: totalAmountEGP,
      shiftId: input.shiftId,
      staffId: input.staffId,
      staffName: input.staffName,
      entryDate: now.slice(0, 10),
      createdBy: input.createdBy,
      createdAt: now,
    };

    if (input.shiftId) {
      const openShift = db.shopShiftSessions.find(
        (sh) => sh.id === input.shiftId && sh.shopId === input.shopId && sh.status === 'open',
      );
      if (openShift) {
        openShift.posSalesCount += 1;
        openShift.posSalesTotalEGP = roundMoney(openShift.posSalesTotalEGP + totalAmountEGP);
        openShift.expectedCashEGP = roundMoney(openShift.openingCashEGP + openShift.posSalesTotalEGP);
      }
    }

    db.shopDailyEntries.unshift(entry);
    await this.storage.write(db);
    return { entry, receiptNumber };
  }

  async shopHandoverOrderToVolunteer(input: {
    shopId: string;
    orderNumber: string;
    actorName: string;
    shiftId?: string;
  }): Promise<Order> {
    const db = await this.storage.read();
    const order = db.orders.find((o) => o.orderNumber === input.orderNumber);
    if (!order) {
      throw new DomainError('الطلب غير موجود', 404);
    }
    if (order.shopId !== input.shopId) {
      throw new DomainError('هذا الطلب يتبع محلًا آخر', 403);
    }
    if (order.status !== 'ready') {
      throw new DomainError('يجب أن يكون الطلب جاهزًا للاستلام قبل تسليمه للمتطوع');
    }
    if (!order.volunteerId) {
      throw new DomainError('لم يتم إسناد متطوع لهذا الطلب بعد');
    }
    if (order.deliveryStatus !== 'assigned' && order.deliveryStatus !== 'heading_to_shop') {
      throw new DomainError('الطلب مُسلَّم للمتطوع بالفعل أو حالته لا تسمح بالتسليم الآن');
    }

    const now = new Date().toISOString();
    order.deliveryStatus = 'picked_up';
    order.pickedUpAt = now;
    order.timeline.push({
      id: makeId('tl'),
      timestamp: now,
      actorRole: 'shop_owner',
      actorName: input.actorName,
      eventType: 'shop_handover_to_volunteer',
      title: `تم تسليم الطلب للمتطوع ${order.volunteerName ?? ''} من كاشير المحل`,
      details: `بواسطة ${input.actorName}`,
    });

    if (input.shiftId) {
      const openShift = db.shopShiftSessions.find(
        (sh) => sh.id === input.shiftId && sh.shopId === input.shopId && sh.status === 'open',
      );
      if (openShift) {
        openShift.onlineOrdersHandledCount += 1;
      }
    }

    await this.storage.write(db);
    return order;
  }

  async incrementShiftOnlineHandled(shopId: string, shiftId?: string): Promise<void> {
    if (!shiftId) return;
    const db = await this.storage.read();
    const openShift = db.shopShiftSessions.find(
      (sh) => sh.id === shiftId && sh.shopId === shopId && sh.status === 'open',
    );
    if (openShift) {
      openShift.onlineOrdersHandledCount += 1;
      await this.storage.write(db);
    }
  }

  // --- Multi-Shift Live POS & Printed QR Management ---

  async getShopPosManagement(shopId: string): Promise<{
    posConfig: ShopPosQrConfig;
    staffAccounts: PublicShopStaffView[];
    shifts: ShopShiftSession[];
  }> {
    const db = await this.storage.read();
    const shop = db.shops.find((s) => s.id === shopId);
    if (!shop) {
      throw new DomainError('المحل غير موجود', 404);
    }
    const posConfig = db.shopPosConfigs.find((c) => c.shopId === shopId) ?? {
      shopId,
      qrAccessKey: crypto.randomBytes(12).toString('hex'),
      maxConcurrentSessions: 2,
      updatedAt: new Date().toISOString(),
    };
    const staffAccounts = db.shopStaffAccounts
      .filter((s) => s.shopId === shopId)
      .map(sanitizeStaffView);
    const shifts = db.shopShiftSessions
      .filter((sh) => sh.shopId === shopId)
      .sort((a, b) => (a.openedAt < b.openedAt ? 1 : -1));

    return { posConfig, staffAccounts, shifts };
  }

  async verifyShopQrGate(shopId: string, qrKey: string): Promise<{
    shop: { id: string; name: string; area: string };
    maxConcurrentSessions: number;
    openShifts: Array<{
      id: string;
      staffId: string;
      staffName: string;
      shiftLabel: string;
      deviceLabel: string;
      roleTier: ShopStaffRole;
      openedAt: string;
    }>;
    staffList: PublicShopStaffView[];
  }> {
    const db = await this.storage.read();
    const shop = db.shops.find((s) => s.id === shopId);
    if (!shop) {
      throw new DomainError('المحل غير موجود', 404);
    }
    const cfg = db.shopPosConfigs.find((c) => c.shopId === shopId);
    if (!cfg || !qrKey || cfg.qrAccessKey !== qrKey.trim()) {
      throw new DomainError(
        'رابط أو كود الـ QR غير صالح أو تم تحديثه من صاحب المحل. يرجى مسح الكود المطبوع الحالي بالمحل.',
        403,
      );
    }

    const openShifts = db.shopShiftSessions
      .filter((sh) => sh.shopId === shopId && sh.status === 'open')
      .map((sh) => ({
        id: sh.id,
        staffId: sh.staffId,
        staffName: sh.staffName,
        shiftLabel: sh.shiftLabel,
        deviceLabel: sh.deviceLabel,
        roleTier: sh.roleTier,
        openedAt: sh.openedAt,
      }));

    const staffList = db.shopStaffAccounts
      .filter((s) => s.shopId === shopId && s.isActive)
      .map(sanitizeStaffView);

    return {
      shop: { id: shop.id, name: shop.name, area: shop.area },
      maxConcurrentSessions: cfg.maxConcurrentSessions,
      openShifts,
      staffList,
    };
  }

  async upsertShopStaff(input: {
    shopId: string;
    staffId?: string;
    name: string;
    shiftLabel: string;
    deviceLabel: string;
    roleTier: ShopStaffRole;
    permissions: ShopStaffPermissions;
    isActive: boolean;
  }): Promise<PublicShopStaffView> {
    const name = input.name?.trim();
    const shiftLabel = input.shiftLabel?.trim();
    const deviceLabel = input.deviceLabel?.trim() || 'موبايل كاشير';
    if (!name || !shiftLabel) {
      throw new DomainError('يرجى إدخال اسم الموظف واسم الوردية');
    }

    const db = await this.storage.read();
    const shop = db.shops.find((s) => s.id === input.shopId);
    if (!shop) throw new DomainError('المحل غير موجود', 404);

    const now = new Date().toISOString();
    const cleanPermissions: ShopStaffPermissions = {
      canPosSell: Boolean(input.permissions.canPosSell),
      canManageOnlineOrders: Boolean(input.permissions.canManageOnlineOrders),
      canModifyOrCancelOrders: Boolean(input.permissions.canModifyOrCancelOrders),
      canAddProducts: Boolean(input.permissions.canAddProducts),
      canAdjustPricesOrStock: Boolean(input.permissions.canAdjustPricesOrStock),
      canForceCloseShifts:
        input.roleTier === 'shift_supervisor' ? Boolean(input.permissions.canForceCloseShifts) : false,
    };

    if (input.staffId) {
      const existing = db.shopStaffAccounts.find(
        (s) => s.id === input.staffId && s.shopId === input.shopId,
      );
      if (!existing) throw new DomainError('حساب الموظف غير موجود', 404);
      existing.name = name;
      existing.shiftLabel = shiftLabel;
      existing.deviceLabel = deviceLabel;
      existing.roleTier = input.roleTier;
      existing.permissions = cleanPermissions;
      existing.isActive = Boolean(input.isActive);
      existing.updatedAt = now;
      if (!existing.isActive) {
        existing.tokenVersion += 1;
      }
      await this.storage.write(db);
      return sanitizeStaffView(existing);
    }

    const created: ShopStaffAccount = {
      id: makeId(`staff_${input.shopId}`),
      shopId: input.shopId,
      name,
      shiftLabel,
      deviceLabel,
      roleTier: input.roleTier,
      permissions: cleanPermissions,
      passcodeHash: '',
      passcodeSalt: '',
      isActive: Boolean(input.isActive),
      tokenVersion: 1,
      createdAt: now,
      updatedAt: now,
    };
    db.shopStaffAccounts.push(created);
    await this.storage.write(db);
    return sanitizeStaffView(created);
  }

  async setShopStaffPasscode(input: {
    shopId: string;
    staffId: string;
    passcode: string;
  }): Promise<PublicShopStaffView> {
    const passcode = String(input.passcode ?? '').trim();
    if (passcode.length < 4) {
      throw new DomainError('يجب أن يتكون رمز المرور (PIN) من 4 أرقام أو أحرف على الأقل');
    }
    const db = await this.storage.read();
    const staff = db.shopStaffAccounts.find(
      (s) => s.id === input.staffId && s.shopId === input.shopId,
    );
    if (!staff) throw new DomainError('حساب الوردية غير موجود', 404);

    const { hashHex, saltHex } = hashStaffPasscode(passcode);
    staff.passcodeHash = hashHex;
    staff.passcodeSalt = saltHex;
    staff.tokenVersion += 1; // Immediately revokes old device sessions using the old password
    staff.updatedAt = new Date().toISOString();

    await this.storage.write(db);
    return sanitizeStaffView(staff);
  }

  async regenerateShopQrKey(shopId: string): Promise<ShopPosQrConfig> {
    const db = await this.storage.read();
    const shop = db.shops.find((s) => s.id === shopId);
    if (!shop) throw new DomainError('المحل غير موجود', 404);

    let cfg = db.shopPosConfigs.find((c) => c.shopId === shopId);
    const now = new Date().toISOString();
    const nextKey = crypto.randomBytes(12).toString('hex');
    if (!cfg) {
      cfg = {
        shopId,
        qrAccessKey: nextKey,
        maxConcurrentSessions: 2,
        updatedAt: now,
      };
      db.shopPosConfigs.push(cfg);
    } else {
      cfg.qrAccessKey = nextKey;
      cfg.updatedAt = now;
    }
    await this.storage.write(db);
    return cfg;
  }

  async updateShopMaxConcurrentSessions(
    shopId: string,
    maxConcurrentSessions: number,
  ): Promise<ShopPosQrConfig> {
    const cap = Math.floor(Number(maxConcurrentSessions));
    if (!Number.isFinite(cap) || cap < 1 || cap > 4) {
      throw new DomainError('الحد الأقصى للجلسات المتزامنة يجب أن يكون بين 1 و 4');
    }
    const db = await this.storage.read();
    const cfg = db.shopPosConfigs.find((c) => c.shopId === shopId);
    if (!cfg) throw new DomainError('إعدادات الكاشير غير موجودة', 404);
    cfg.maxConcurrentSessions = cap;
    cfg.updatedAt = new Date().toISOString();
    await this.storage.write(db);
    return cfg;
  }

  async loginAndOpenShift(input: {
    shopId: string;
    qrKey: string;
    staffId: string;
    passcode: string;
    deviceId: string;
    openingCashEGP?: number;
  }): Promise<{ staff: PublicShopStaffView; shift: ShopShiftSession; tokenVersion: number }> {
    const deviceId = input.deviceId?.trim();
    if (!deviceId || deviceId.length < 4) {
      throw new DomainError('معرّف الجهاز مطلوب لتأمين الجلسة');
    }
    const db = await this.storage.read();
    const cfg = db.shopPosConfigs.find((c) => c.shopId === input.shopId);
    if (!cfg || !input.qrKey || cfg.qrAccessKey !== input.qrKey.trim()) {
      throw new DomainError('كود QR غير صالح أو تم إلغاؤه', 403);
    }

    const staff = db.shopStaffAccounts.find(
      (s) => s.id === input.staffId && s.shopId === input.shopId,
    );
    if (!staff) {
      throw new DomainError('حساب الموظف غير موجود', 404);
    }
    if (!staff.isActive) {
      throw new DomainError('تم إيقاف هذا الحساب من صاحب المحل', 403);
    }
    if (!staff.passcodeHash || !staff.passcodeSalt) {
      throw new DomainError(
        'لم يتم تعيين باسوورد لهذه الوردية بعد — يجب على صاحب المحل تعيين الباسوورد من لوحة المحل أولًا',
        403,
      );
    }
    if (!verifyStaffPasscode(String(input.passcode ?? '').trim(), staff.passcodeHash, staff.passcodeSalt)) {
      throw new DomainError('كلمة المرور (PIN) غير صحيحة', 401);
    }

    const openShiftsInShop = db.shopShiftSessions.filter(
      (sh) => sh.shopId === input.shopId && sh.status === 'open',
    );

    const existingForStaff = openShiftsInShop.find((sh) => sh.staffId === staff.id);
    if (existingForStaff) {
      if (existingForStaff.deviceId !== deviceId) {
        throw new DomainError(
          `هذا الحساب مفتوح بالفعل على جهاز آخر (${existingForStaff.deviceLabel}). أغلق الجلسة من الجهاز الآخر أو اطلب من صاحب المحل / المسؤول الأعلى إغلاقها إجباريًا.`,
          409,
        );
      }
      return {
        staff: sanitizeStaffView(staff),
        shift: existingForStaff,
        tokenVersion: staff.tokenVersion,
      };
    }

    if (openShiftsInShop.length >= cfg.maxConcurrentSessions) {
      throw new DomainError(
        `يوجد حاليًا ${openShiftsInShop.length} جلسة مفتوحة في المحل (الحد الأقصى ${cfg.maxConcurrentSessions} في نفس الوقت). يجب تقفيل إحدى الورديات أو إغلاقها إجباريًا أولًا.`,
        409,
      );
    }

    const openingCash = roundMoney(Math.max(0, Number(input.openingCashEGP ?? 0) || 0));
    const now = new Date().toISOString();
    const newShift: ShopShiftSession = {
      id: makeId('SHF'),
      shopId: input.shopId,
      staffId: staff.id,
      staffName: staff.name,
      shiftLabel: staff.shiftLabel,
      deviceLabel: staff.deviceLabel,
      roleTier: staff.roleTier,
      deviceId,
      status: 'open',
      openedAt: now,
      openingCashEGP: openingCash,
      posSalesCount: 0,
      posSalesTotalEGP: 0,
      onlineOrdersHandledCount: 0,
      expectedCashEGP: openingCash,
    };

    db.shopShiftSessions.unshift(newShift);
    await this.storage.write(db);

    return {
      staff: sanitizeStaffView(staff),
      shift: newShift,
      tokenVersion: staff.tokenVersion,
    };
  }

  async validatePosTokenState(input: {
    shopId: string;
    staffId: string;
    shiftId: string;
    tokenVersion: number;
  }): Promise<{ staff: PublicShopStaffView; shift: ShopShiftSession } | null> {
    const db = await this.storage.read();
    const staff = db.shopStaffAccounts.find(
      (s) => s.id === input.staffId && s.shopId === input.shopId,
    );
    if (!staff || !staff.isActive || staff.tokenVersion !== input.tokenVersion) {
      return null;
    }
    const shift = db.shopShiftSessions.find(
      (sh) =>
        sh.id === input.shiftId &&
        sh.shopId === input.shopId &&
        sh.staffId === input.staffId &&
        sh.status === 'open',
    );
    if (!shift) return null;

    return { staff: sanitizeStaffView(staff), shift };
  }

  async closeShopShift(input: {
    shopId: string;
    shiftId: string;
    declaredClosingCashEGP?: number;
    closingNote?: string;
    closedBy: string;
    isForceClose: boolean;
  }): Promise<ShopShiftSession> {
    const db = await this.storage.read();
    const shift = db.shopShiftSessions.find(
      (sh) => sh.id === input.shiftId && sh.shopId === input.shopId,
    );
    if (!shift) throw new DomainError('سجل الوردية غير موجود', 404);
    if (shift.status !== 'open') {
      throw new DomainError('هذه الوردية مغلقة بالفعل');
    }

    const now = new Date().toISOString();
    const expected = roundMoney(shift.openingCashEGP + shift.posSalesTotalEGP);
    const declared =
      input.declaredClosingCashEGP !== undefined && Number.isFinite(Number(input.declaredClosingCashEGP))
        ? roundMoney(Number(input.declaredClosingCashEGP))
        : undefined;

    shift.expectedCashEGP = expected;
    shift.declaredClosingCashEGP = declared;
    shift.cashVarianceEGP = declared !== undefined ? roundMoney(declared - expected) : undefined;
    shift.closingNote = input.closingNote?.trim() || undefined;
    shift.status = input.isForceClose ? 'force_closed' : 'closed';
    shift.closedAt = now;
    shift.closedBy = input.closedBy;

    // On force close, also bump staff tokenVersion so the remote device token is killed immediately
    if (input.isForceClose) {
      const staff = db.shopStaffAccounts.find(
        (s) => s.id === shift.staffId && s.shopId === input.shopId,
      );
      if (staff) {
        staff.tokenVersion += 1;
        staff.updatedAt = now;
      }
    }

    await this.storage.write(db);
    return shift;
  }

  async getLivePosWorkspace(shopId: string, staffId: string, shiftId: string) {
    const db = await this.storage.read();
    const shop = db.shops.find((s) => s.id === shopId);
    if (!shop) throw new DomainError('المحل غير موجود', 404);
    const staff = db.shopStaffAccounts.find((s) => s.id === staffId && s.shopId === shopId);
    if (!staff) throw new DomainError('الموظف غير موجود', 404);
    const shift = db.shopShiftSessions.find((sh) => sh.id === shiftId && sh.shopId === shopId);
    if (!shift) throw new DomainError('الوردية غير موجودة', 404);

    const [catalog, orders] = await Promise.all([
      this.getShopCatalog(shopId, true),
      this.getOrdersForShop(shopId),
    ]);

    const shiftReceipts = db.shopDailyEntries
      .filter((e) => e.shopId === shopId && e.shiftId === shiftId && e.type === 'offline_sale')
      .slice(0, 30);

    const openShiftsInShop = staff.permissions.canForceCloseShifts
      ? db.shopShiftSessions.filter((sh) => sh.shopId === shopId && sh.status === 'open')
      : [shift];

    return {
      shop: { id: shop.id, name: shop.name, area: shop.area, phone: shop.phone },
      staff: sanitizeStaffView(staff),
      shift,
      openShiftsInShop,
      catalog,
      orders,
      shiftReceipts,
    };
  }

  async getShopInventoryMovements(shopId: string): Promise<InventoryMovement[]> {
    const db = await this.storage.read();
    return db.inventoryMovements.filter((m) => m.shopId === shopId);
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

    const db = await this.storage.read();
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
        const qty = Math.floor(input.quantityRestocked);
        listing.currentStock += qty;
        listing.isAvailable = true;
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
          reason: `توريد مشتريات: ${input.description.trim()}`,
          createdAt: now,
        });
      }
    }

    const entry: ShopDailyEntry = {
      id: makeId('entry'),
      shopId: input.shopId,
      type: input.type,
      category: input.category?.trim() || 'عام',
      description: input.description.trim(),
      amountEGP: roundMoney(amount),
      relatedProductId: input.relatedProductId,
      relatedProductName,
      quantityRestocked: input.quantityRestocked,
      entryDate: now.slice(0, 10),
      createdBy: input.createdBy,
      createdAt: now,
    };

    db.shopDailyEntries.unshift(entry);
    await this.storage.write(db);
    return entry;
  }

  async getDistributionRules(): Promise<DistributionRules> {
    const db = await this.storage.read();
    return db.distributionRules;
  }

  async updateDistributionRules(input: Partial<DistributionRules>): Promise<DistributionRules> {
    const db = await this.storage.read();
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
    await this.storage.write(db);
    return next;
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

  async getAdminOrders(filters?: {
    shopId?: string;
    volunteerId?: string;
    status?: string;
    dateFrom?: string;
    dateTo?: string;
  }): Promise<Order[]> {
    const db = await this.storage.read();
    return db.orders.filter((o) => {
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
    });
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

    // Prep time (confirmedAt -> readyAt) strictly separated from Delivery time (pickedUpAt -> deliveredAt)
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

    // Customer frequency (new vs returning across filtered orders)
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

    // Product popularity & unavailable rate
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
        curr.totalQuantity += item.quantity;
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

  private releaseOrReturnOrderStock(
    db: CommerceDatabase,
    order: Order,
    actorRole: UserRole,
    actorName: string,
    reason: string,
  ): void {
    const now = new Date().toISOString();
    if (order.stockState === 'reserved') {
      for (const item of order.items) {
        if (item.status === 'unavailable_removed') continue;
        const listing = db.shopListings.find(
          (l) => l.shopId === order.shopId && l.productId === item.productId,
        );
        if (!listing) continue;
        listing.reservedStock = Math.max(0, listing.reservedStock - item.quantity);
        db.inventoryMovements.unshift({
          id: makeId('mov'),
          shopId: order.shopId,
          productId: item.productId,
          productName: item.productName,
          type: 'release_reservation',
          quantityDelta: 0,
          reservedDelta: -item.quantity,
          stockAfter: listing.currentStock,
          reservedAfter: listing.reservedStock,
          orderNumber: order.orderNumber,
          actorRole,
          actorName,
          reason,
          createdAt: now,
        });
      }
      order.stockState = 'released';
    } else if (order.stockState === 'deducted') {
      for (const item of order.items) {
        if (item.status === 'unavailable_removed') continue;
        const listing = db.shopListings.find(
          (l) => l.shopId === order.shopId && l.productId === item.productId,
        );
        if (!listing) continue;
        listing.currentStock += item.quantity;
        listing.isAvailable = true;
        db.inventoryMovements.unshift({
          id: makeId('mov'),
          shopId: order.shopId,
          productId: item.productId,
          productName: item.productName,
          type: 'return_to_stock',
          quantityDelta: item.quantity,
          reservedDelta: 0,
          stockAfter: listing.currentStock,
          reservedAfter: listing.reservedStock,
          orderNumber: order.orderNumber,
          actorRole,
          actorName,
          reason,
          createdAt: now,
        });
      }
      order.stockState = 'returned';
    }
  }
}

/**
 * Runs the full Mandatory Test Scenario (Section 15) + Edge Cases
 * against an isolated InMemoryStorageAdapter (or live adapter if specified).
 */
export async function executeMandatoryVerificationSuite(): Promise<{
  allPassed: boolean;
  steps: VerificationStepResult[];
}> {
  const mem = new InMemoryStorageAdapter();
  const svc = new CommerceService(mem);
  const steps: VerificationStepResult[] = [];

  const record = (step: string, passed: boolean, details: string) => {
    steps.push({ step, passed, details });
  };

  try {
    // Scenario 1: ماركت النور + المتطوع الأول (5 منتجات)
    const catalogA = await svc.getShopCatalog('shop_a');
    const fiveItemsA = catalogA.slice(0, 5).map((item) => ({ productId: item.productId, quantity: 2 }));
    const ordA = await svc.createCustomerOrder({
      shopId: 'shop_a',
      customerName: 'سارة عبد الرحمن',
      customerPhone: '01091112233',
      deliveryAddress: '9 شارع مصدق، الدقي',
      deliveryNotes: 'يرجى الاتصال عند الوصول',
      items: fiveItemsA,
    });
    record(
      '1-6. طلب عميل 5 منتجات من ماركت النور نقدي عند الاستلام',
      ordA.items.length === 5 && ordA.status === 'new' && ordA.stockState === 'reserved',
      `تم إنشاء ${ordA.orderNumber} بقيمة منتجات ${ordA.financials.itemsTotalEGP} ج.م وإجمالي ${ordA.financials.customerExpectedTotalEGP} ج.م`,
    );

    const confA = await svc.shopUpdateOrderStatus({
      shopId: 'shop_a',
      orderNumber: ordA.orderNumber,
      nextStatus: 'confirmed',
      actorName: 'الحاج محمود',
      actorRole: 'shop_owner',
    });
    const prepA = await svc.shopUpdateOrderStatus({
      shopId: 'shop_a',
      orderNumber: ordA.orderNumber,
      nextStatus: 'preparing',
      actorName: 'الحاج محمود',
      actorRole: 'shop_owner',
    });
    const readyA = await svc.shopUpdateOrderStatus({
      shopId: 'shop_a',
      orderNumber: ordA.orderNumber,
      nextStatus: 'ready',
      actorName: 'الحاج محمود',
      actorRole: 'shop_owner',
    });
    record(
      '7-9. تأكيد الطلب وتجهيزه وجاهزيته في ماركت النور',
      confA.status === 'confirmed' &&
        prepA.status === 'preparing' &&
        readyA.status === 'ready' &&
        readyA.stockState === 'deducted',
      `تحولت الحالة إلى جاهز للاستلام وتم خصم المخزون الفعلي (${readyA.stockState})`,
    );

    const assignedA = await svc.assignVolunteer({
      orderNumber: ordA.orderNumber,
      volunteerId: 'vol_1',
      actorName: 'الإدارة المركزية',
      actorRole: 'super_admin',
    });
    const pickedA = await svc.volunteerUpdateDeliveryStatus({
      volunteerId: 'vol_1',
      orderNumber: ordA.orderNumber,
      nextDeliveryStatus: 'picked_up',
    });
    const headingA = await svc.volunteerUpdateDeliveryStatus({
      volunteerId: 'vol_1',
      orderNumber: ordA.orderNumber,
      nextDeliveryStatus: 'heading_to_customer',
    });
    const deliveredA = await svc.volunteerUpdateDeliveryStatus({
      volunteerId: 'vol_1',
      orderNumber: ordA.orderNumber,
      nextDeliveryStatus: 'delivered',
      collectedAmountEGP: ordA.financials.customerExpectedTotalEGP,
    });
    record(
      '10-13. إسناد المتطوع الأول واستلامه وتوصيله وتحصيله النقدي',
      assignedA.volunteerId === 'vol_1' &&
        pickedA.deliveryStatus === 'picked_up' &&
        headingA.deliveryStatus === 'heading_to_customer' &&
        deliveredA.status === 'completed' &&
        deliveredA.financials.collectedAmountEGP === deliveredA.financials.customerExpectedTotalEGP,
      `تم التسليم وتحصيل ${deliveredA.financials.collectedAmountEGP} ج.م بنجاح`,
    );

    const settledA = await svc.settleOrderParty({
      orderNumber: ordA.orderNumber,
      party: 'both',
      actorName: 'الإدارة المركزية',
    });
    const analyticsAfterA = await svc.getAnalytics();
    record(
      '14-17. تسوية مستحقات المحل والمتطوع وتحديث التقارير المركزية',
      settledA.financials.settlementStatus === 'fully_settled' &&
        analyticsAfterA.platformGMV === ordA.financials.itemsTotalEGP &&
        analyticsAfterA.unsettledShopBalance === 0 &&
        analyticsAfterA.unsettledVolunteerBalance === 0,
      `حالة التسوية: ${settledA.financials.settlementStatus} | مستحق المحل: ${settledA.financials.shopDueEGP} ج.م | مستحق المتطوع: ${settledA.financials.volunteerShareEGP} ج.م`,
    );

    // Scenario 2: ماركت الأمانة + المتطوع الثاني
    const catalogB = await svc.getShopCatalog('shop_b');
    const itemsB = catalogB.slice(10, 15).map((item) => ({ productId: item.productId, quantity: 1 }));
    const ordB = await svc.createCustomerOrder({
      shopId: 'shop_b',
      customerName: 'ندى علي',
      customerPhone: '01273334455',
      deliveryAddress: '5 شارع السلام، العمرانية',
      items: itemsB,
    });
    await svc.shopUpdateOrderStatus({
      shopId: 'shop_b',
      orderNumber: ordB.orderNumber,
      nextStatus: 'confirmed',
      actorName: 'حسن الشافعي',
      actorRole: 'shop_owner',
    });
    await svc.shopUpdateOrderStatus({
      shopId: 'shop_b',
      orderNumber: ordB.orderNumber,
      nextStatus: 'preparing',
      actorName: 'حسن الشافعي',
      actorRole: 'shop_owner',
    });
    await svc.shopUpdateOrderStatus({
      shopId: 'shop_b',
      orderNumber: ordB.orderNumber,
      nextStatus: 'ready',
      actorName: 'حسن الشافعي',
      actorRole: 'shop_owner',
    });
    await svc.assignVolunteer({
      orderNumber: ordB.orderNumber,
      volunteerId: 'vol_2',
      actorName: 'الإدارة المركزية',
      actorRole: 'super_admin',
    });
    await svc.volunteerUpdateDeliveryStatus({
      volunteerId: 'vol_2',
      orderNumber: ordB.orderNumber,
      nextDeliveryStatus: 'picked_up',
    });
    // Test Cash Discrepancy on ordB!
    const expectedB = ordB.financials.customerExpectedTotalEGP;
    const deliveredB = await svc.volunteerUpdateDeliveryStatus({
      volunteerId: 'vol_2',
      orderNumber: ordB.orderNumber,
      nextDeliveryStatus: 'delivered',
      collectedAmountEGP: expectedB - 5,
      discrepancyNote: 'عجز فكة 5 جنيه عند العميل',
    });
    record(
      'تكرار السيناريو لماركت الأمانة والمتطوع الثاني + اختبار اختلاف مبلغ التحصيل',
      deliveredB.status === 'completed' &&
        deliveredB.financials.collectionDiscrepancyEGP === -5,
      `تم التحصيل ${deliveredB.financials.collectedAmountEGP} ج.م من أصل ${expectedB} ج.م (الفرق المسجل: ${deliveredB.financials.collectionDiscrepancyEGP} ج.م)`,
    );

    // Edge Case 1: إلغاء طلب وإرجاع الحجز
    const ordCancel = await svc.createCustomerOrder({
      shopId: 'shop_a',
      customerName: 'محمد إبراهيم',
      customerPhone: '01142223344',
      deliveryAddress: '21 شارع الجامعة',
      items: [{ productId: catalogA[0].productId, quantity: 3 }],
    });
    const cancelled = await svc.shopUpdateOrderStatus({
      shopId: 'shop_a',
      orderNumber: ordCancel.orderNumber,
      nextStatus: 'cancelled',
      reason: 'تعذر الوصول للعميل لتأكيد العنوان',
      actorName: 'الحاج محمود',
      actorRole: 'shop_owner',
    });
    record(
      'اختبار إلغاء طلب وفك حجز المخزون',
      cancelled.status === 'cancelled' && cancelled.stockState === 'released',
      `تم إلغاء ${cancelled.orderNumber} وفك حجز الكمية (${cancelled.stockState})`,
    );

    // Edge Case 2: منتج غير متوفر + تعديل كمية + رفض بديل + تعديل سعر محمي بموافقة
    const ordMod = await svc.createCustomerOrder({
      shopId: 'shop_a',
      customerName: 'طارق مصطفى',
      customerPhone: '01064445566',
      deliveryAddress: '33 شارع الهرم',
      items: [
        { productId: catalogA[1].productId, quantity: 2 },
        { productId: catalogA[2].productId, quantity: 1 },
      ],
    });
    await svc.shopUpdateOrderStatus({
      shopId: 'shop_a',
      orderNumber: ordMod.orderNumber,
      nextStatus: 'confirmed',
      actorName: 'الحاج محمود',
      actorRole: 'shop_owner',
    });
    // Propose quantity adjustment & approve
    await svc.proposeOrderModification({
      shopId: 'shop_a',
      orderNumber: ordMod.orderNumber,
      type: 'adjust_quantity',
      targetItemId: ordMod.items[0].id,
      proposedQuantity: 1,
      reason: 'المتاح على الرف قطعة واحدة فقط',
      actorName: 'الحاج محمود',
    });
    const afterQtyApproved = await svc.resolveOrderModification({
      orderNumber: ordMod.orderNumber,
      decision: 'approved',
      resolutionChannel: 'phone_recorded_by_shop',
      resolutionNote: 'تم الاتفاق مع العميل هاتفيًا',
      actorRole: 'shop_owner',
      actorName: 'الحاج محمود',
    });
    // Propose substitution & reject
    await svc.proposeOrderModification({
      shopId: 'shop_a',
      orderNumber: ordMod.orderNumber,
      type: 'substitute_item',
      targetItemId: ordMod.items[1].id,
      proposedProductId: catalogA[3].productId,
      reason: 'الشركة الموردة لم تسلم الصنف',
      actorName: 'الحاج محمود',
    });
    const afterSubRejected = await svc.resolveOrderModification({
      orderNumber: ordMod.orderNumber,
      decision: 'rejected',
      resolutionChannel: 'customer_app',
      actorRole: 'customer',
      actorName: 'طارق مصطفى',
    });
    record(
      'اختبار منتج غير متوفر وتعديل كمية ورفض بديل بموافقة/رفض موثق',
      afterQtyApproved.items[0].quantity === 1 &&
        afterSubRejected.items[1].status === 'unavailable_removed' &&
        afterSubRejected.unavailableItemCount === 1,
      `تم تعديل الكمية إلى 1 بموافقة العميل، وإزالة الصنف الثاني بعد رفض العميل للبديل`,
    );

    // Edge Case 3: إعادة إسناد طلب لمتطوع آخر + فشل توصيل وإرجاع المخزون
    const ordFail = await svc.createCustomerOrder({
      shopId: 'shop_b',
      customerName: 'هبة السيد',
      customerPhone: '01185556677',
      deliveryAddress: '17 شارع البطل',
      items: [{ productId: catalogB[0].productId, quantity: 2 }],
    });
    await svc.shopUpdateOrderStatus({
      shopId: 'shop_b',
      orderNumber: ordFail.orderNumber,
      nextStatus: 'confirmed',
      actorName: 'حسن الشافعي',
      actorRole: 'shop_owner',
    });
    await svc.shopUpdateOrderStatus({
      shopId: 'shop_b',
      orderNumber: ordFail.orderNumber,
      nextStatus: 'preparing',
      actorName: 'حسن الشافعي',
      actorRole: 'shop_owner',
    });
    await svc.shopUpdateOrderStatus({
      shopId: 'shop_b',
      orderNumber: ordFail.orderNumber,
      nextStatus: 'ready',
      actorName: 'حسن الشافعي',
      actorRole: 'shop_owner',
    });
    await svc.assignVolunteer({
      orderNumber: ordFail.orderNumber,
      volunteerId: 'vol_1',
      actorName: 'الإدارة المركزية',
      actorRole: 'super_admin',
    });
    const reassigned = await svc.assignVolunteer({
      orderNumber: ordFail.orderNumber,
      volunteerId: 'vol_2',
      reason: 'المتطوع الأول في منطقة بعيدة حاليًا',
      actorName: 'الإدارة المركزية',
      actorRole: 'super_admin',
    });
    await svc.volunteerUpdateDeliveryStatus({
      volunteerId: 'vol_2',
      orderNumber: ordFail.orderNumber,
      nextDeliveryStatus: 'picked_up',
    });
    const failed = await svc.volunteerUpdateDeliveryStatus({
      volunteerId: 'vol_2',
      orderNumber: ordFail.orderNumber,
      nextDeliveryStatus: 'delivery_failed',
      failureReason: 'العميل لم يرد على الهاتف لمدة 20 دقيقة',
    });
    record(
      'اختبار إعادة إسناد الطلب وفشل التوصيل وإرجاع المخزون للمحل',
      reassigned.volunteerId === 'vol_2' &&
        failed.deliveryStatus === 'delivery_failed' &&
        failed.stockState === 'returned',
      `تمت إعادة الإسناد من أحمد إلى كريم، وبعد فشل التسليم عاد المخزون (${failed.stockState})`,
    );
  } catch (err) {
    record(
      'خطأ غير متوقع أثناء التشغيل',
      false,
      err instanceof Error ? err.message : 'Unknown error',
    );
  }

  return {
    allPassed: steps.every((s) => s.passed),
    steps,
  };
}
