import type {
  CashRemittanceMode,
  CustomerProfile,
  DeliveryStatus,
  InventoryMovement,
  Order,
  OrderItem,
  OrderModificationRequest,
  OrderStatus,
  RemittanceChannel,
  UserRole,
} from '../../types/commerce.ts';
import type { CommerceStorageAdapter } from '../storage.ts';
import {
  DomainError,
  appendAuditLog,
  buildOrderRemittanceRecord,
  calculateFinancialSplit,
  computeSettlementStatus,
  issueOrderAccessToken,
  makeId,
  releaseOrReturnOrderStockInDb,
  roundMoney,
  roundStockQty,
  sanitizeOrder,
  verifyOrderAccessToken,
} from './shared.ts';

export class OrderLifecycleService {
  private readonly storage: CommerceStorageAdapter;

  constructor(storage: CommerceStorageAdapter) {
    this.storage = storage;
  }

  private assertOrderCustomerAccess(
    order: Order,
    options: { accessToken?: string; bypassAuth?: boolean },
  ): void {
    if (options.bypassAuth) return;
    if (verifyOrderAccessToken(order, options.accessToken)) return;
    throw new DomainError(
      'غير مصرح بالوصول إلى بيانات هذا الطلب — يرجى استخدام رابط أو رمز المتابعة الصحيح من الجهاز الذي أنشأ الطلب.',
      403,
    );
  }

