import crypto from 'node:crypto';
import type {
  AuditCategory,
  AuditLogEntry,
  CashRemittanceMode,
  CommerceDatabase,
  DistributionRules,
  Order,
  OrderRemittanceRecord,
  PublicShopStaffView,
  RemittanceChannel,
  SettlementStatus,
  ShopStaffAccount,
  UserRole,
} from '../../types/commerce.ts';

export class DomainError extends Error {
  public readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'DomainError';
    this.statusCode = statusCode;
  }
}

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function roundStockQty(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Constant-time string equality check using SHA-256 digests so lengths
 * do not short-circuit timing checks.
 */
export function safeEqualStrings(a: string, b: string): boolean {
  const hashA = crypto.createHash('sha256').update(String(a)).digest();
  const hashB = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

export function hashStaffPasscode(
  passcode: string,
  saltHex?: string,
): { hashHex: string; saltHex: string } {
  const salt = saltHex || crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(passcode, salt, 64).toString('hex');
  return { hashHex: derived, saltHex: salt };
}

export function verifyStaffPasscode(
  passcode: string,
  expectedHashHex: string,
  saltHex: string,
): boolean {
  if (!expectedHashHex || !saltHex) return false;
  const { hashHex } = hashStaffPasscode(passcode, saltHex);
  const a = Buffer.from(hashHex, 'hex');
  const b = Buffer.from(expectedHashHex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function issueOrderAccessToken(): {
  plainToken: string;
  hashHex: string;
  saltHex: string;
} {
  const plainToken = crypto.randomBytes(24).toString('base64url');
  const saltHex = crypto.randomBytes(12).toString('hex');
  const hashHex = crypto
    .createHmac('sha256', saltHex)
    .update(plainToken)
    .digest('hex');
  return { plainToken, hashHex, saltHex };
}

export function verifyOrderAccessToken(order: Order, candidateToken?: string): boolean {
  const clean = (candidateToken ?? '').trim();
  if (!clean || !order.accessTokenHash || !order.accessTokenSalt) {
    return false;
  }
  const actualHex = crypto
    .createHmac('sha256', order.accessTokenSalt)
    .update(clean)
    .digest('hex');
  const a = Buffer.from(actualHex, 'hex');
  const b = Buffer.from(order.accessTokenHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Strips internal security fields before returning Order objects to clients.
 */
export function sanitizeOrder(order: Order): Order {
  const { accessTokenHash: _h, accessTokenSalt: _s, ...safe } = order;
  return safe;
}

export function sanitizeStaffView(s: ShopStaffAccount): PublicShopStaffView {
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

export function appendAuditLog(
  db: CommerceDatabase,
  entry: {
    actorRole: AuditLogEntry['actorRole'];
    actorName: string;
    shopId?: string;
    category: AuditCategory;
    action: string;
    targetId?: string;
    summary: string;
    metadata?: Record<string, string | number | boolean>;
  },
): void {
  if (!Array.isArray(db.auditLogs)) {
    db.auditLogs = [];
  }
  db.auditLogs.unshift({
    id: makeId('aud'),
    timestamp: new Date().toISOString(),
    actorRole: entry.actorRole,
    actorName: entry.actorName,
    shopId: entry.shopId,
    category: entry.category,
    action: entry.action,
    targetId: entry.targetId,
    summary: entry.summary,
    metadata: entry.metadata,
  });
  if (db.auditLogs.length > 2000) {
    db.auditLogs.length = 2000;
  }
}

export function calculateFinancialSplit(
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

export function computeSettlementStatus(order: Order): SettlementStatus {
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

export function buildOrderRemittanceRecord(
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
      verificationStage: 'declared_by_courier',
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
      verificationStage: 'declared_by_courier',
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
    verificationStage: 'declared_by_courier',
    submittedBy,
    submittedAt: now,
  };
}

export function computeOrderCashHoldings(order: Order): {
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

  const platformConfirmed = Boolean(rem.platformConfirmedAt);
  return {
    platformAtShopEGP: 0,
    courierCashCustodyEGP: platformConfirmed ? 0 : rem.amountDirectToPlatformEGP,
    remittedToShopEGP: 0,
    remittedDirectInstapayEGP: platformConfirmed ? rem.amountDirectToPlatformEGP : 0,
  };
}

export function releaseOrReturnOrderStockInDb(
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
      listing.reservedStock = Math.max(0, roundStockQty(listing.reservedStock - item.quantity));
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
      listing.currentStock = roundStockQty(listing.currentStock + item.quantity);
      listing.isAvailable = listing.currentStock - listing.reservedStock > 0;
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
