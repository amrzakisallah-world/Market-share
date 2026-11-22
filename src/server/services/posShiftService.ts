import crypto from 'node:crypto';
import type {
  PublicShopStaffView,
  ShopDailyEntry,
  ShopPosQrConfig,
  ShopShiftSession,
  ShopStaffAccount,
  ShopStaffPermissions,
  ShopStaffRole,
} from '../../types/commerce.ts';
import type { CommerceStorageAdapter } from '../storage.ts';
import type { CatalogInventoryService } from './catalogInventoryService.ts';
import type { OrderLifecycleService } from './orderLifecycleService.ts';
import {
  DomainError,
  appendAuditLog,
  hashStaffPasscode,
  makeId,
  roundMoney,
  roundStockQty,
  safeEqualStrings,
  sanitizeOrder,
  sanitizeStaffView,
  verifyStaffPasscode,
} from './shared.ts';

export class PosShiftService {
  private readonly storage: CommerceStorageAdapter;
  private readonly catalogService: CatalogInventoryService;
  private readonly orderService: OrderLifecycleService;

  constructor(
    storage: CommerceStorageAdapter,
    catalogService: CatalogInventoryService,
    orderService: OrderLifecycleService,
  ) {
    this.storage = storage;
    this.catalogService = catalogService;
    this.orderService = orderService;
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

    return this.storage.transact((db) => {
      const shop = db.shops.find((s) => s.id === input.shopId);
      if (!shop) {
        throw new DomainError('المحل غير موجود', 404);
      }

      const seq = db.nextPosReceiptSeq ?? 10001;
      db.nextPosReceiptSeq = seq + 1;
      const now = new Date().toISOString();
      const receiptNumber = `POS-${seq}`;
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
            ? roundStockQty(row.weightKg ?? qty)
            : Math.floor(qty);
          if (deductAmt <= 0) {
            throw new DomainError(`الكمية المخصومة غير صالحة للصنف "${product.name}"`);
          }
          const available = roundStockQty(listing.currentStock - listing.reservedStock);
          if (available < deductAmt) {
            throw new DomainError(
              `الكمية المتاحة من "${product.name}" (${available}) أقل من المطلوب بيعه (${deductAmt}) مع وجود طلبات أونلاين محجوزة`,
            );
          }
          listing.currentStock = Math.max(0, roundStockQty(listing.currentStock - deductAmt));
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
        receiptNumber,
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
          openShift.expectedCashEGP = roundMoney(
            openShift.openingCashEGP + openShift.posSalesTotalEGP,
          );
        }
      }

      db.shopDailyEntries.unshift(entry);
      appendAuditLog(db, {
        actorRole: input.staffId ? 'pos_staff' : 'shop_owner',
        actorName: input.createdBy,
        shopId: input.shopId,
        category: 'pos_shift',
        action: 'record_pos_sale',
        targetId: receiptNumber,
        summary: `تسجيل فاتورة كاشير ${receiptNumber} بقيمة ${totalAmountEGP} ج.م`,
      });

      return { entry, receiptNumber };
    });
  }

  async shopHandoverOrderToVolunteer(input: {
    shopId: string;
    orderNumber: string;
    actorName: string;
    shiftId?: string;
  }) {
    return this.storage.transact((db) => {
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

      appendAuditLog(db, {
        actorRole: input.shiftId ? 'pos_staff' : 'shop_owner',
        actorName: input.actorName,
        shopId: input.shopId,
        category: 'order',
        action: 'handover_to_volunteer',
        targetId: order.orderNumber,
        summary: `تسليم الطلب ${order.orderNumber} للمتطوع ${order.volunteerName}`,
      });

      return sanitizeOrder(order);
    });
  }

  async incrementShiftOnlineHandled(shopId: string, shiftId?: string): Promise<void> {
    if (!shiftId) return;
    await this.storage.transact((db) => {
      const openShift = db.shopShiftSessions.find(
        (sh) => sh.id === shiftId && sh.shopId === shopId && sh.status === 'open',
      );
      if (openShift) {
        openShift.onlineOrdersHandledCount += 1;
      }
    });
  }

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
    if (!cfg || !qrKey || !safeEqualStrings(cfg.qrAccessKey, qrKey.trim())) {
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

    return this.storage.transact((db) => {
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
        appendAuditLog(db, {
          actorRole: 'shop_owner',
          actorName: shop.ownerName,
          shopId: shop.id,
          category: 'pos_shift',
          action: 'update_staff',
          targetId: existing.id,
          summary: `تعديل صلاحيات/حالة الموظف "${name}" (${existing.isActive ? 'نشط' : 'موقوف'})`,
        });
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
      appendAuditLog(db, {
        actorRole: 'shop_owner',
        actorName: shop.ownerName,
        shopId: shop.id,
        category: 'pos_shift',
        action: 'create_staff',
        targetId: created.id,
        summary: `إضافة حساب وردية جديد "${name}" (${shiftLabel})`,
      });
      return sanitizeStaffView(created);
    });
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
    return this.storage.transact((db) => {
      const staff = db.shopStaffAccounts.find(
        (s) => s.id === input.staffId && s.shopId === input.shopId,
      );
      if (!staff) throw new DomainError('حساب الوردية غير موجود', 404);

      const { hashHex, saltHex } = hashStaffPasscode(passcode);
      staff.passcodeHash = hashHex;
      staff.passcodeSalt = saltHex;
      staff.tokenVersion += 1;
      staff.updatedAt = new Date().toISOString();

      appendAuditLog(db, {
        actorRole: 'shop_owner',
        actorName: 'صاحب المحل',
        shopId: input.shopId,
        category: 'security',
        action: 'set_staff_pin',
        targetId: staff.id,
        summary: `تحديث رمز PIN للموظف "${staff.name}" وإبطال الجلسات السابقة`,
      });

      return sanitizeStaffView(staff);
    });
  }

  async regenerateShopQrKey(shopId: string): Promise<ShopPosQrConfig> {
    return this.storage.transact((db) => {
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

      appendAuditLog(db, {
        actorRole: 'shop_owner',
        actorName: shop.ownerName,
        shopId,
        category: 'security',
        action: 'regenerate_qr',
        targetId: shopId,
        summary: `تجديد كود QR المطبوع للمحل وإبطال الكود السابق`,
      });

      return cfg;
    });
  }

  async updateShopMaxConcurrentSessions(
    shopId: string,
    maxConcurrentSessions: number,
  ): Promise<ShopPosQrConfig> {
    const cap = Math.floor(Number(maxConcurrentSessions));
    if (!Number.isFinite(cap) || cap < 1 || cap > 4) {
      throw new DomainError('الحد الأقصى للجلسات المتزامنة يجب أن يكون بين 1 و 4');
    }
    return this.storage.transact((db) => {
      const cfg = db.shopPosConfigs.find((c) => c.shopId === shopId);
      if (!cfg) throw new DomainError('إعدادات الكاشير غير موجودة', 404);
      cfg.maxConcurrentSessions = cap;
      cfg.updatedAt = new Date().toISOString();
      return cfg;
    });
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
    return this.storage.transact((db) => {
      const cfg = db.shopPosConfigs.find((c) => c.shopId === input.shopId);
      if (!cfg || !input.qrKey || !safeEqualStrings(cfg.qrAccessKey, input.qrKey.trim())) {
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
      if (
        !verifyStaffPasscode(
          String(input.passcode ?? '').trim(),
          staff.passcodeHash,
          staff.passcodeSalt,
        )
      ) {
        appendAuditLog(db, {
          actorRole: 'pos_staff',
          actorName: staff.name,
          shopId: input.shopId,
          category: 'security',
          action: 'pos_pin_failed',
          targetId: staff.id,
          summary: `محاولة دخول فاشلة برمز PIN لحساب "${staff.name}"`,
        });
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
      appendAuditLog(db, {
        actorRole: 'pos_staff',
        actorName: staff.name,
        shopId: input.shopId,
        category: 'pos_shift',
        action: 'open_shift',
        targetId: newShift.id,
        summary: `فتح وردية "${staff.name}" (${staff.shiftLabel}) بفكة ${openingCash} ج.م`,
      });

      return {
        staff: sanitizeStaffView(staff),
        shift: newShift,
        tokenVersion: staff.tokenVersion,
      };
    });
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
    return this.storage.transact((db) => {
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
        input.declaredClosingCashEGP !== undefined &&
        Number.isFinite(Number(input.declaredClosingCashEGP))
          ? roundMoney(Number(input.declaredClosingCashEGP))
          : undefined;

      shift.expectedCashEGP = expected;
      shift.declaredClosingCashEGP = declared;
      shift.cashVarianceEGP =
        declared !== undefined ? roundMoney(declared - expected) : undefined;
      shift.closingNote = input.closingNote?.trim() || undefined;
      shift.status = input.isForceClose ? 'force_closed' : 'closed';
      shift.closedAt = now;
      shift.closedBy = input.closedBy;

      if (input.isForceClose) {
        const staff = db.shopStaffAccounts.find(
          (s) => s.id === shift.staffId && s.shopId === input.shopId,
        );
        if (staff) {
          staff.tokenVersion += 1;
          staff.updatedAt = now;
        }
      }

      appendAuditLog(db, {
        actorRole: input.isForceClose ? 'shop_owner' : 'pos_staff',
        actorName: input.closedBy,
        shopId: input.shopId,
        category: 'pos_shift',
        action: input.isForceClose ? 'force_close_shift' : 'close_shift',
        targetId: shift.id,
        summary: `${input.isForceClose ? 'إغلاق إجباري لوردية' : 'تقفيل وردية'} "${shift.staffName}" (المتوقع ${expected} ج.م)`,
      });

      return shift;
    });
  }

  async getLivePosWorkspace(shopId: string, staffId: string, shiftId: string) {
    const db = await this.storage.read();
    const shop = db.shops.find((s) => s.id === shopId);
    if (!shop) throw new DomainError('المحل غير موجود', 404);
    const staff = db.shopStaffAccounts.find((s) => s.id === staffId && s.shopId === shopId);
    if (!staff) throw new DomainError('الموظف غير موجود', 404);
    const shift = db.shopShiftSessions.find((sh) => sh.id === shiftId && sh.shopId === shopId);
    if (!shift) throw new DomainError('الوردية غير موجودة', 404);

    const catalog = this.catalogService.buildShopCatalogFromDb(db, shopId);
    const orders = await this.orderService.getOrdersForShop(shopId);

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
}