  async createCustomerOrder(input: {
    shopId: string;
    customerName: string;
    customerPhone: string;
    deliveryAddress: string;
    deliveryLocation?: { lat: number; lng: number };
    deliveryNotes?: string;
    items: Array<{ productId: string; quantity: number }>;
  }): Promise<{ order: Order; accessToken: string }> {
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

    return this.storage.transact((db) => {
      const shop = db.shops.find((s) => s.id === input.shopId);
      if (!shop) {
        throw new DomainError('المحل المختار غير موجود', 404);
      }

      const now = new Date().toISOString();
      const orderNumber = `ORD-${db.nextOrderSeq}`;
      db.nextOrderSeq += 1;

      let customer: CustomerProfile | undefined = db.customers.find((c) => c.phone === phone);
      if (!customer) {
        customer = {
          id: makeId('cust'),
          name,
          phone,
          address,
          area: shop.area,
          isDemoFixture: false,
          createdAt: now,
        };
        db.customers.push(customer);
      }

      const productById = new Map(db.masterProducts.map((p) => [p.id, p]));
      const orderItems: OrderItem[] = [];
      const movementsToAppend: InventoryMovement[] = [];
      let itemsTotalEGP = 0;

      const mergedMap = new Map<string, number>();
      for (const rawItem of input.items) {
        const product = productById.get(rawItem.productId);
        const qtyNum = Number(rawItem.quantity);
        if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
          throw new DomainError('الكمية المطلوبة يجب أن تكون أكبر من صفر');
        }
        const normalizedQty = product?.isWeighted ? roundStockQty(qtyNum) : Math.floor(qtyNum);
        if (normalizedQty <= 0) {
          throw new DomainError('الكمية المطلوبة يجب أن تكون أكبر من صفر');
        }
        mergedMap.set(
          rawItem.productId,
          roundStockQty((mergedMap.get(rawItem.productId) ?? 0) + normalizedQty),
        );
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
        const availableToSell = roundStockQty(listing.currentStock - listing.reservedStock);
        if (availableToSell < quantity) {
          throw new DomainError(
            `الكمية المتاحة من "${product.name}" هي ${availableToSell} ${product.unit} فقط`,
          );
        }

        listing.reservedStock = roundStockQty(listing.reservedStock + quantity);
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
      const { plainToken, hashHex, saltHex } = issueOrderAccessToken();

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
        accessTokenHash: hashHex,
        accessTokenSalt: saltHex,
        createdAt: now,
      };

      db.orders.unshift(order);
      db.inventoryMovements.unshift(...movementsToAppend);
      appendAuditLog(db, {
        actorRole: 'customer',
        actorName: name,
        shopId: shop.id,
        category: 'order',
        action: 'create_order',
        targetId: orderNumber,
        summary: `إنشاء طلب جديد ${orderNumber} في ${shop.name} بإجمالي ${customerExpectedTotalEGP} ج.م`,
      });

      return { order: sanitizeOrder(order), accessToken: plainToken };
    });
  }

  async getOrderForAuthorizedCaller(
    orderNumber: string,
    auth: { accessToken?: string; bypassAuth?: boolean; shopIdScope?: string; volunteerIdScope?: string },
  ): Promise<Order> {
    const db = await this.storage.read();
    const order = db.orders.find(
      (o) => o.orderNumber.toLowerCase() === orderNumber.trim().toLowerCase(),
    );
    if (!order) {
      throw new DomainError('لم يتم العثور على طلب بهذا الرقم', 404);
    }

    const tokenValid = verifyOrderAccessToken(order, auth.accessToken);
    const shopValid = Boolean(auth.shopIdScope && order.shopId === auth.shopIdScope);
    const volValid = Boolean(auth.volunteerIdScope && order.volunteerId === auth.volunteerIdScope);

    if (!auth.bypassAuth && !tokenValid && !shopValid && !volValid) {
      throw new DomainError(
        'مطلوب رمز متابعة الطلب الصحيح أو صلاحية تشغيل لعرض تفاصيل هذا الطلب.',
        403,
      );
    }

    return sanitizeOrder(order);
  }

  async getOrdersForShop(shopId: string): Promise<Order[]> {
    const db = await this.storage.read();
    return db.orders.filter((o) => o.shopId === shopId).map(sanitizeOrder);
  }

  async shopUpdateOrderStatus(input: {
    shopId: string;
    orderNumber: string;
    nextStatus: OrderStatus;
    reason?: string;
    actorName: string;
    actorRole: UserRole;
  }): Promise<Order> {
    return this.storage.transact((db) => {
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
        releaseOrReturnOrderStockInDb(
          db,
          order,
          input.actorRole,
          input.actorName,
          `إلغاء الطلب: ${reason}`,
        );
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
        appendAuditLog(db, {
          actorRole: input.actorRole,
          actorName: input.actorName,
          shopId: order.shopId,
          category: 'order',
          action: 'shop_cancel_order',
          targetId: order.orderNumber,
          summary: `إلغاء الطلب ${order.orderNumber} بواسطة ${input.actorName}: ${reason}`,
        });
        return sanitizeOrder(order);
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
            listing.currentStock = roundStockQty(listing.currentStock - item.quantity);
            listing.reservedStock = Math.max(0, roundStockQty(listing.reservedStock - item.quantity));
            if (listing.currentStock <= 0) {
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

      appendAuditLog(db, {
        actorRole: input.actorRole,
        actorName: input.actorName,
        shopId: order.shopId,
        category: 'order',
        action: `status_${input.nextStatus}`,
        targetId: order.orderNumber,
        summary: `تحديث حالة الطلب ${order.orderNumber} إلى "${input.nextStatus}"`,
      });

      return sanitizeOrder(order);
    });
  }

  async customerCancelOrder(input: {
    orderNumber: string;
    reason: string;
    accessToken?: string;
    bypassAuth?: boolean;
  }): Promise<Order> {
    return this.storage.transact((db) => {
      const order = db.orders.find((o) => o.orderNumber === input.orderNumber);
      if (!order) {
        throw new DomainError('الطلب غير موجود', 404);
      }
      this.assertOrderCustomerAccess(order, input);

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
      releaseOrReturnOrderStockInDb(
        db,
        order,
        'customer',
        order.customerName,
        `إلغاء العميل: ${reason}`,
      );
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

      appendAuditLog(db, {
        actorRole: 'customer',
        actorName: order.customerName,
        shopId: order.shopId,
        category: 'order',
        action: 'customer_cancel_order',
        targetId: order.orderNumber,
        summary: `ألغى العميل الطلب ${order.orderNumber}: ${reason}`,
      });

      return sanitizeOrder(order);
    });
  }

  async submitOrderRating(input: {
    orderNumber: string;
    overallRating: number;
    shopRating?: number;
    deliveryRating?: number;
    complimentTags?: string[];
    comment?: string;
    accessToken?: string;
    bypassAuth?: boolean;
  }): Promise<Order> {
    return this.storage.transact((db) => {
      const order = db.orders.find((o) => o.orderNumber === input.orderNumber?.trim());
      if (!order) {
        throw new DomainError('الطلب غير موجود', 404);
      }
      this.assertOrderCustomerAccess(order, input);

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

      return sanitizeOrder(order);
    });
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
    return this.storage.transact((db) => {
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
        if (roundStockQty(subListing.currentStock - subListing.reservedStock) < qtyNeeded) {
          throw new DomainError('الكمية المتاحة من المنتج البديل لا تكفي');
        }
        proposedProductName = subProduct.name;
        proposedPackSize = subProduct.packSize;
        proposedUnit = subProduct.unit;
        proposedUnitPriceEGP = subListing.priceEGP;
      } else if (input.type === 'adjust_quantity') {
        const qty = Number(input.proposedQuantity);
        if (!Number.isFinite(qty) || qty <= 0) {
          throw new DomainError('الكمية المقترحة يجب أن تكون أكبر من صفر');
        }
        if (qty > item.quantity) {
          const listing = db.shopListings.find(
            (l) => l.shopId === order.shopId && l.productId === item.productId,
          );
          if (
            !listing ||
            roundStockQty(listing.currentStock - listing.reservedStock) < roundStockQty(qty - item.quantity)
          ) {
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

      appendAuditLog(db, {
        actorRole: 'shop_owner',
        actorName: input.actorName,
        shopId: order.shopId,
        category: 'order',
        action: 'propose_modification',
        targetId: order.orderNumber,
        summary: `اقتراح تعديل (${input.type}) على "${item.productName}" في الطلب ${order.orderNumber}`,
      });

      return sanitizeOrder(order);
    });
  }

  async resolveOrderModification(input: {
    orderNumber: string;
    decision: 'approved' | 'rejected';
    resolutionChannel: 'customer_app' | 'phone_recorded_by_shop';
    resolutionNote?: string;
    actorRole: UserRole;
    actorName: string;
    accessToken?: string;
    bypassAuth?: boolean;
  }): Promise<Order> {
    return this.storage.transact((db) => {
      const order = db.orders.find((o) => o.orderNumber === input.orderNumber);
      if (!order || !order.pendingModification) {
        throw new DomainError('لا يوجد مقترح تعديل معلق لهذا الطلب', 404);
      }
      this.assertOrderCustomerAccess(order, input);

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
            oldListing.reservedStock = Math.max(
              0,
              roundStockQty(oldListing.reservedStock - item.quantity),
            );
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
          if (roundStockQty(newListing.currentStock - newListing.reservedStock) < newQty) {
            throw new DomainError('الكمية المتاحة من المنتج البديل لم تعد كافية');
          }
          if (oldListing && order.stockState === 'reserved') {
            oldListing.reservedStock = Math.max(
              0,
              roundStockQty(oldListing.reservedStock - item.quantity),
            );
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
            newListing.reservedStock = roundStockQty(newListing.reservedStock + newQty);
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
          const delta = roundStockQty(mod.proposedQuantity - item.quantity);
          if (oldListing && order.stockState === 'reserved' && delta !== 0) {
            if (
              delta > 0 &&
              roundStockQty(oldListing.currentStock - oldListing.reservedStock) < delta
            ) {
              throw new DomainError('المخزون لا يكفي لزيادة الكمية');
            }
            oldListing.reservedStock = Math.max(0, roundStockQty(oldListing.reservedStock + delta));
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
        if (mod.type === 'substitute_item' || mod.type === 'remove_unavailable') {
          const oldListing = db.shopListings.find(
            (l) => l.shopId === order.shopId && l.productId === item.productId,
          );
          if (oldListing && order.stockState === 'reserved') {
            oldListing.reservedStock = Math.max(
              0,
              roundStockQty(oldListing.reservedStock - item.quantity),
            );
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

      return sanitizeOrder(order);
    });
  }

  async assignVolunteer(input: {
    orderNumber: string;
    volunteerId: string;
    reason?: string;
    actorName: string;
    actorRole: UserRole;
  }): Promise<Order> {
    return this.storage.transact((db) => {
      const order = db.orders.find((o) => o.orderNumber === input.orderNumber);
      if (!order) {
        throw new DomainError('الطلب غير موجود', 404);
      }
      if (order.status !== 'ready') {
        throw new DomainError('يمكن إسناد الطلب للمتطوع فقط عندما يصبح جاهزًا للاستلام');
      }
      if (order.deliveryStatus === 'delivered' || order.deliveryStatus === 'delivery_failed') {
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

      appendAuditLog(db, {
        actorRole: input.actorRole,
        actorName: input.actorName,
        shopId: order.shopId,
        category: 'order',
        action: isReassignment ? 'reassign_volunteer' : 'assign_volunteer',
        targetId: order.orderNumber,
        summary: `إسناد الطلب ${order.orderNumber} إلى المتطوع ${volunteer.name}`,
      });

      return sanitizeOrder(order);
    });
  }

  async getVolunteerOrders(volunteerId: string) {
    const db = await this.storage.read();
    const volunteer = db.volunteers.find((v) => v.id === volunteerId);
    if (!volunteer) {
      throw new DomainError('المتطوع غير موجود', 404);
    }
    const shopById = new Map(db.shops.map((s) => [s.id, s]));
    const attachShop = (order: Order) => ({
      ...sanitizeOrder(order),
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
    return this.storage.transact((db) => {
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
      return sanitizeOrder(order);
    });
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
    return this.storage.transact((db) => {
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

        appendAuditLog(db, {
          actorRole: 'delivery_volunteer',
          actorName: volunteer.name,
          shopId: order.shopId,
          category: 'finance',
          action: 'order_delivered_collected',
          targetId: order.orderNumber,
          summary: `تسليم الطلب ${order.orderNumber} وتحصيل ${roundedCollected} ج.م`,
        });
      } else if (input.nextDeliveryStatus === 'delivery_failed') {
        const reason = (input.failureReason ?? '').trim();
        if (!reason) {
          throw new DomainError('يجب تسجيل سبب فشل التسليم');
        }
        releaseOrReturnOrderStockInDb(
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

      return sanitizeOrder(order);
    });
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
    return this.storage.transact((db) => {
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

      appendAuditLog(db, {
        actorRole: 'delivery_volunteer',
        actorName: volunteer.name,
        shopId: order.shopId,
        category: 'finance',
        action: 'declare_remittance',
        targetId: order.orderNumber,
        summary: `تسجيل توريد تحصيل الطلب ${order.orderNumber} (${rem.mode})`,
      });

      return sanitizeOrder(order);
    });
  }
}
