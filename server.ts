import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createServer as createViteServer } from 'vite';
import {
  CommerceService,
  DomainError,
  executeMandatoryVerificationSuite,
} from './src/server/commerceService.ts';
import { JsonFileStorageAdapter } from './src/server/storage.ts';
import type {
  CashRemittanceMode,
  DeliveryStatus,
  OrderModificationRequest,
  OrderStatus,
  ProductCategory,
  PublicShopStaffView,
  RemittanceChannel,
  ShopDailyEntryType,
  ShopShiftSession,
  ShopStaffPermissions,
  ShopStaffRole,
  UserRole,
} from './src/types/commerce.ts';

interface OpsTokenPayload {
  sub: string;
  baseRole: 'super_admin';
  effectiveRole: UserRole;
  effectiveActorId: string;
  effectiveLabel: string;
  exp: number;
}

interface PosTokenPayload {
  tokenKind: 'pos_staff';
  shopId: string;
  staffId: string;
  shiftId: string;
  tokenVersion: number;
  deviceId: string;
  exp: number;
}

interface AuthedRequest extends Request {
  opsSession?: OpsTokenPayload;
  posSession?: {
    token: PosTokenPayload;
    staff: PublicShopStaffView;
    shift: ShopShiftSession;
  };
}

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours

const storage = new JsonFileStorageAdapter(process.cwd());
const commerceService = new CommerceService(storage);

function signToken(payload: OpsTokenPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

function signPosToken(payload: PosTokenPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

function verifyToken(token: string): OpsTokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  const expectedSig = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(encoded)
    .digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as OpsTokenPayload;
    if (!parsed || typeof parsed.exp !== 'number' || parsed.exp < Date.now()) {
      return null;
    }
    if (parsed.baseRole !== 'super_admin') return null;
    return parsed;
  } catch {
    return null;
  }
}

function hashPasscode(passcode: string, saltHex?: string): { hashHex: string; saltHex: string } {
  const salt = saltHex || crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(passcode, salt, 64).toString('hex');
  return { hashHex: derived, saltHex: salt };
}

function safeEqualStrings(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function extractBearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim();
}

function requireOpsSession(req: AuthedRequest, res: Response, next: NextFunction): void {
  const token = extractBearer(req);
  if (!token) {
    res.status(401).json({ error: 'غير مصرح: يجب تسجيل الدخول لبوابة التشغيل والإدارة' });
    return;
  }
  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: 'انتهت صلاحية الجلسة أو التوقيع غير صالح' });
    return;
  }
  req.opsSession = payload;
  next();
}

function requireShopAccess(req: AuthedRequest, res: Response, next: NextFunction): void {
  const session = req.opsSession;
  if (!session) {
    res.status(401).json({ error: 'غير مصرح' });
    return;
  }
  const requestedShopId = req.params.shopId;
  const isAdmin = session.effectiveRole === 'super_admin';
  const isMatchingShop =
    session.effectiveRole === 'shop_owner' && session.effectiveActorId === requestedShopId;

  if (!isAdmin && !isMatchingShop) {
    res.status(403).json({
      error: 'ممنوع: الدور المحاكى/الحالي لا يملك صلاحية إدارة هذا المحل',
    });
    return;
  }
  next();
}

function requireVolunteerAccess(req: AuthedRequest, res: Response, next: NextFunction): void {
  const session = req.opsSession;
  if (!session) {
    res.status(401).json({ error: 'غير مصرح' });
    return;
  }
  const requestedVolunteerId = req.params.volunteerId;
  const isAdmin = session.effectiveRole === 'super_admin';
  const isMatchingVolunteer =
    session.effectiveRole === 'delivery_volunteer' &&
    session.effectiveActorId === requestedVolunteerId;

  if (!isAdmin && !isMatchingVolunteer) {
    res.status(403).json({
      error: 'ممنوع: الدور المحاكى/الحالي لا يملك صلاحية الوصول للوحة هذا المتطوع',
    });
    return;
  }
  next();
}

function requireAdminAccess(req: AuthedRequest, res: Response, next: NextFunction): void {
  const session = req.opsSession;
  if (!session) {
    res.status(401).json({ error: 'غير مصرح' });
    return;
  }
  if (session.effectiveRole !== 'super_admin') {
    res.status(403).json({
      error: 'ممنوع: هذا الإجراء متاح لدور الإدارة المركزية فقط (قم بالتبديل إلى الإدارة المركزية للمتابعة)',
    });
    return;
  }
  next();
}

function verifyPosToken(token: string): PosTokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  const expectedSig = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(encoded)
    .digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as PosTokenPayload;
    if (!parsed || parsed.tokenKind !== 'pos_staff') return null;
    if (typeof parsed.exp !== 'number' || parsed.exp < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function requirePosSession(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = extractBearer(req);
  if (!token) {
    res.status(401).json({ error: 'يجب تسجيل الدخول برمز الوردية أولًا' });
    return;
  }
  const payload = verifyPosToken(token);
  if (!payload) {
    res.status(401).json({ error: 'انتهت جلسة الكاشير أو التوقيع غير صالح' });
    return;
  }
  if (req.params.shopId && payload.shopId !== req.params.shopId) {
    res.status(403).json({ error: 'ممنوع: هذه الجلسة تخص محلًا آخر' });
    return;
  }

  const liveState = await commerceService.validatePosTokenState({
    shopId: payload.shopId,
    staffId: payload.staffId,
    shiftId: payload.shiftId,
    tokenVersion: payload.tokenVersion,
  });
  if (!liveState) {
    res.status(401).json({
      error: 'تم إغلاق الوردية أو تغيير كلمة المرور من الإدارة — يرجى إعادة تسجيل الدخول',
    });
    return;
  }

  req.posSession = { token: payload, staff: liveState.staff, shift: liveState.shift };
  next();
}

function requirePosPermission(perm: keyof ShopStaffPermissions) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    const pos = req.posSession;
    if (!pos) {
      res.status(401).json({ error: 'غير مصرح' });
      return;
    }
    if (!pos.staff.permissions[perm]) {
      res.status(403).json({
        error: 'ممنوع: حساب الوردية الحالي لا يملك صلاحية تنفيذ هذا الإجراء',
      });
      return;
    }
    next();
  };
}

function asyncHandler(
  fn: (req: AuthedRequest, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

async function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // --- Operations Auth & Role Simulation Endpoints ---
  app.get(
    '/api/ops/auth-status',
    asyncHandler(async (req, res) => {
      const envPass = process.env.OPS_ADMIN_PASSCODE?.trim();
      const db = await storage.read();
      const hasClaimedHash = Boolean(db.auth?.adminPasscodeHash && db.auth?.adminPasscodeSalt);
      const needsSetup = !envPass && !hasClaimedHash;
      const token = extractBearer(req);
      const session = token ? verifyToken(token) : null;

      res.json({
        needsSetup,
        envConfigured: Boolean(envPass),
        authenticated: Boolean(session),
        session: session
          ? {
              baseRole: session.baseRole,
              effectiveRole: session.effectiveRole,
              effectiveActorId: session.effectiveActorId,
              effectiveLabel: session.effectiveLabel,
            }
          : null,
      });
    }),
  );

  app.post(
    '/api/ops/claim-admin',
    asyncHandler(async (req, res) => {
      const envPass = process.env.OPS_ADMIN_PASSCODE?.trim();
      if (envPass) {
        throw new DomainError('رمز الإدارة مضبوط مسبقًا عبر إعدادات الخادم', 409);
      }
      const db = await storage.read();
      if (db.auth?.adminPasscodeHash) {
        throw new DomainError('تم تعيين رمز الإدارة مسبقًا، يرجى تسجيل الدخول', 409);
      }
      const passcode = String(req.body?.passcode ?? '').trim();
      if (passcode.length < 4) {
        throw new DomainError('يجب أن يتكون رمز المرور من 4 أحرف/أرقام على الأقل');
      }
      const { hashHex, saltHex } = hashPasscode(passcode);
      db.auth = { adminPasscodeHash: hashHex, adminPasscodeSalt: saltHex };
      await storage.write(db);

      const payload: OpsTokenPayload = {
        sub: 'admin_root',
        baseRole: 'super_admin',
        effectiveRole: 'super_admin',
        effectiveActorId: 'admin',
        effectiveLabel: 'الإدارة المركزية (Super Admin)',
        exp: Date.now() + TOKEN_TTL_MS,
      };
      res.status(201).json({
        token: signToken(payload),
        session: {
          baseRole: payload.baseRole,
          effectiveRole: payload.effectiveRole,
          effectiveActorId: payload.effectiveActorId,
          effectiveLabel: payload.effectiveLabel,
        },
      });
    }),
  );

  app.post(
    '/api/ops/login',
    asyncHandler(async (req, res) => {
      const passcode = String(req.body?.passcode ?? '').trim();
      if (!passcode) {
        throw new DomainError('يرجى إدخال رمز مرور الإدارة');
      }
      const envPass = process.env.OPS_ADMIN_PASSCODE?.trim();
      const db = await storage.read();

      let valid = false;
      if (envPass) {
        valid = safeEqualStrings(passcode, envPass);
      } else if (db.auth?.adminPasscodeHash && db.auth?.adminPasscodeSalt) {
        const { hashHex } = hashPasscode(passcode, db.auth.adminPasscodeSalt);
        valid = safeEqualStrings(hashHex, db.auth.adminPasscodeHash);
      } else {
        throw new DomainError('لم يتم إعداد رمز الإدارة بعد، يرجى إعداده أولًا', 400);
      }

      if (!valid) {
        throw new DomainError('رمز المرور غير صحيح', 401);
      }

      const payload: OpsTokenPayload = {
        sub: 'admin_root',
        baseRole: 'super_admin',
        effectiveRole: 'super_admin',
        effectiveActorId: 'admin',
        effectiveLabel: 'الإدارة المركزية (Super Admin)',
        exp: Date.now() + TOKEN_TTL_MS,
      };

      res.json({
        token: signToken(payload),
        session: {
          baseRole: payload.baseRole,
          effectiveRole: payload.effectiveRole,
          effectiveActorId: payload.effectiveActorId,
          effectiveLabel: payload.effectiveLabel,
        },
      });
    }),
  );

  app.post(
    '/api/ops/impersonate',
    requireOpsSession,
    asyncHandler(async (req, res) => {
      const target = String(req.body?.target ?? '').trim();
      const db = await storage.read();

      let effectiveRole: UserRole = 'super_admin';
      let effectiveActorId = 'admin';
      let effectiveLabel = 'الإدارة المركزية (Super Admin)';

      if (target === 'customer') {
        effectiveRole = 'customer';
        effectiveActorId = 'customer_sim';
        effectiveLabel = 'عميل (محاكاة واجهة المتجر)';
      } else if (target === 'shop_a' || target === 'shop_b') {
        const shop = db.shops.find((s) => s.id === target);
        if (!shop) throw new DomainError('المحل غير موجود', 404);
        effectiveRole = 'shop_owner';
        effectiveActorId = shop.id;
        effectiveLabel = `صاحب محل: ${shop.name}`;
      } else if (target === 'vol_1' || target === 'vol_2') {
        const vol = db.volunteers.find((v) => v.id === target);
        if (!vol) throw new DomainError('المتطوع غير موجود', 404);
        effectiveRole = 'delivery_volunteer';
        effectiveActorId = vol.id;
        effectiveLabel = `متطوع التوصيل: ${vol.name}`;
      } else if (target === 'super_admin') {
        effectiveRole = 'super_admin';
        effectiveActorId = 'admin';
        effectiveLabel = 'الإدارة المركزية (Super Admin)';
      } else {
        throw new DomainError('هدف المحاكاة غير معروف');
      }

      const payload: OpsTokenPayload = {
        sub: req.opsSession!.sub,
        baseRole: 'super_admin',
        effectiveRole,
        effectiveActorId,
        effectiveLabel,
        exp: Date.now() + TOKEN_TTL_MS,
      };

      res.json({
        token: signToken(payload),
        session: {
          baseRole: payload.baseRole,
          effectiveRole: payload.effectiveRole,
          effectiveActorId: payload.effectiveActorId,
          effectiveLabel: payload.effectiveLabel,
        },
      });
    }),
  );

  // --- Public Customer Storefront Routes (Zero Admin Data) ---
  app.get(
    '/api/store/shops',
    asyncHandler(async (_req, res) => {
      const shops = await commerceService.getShops();
      res.json({ shops });
    }),
  );

  app.get(
    '/api/store/shops/:shopId/catalog',
    asyncHandler(async (req, res) => {
      const catalog = await commerceService.getShopCatalog(req.params.shopId, true);
      // Customer view omits internal lowStockThreshold & reservedStock details
      const publicCatalog = catalog.map((item) => ({
        listingId: item.listingId,
        shopId: item.shopId,
        productId: item.productId,
        sku: item.sku,
        name: item.name,
        brand: item.brand,
        category: item.category,
        packSize: item.packSize,
        unit: item.unit,
        description: item.description,
        priceEGP: item.priceEGP,
        priceUpdatedAt: item.priceUpdatedAt,
        priceSourceNote: item.priceSourceNote,
        isAvailable: item.isAvailable && item.availableToSell > 0,
        availableQuantity: item.availableToSell,
      }));
      res.json({ catalog: publicCatalog });
    }),
  );

  app.get(
    '/api/store/demo-customers',
    asyncHandler(async (_req, res) => {
      const customers = await commerceService.getDemoCustomers();
      res.json({ customers });
    }),
  );

  app.post(
    '/api/store/orders',
    asyncHandler(async (req, res) => {
      const order = await commerceService.createCustomerOrder({
        shopId: req.body?.shopId,
        customerName: req.body?.customerName,
        customerPhone: req.body?.customerPhone,
        deliveryAddress: req.body?.deliveryAddress,
        deliveryLocation: req.body?.deliveryLocation,
        deliveryNotes: req.body?.deliveryNotes,
        items: req.body?.items,
      });
      res.status(201).json({ order });
    }),
  );

  app.get(
    '/api/store/orders/:orderNumber',
    asyncHandler(async (req, res) => {
      const order = await commerceService.getOrderByNumber(req.params.orderNumber);
      res.json({ order });
    }),
  );

  app.post(
    '/api/store/orders/:orderNumber/cancel',
    asyncHandler(async (req, res) => {
      const order = await commerceService.customerCancelOrder({
        orderNumber: req.params.orderNumber,
        reason: req.body?.reason,
      });
      res.json({ order });
    }),
  );

  app.post(
    '/api/store/orders/:orderNumber/modification-response',
    asyncHandler(async (req, res) => {
      const decision = req.body?.decision === 'approved' ? 'approved' : 'rejected';
      const order = await commerceService.resolveOrderModification({
        orderNumber: req.params.orderNumber,
        decision,
        resolutionChannel: 'customer_app',
        resolutionNote: req.body?.note,
        actorRole: 'customer',
        actorName: req.body?.customerName || 'العميل',
      });
      res.json({ order });
    }),
  );

  app.post(
    '/api/store/orders/:orderNumber/rating',
    asyncHandler(async (req, res) => {
      const order = await commerceService.submitOrderRating({
        orderNumber: req.params.orderNumber,
        overallRating: Number(req.body?.overallRating),
        shopRating: req.body?.shopRating !== undefined ? Number(req.body.shopRating) : undefined,
        deliveryRating:
          req.body?.deliveryRating !== undefined ? Number(req.body.deliveryRating) : undefined,
        complimentTags: Array.isArray(req.body?.complimentTags) ? req.body.complimentTags : [],
        comment: typeof req.body?.comment === 'string' ? req.body.comment : undefined,
      });
      res.json({ order });
    }),
  );

  // --- Role-Protected Shop Owner Routes ---
  app.get(
    '/api/shop/:shopId/dashboard',
    requireOpsSession,
    requireShopAccess,
    asyncHandler(async (req, res) => {
      const shopId = req.params.shopId;
      const [shops, catalog, orders, movements, dailyEntries, statement, posManagement] =
        await Promise.all([
          commerceService.getShops(),
          commerceService.getShopCatalog(shopId, true),
          commerceService.getOrdersForShop(shopId),
          commerceService.getShopInventoryMovements(shopId),
          commerceService.getShopDailyEntries(shopId),
          commerceService.getShopStatement(shopId),
          commerceService.getShopPosManagement(shopId),
        ]);
      const shop = shops.find((s) => s.id === shopId);
      res.json({ shop, catalog, orders, movements, dailyEntries, statement, posManagement });
    }),
  );

  app.post(
    '/api/shop/:shopId/orders/:orderNumber/status',
    requireOpsSession,
    requireShopAccess,
    asyncHandler(async (req, res) => {
      const shopId = req.params.shopId;
      const shops = await commerceService.getShops();
      const shop = shops.find((s) => s.id === shopId);
      const order = await commerceService.shopUpdateOrderStatus({
        shopId,
        orderNumber: req.params.orderNumber,
        nextStatus: req.body?.nextStatus as OrderStatus,
        reason: req.body?.reason,
        actorName: shop?.ownerName || 'صاحب المحل',
        actorRole: req.opsSession!.effectiveRole,
      });
      res.json({ order });
    }),
  );

  app.post(
    '/api/shop/:shopId/orders/:orderNumber/propose-modification',
    requireOpsSession,
    requireShopAccess,
    asyncHandler(async (req, res) => {
      const shopId = req.params.shopId;
      const shops = await commerceService.getShops();
      const shop = shops.find((s) => s.id === shopId);
      const order = await commerceService.proposeOrderModification({
        shopId,
        orderNumber: req.params.orderNumber,
        type: req.body?.type as OrderModificationRequest['type'],
        targetItemId: req.body?.targetItemId,
        proposedProductId: req.body?.proposedProductId,
        proposedQuantity:
          req.body?.proposedQuantity !== undefined ? Number(req.body.proposedQuantity) : undefined,
        proposedUnitPriceEGP:
          req.body?.proposedUnitPriceEGP !== undefined
            ? Number(req.body.proposedUnitPriceEGP)
            : undefined,
        reason: req.body?.reason,
        actorName: shop?.ownerName || 'صاحب المحل',
      });
      res.json({ order });
    }),
  );

  app.post(
    '/api/shop/:shopId/orders/:orderNumber/record-customer-approval',
    requireOpsSession,
    requireShopAccess,
    asyncHandler(async (req, res) => {
      const shopId = req.params.shopId;
      const orderCheck = await commerceService.getOrderByNumber(req.params.orderNumber);
      if (orderCheck.shopId !== shopId) {
        throw new DomainError('لا تملك صلاحية تعديل طلب خاص بمحل آخر', 403);
      }
      const shops = await commerceService.getShops();
      const shop = shops.find((s) => s.id === shopId);
      const decision = req.body?.decision === 'approved' ? 'approved' : 'rejected';
      const order = await commerceService.resolveOrderModification({
        orderNumber: req.params.orderNumber,
        decision,
        resolutionChannel: 'phone_recorded_by_shop',
        resolutionNote: req.body?.note || 'تأكيد هاتفي مسجل بواسطة المحل',
        actorRole: 'shop_owner',
        actorName: shop?.ownerName || 'صاحب المحل',
      });
      res.json({ order });
    }),
  );

  app.patch(
    '/api/shop/:shopId/catalog/:productId',
    requireOpsSession,
    requireShopAccess,
    asyncHandler(async (req, res) => {
      const shopId = req.params.shopId;
      const shops = await commerceService.getShops();
      const shop = shops.find((s) => s.id === shopId);
      const updated = await commerceService.updateShopProductListing({
        shopId,
        productId: req.params.productId,
        priceEGP: req.body?.priceEGP !== undefined ? Number(req.body.priceEGP) : undefined,
        isAvailable:
          req.body?.isAvailable !== undefined ? Boolean(req.body.isAvailable) : undefined,
        stockDelta: req.body?.stockDelta !== undefined ? Number(req.body.stockDelta) : undefined,
        lowStockThreshold:
          req.body?.lowStockThreshold !== undefined
            ? Number(req.body.lowStockThreshold)
            : undefined,
        reason: req.body?.reason,
        actorName: shop?.ownerName || 'صاحب المحل',
      });
      res.json({ item: updated });
    }),
  );

  app.post(
    '/api/shop/:shopId/catalog',
    requireOpsSession,
    requireShopAccess,
    asyncHandler(async (req, res) => {
      const shopId = req.params.shopId;
      const shops = await commerceService.getShops();
      const shop = shops.find((s) => s.id === shopId);
      const item = await commerceService.addProductToShop({
        shopId,
        name: req.body?.name,
        brand: req.body?.brand,
        category: req.body?.category as ProductCategory,
        packSize: req.body?.packSize,
        unit: req.body?.unit,
        barcode: req.body?.barcode,
        isWeighted: req.body?.isWeighted,
        scalePlu: req.body?.scalePlu,
        description: req.body?.description,
        priceEGP: Number(req.body?.priceEGP),
        initialStock: Number(req.body?.initialStock),
        lowStockThreshold:
          req.body?.lowStockThreshold !== undefined
            ? Number(req.body.lowStockThreshold)
            : undefined,
        actorName: shop?.ownerName || 'صاحب المحل',
      });
      res.status(201).json({ item });
    }),
  );

  app.post(
    '/api/shop/:shopId/daily-entries',
    requireOpsSession,
    requireShopAccess,
    asyncHandler(async (req, res) => {
      const shopId = req.params.shopId;
      const shops = await commerceService.getShops();
      const shop = shops.find((s) => s.id === shopId);
      const entry = await commerceService.addShopDailyEntry({
        shopId,
        type: req.body?.type as ShopDailyEntryType,
        category: req.body?.category,
        description: req.body?.description,
        amountEGP: Number(req.body?.amountEGP),
        relatedProductId: req.body?.relatedProductId,
        quantityRestocked:
          req.body?.quantityRestocked !== undefined
            ? Number(req.body.quantityRestocked)
            : undefined,
        createdBy: shop?.ownerName || 'صاحب المحل',
      });
      res.status(201).json({ entry });
    }),
  );

  app.post(
    '/api/shop/:shopId/pos-sale',
    requireOpsSession,
    requireShopAccess,
    asyncHandler(async (req, res) => {
      const shopId = req.params.shopId;
      const shops = await commerceService.getShops();
      const shop = shops.find((s) => s.id === shopId);
      const result = await commerceService.recordPosOfflineSale({
        shopId,
        items: req.body?.items,
        deductInventory: Boolean(req.body?.deductInventory),
        note: req.body?.note,
        createdBy: shop?.ownerName || 'كاشير المحل',
      });
      res.status(201).json(result);
    }),
  );

  app.post(
    '/api/shop/:shopId/orders/:orderNumber/handover-volunteer',
    requireOpsSession,
    requireShopAccess,
    asyncHandler(async (req, res) => {
      const shopId = req.params.shopId;
      const shops = await commerceService.getShops();
      const shop = shops.find((s) => s.id === shopId);
      const order = await commerceService.shopHandoverOrderToVolunteer({
        shopId,
        orderNumber: req.params.orderNumber,
        actorName: shop?.ownerName || 'صاحب المحل',
      });
      res.json({ order });
    }),
  );

  app.post(
    '/api/shop/:shopId/orders/:orderNumber/confirm-remittance',
    requireOpsSession,
    requireShopAccess,
    asyncHandler(async (req, res) => {
      const shopId = req.params.shopId;
      const shops = await commerceService.getShops();
      const shop = shops.find((s) => s.id === shopId);
      const order = await commerceService.shopConfirmRemittanceReceipt({
        shopId,
        orderNumber: req.params.orderNumber,
        confirmedBy: shop?.ownerName || 'صاحب المحل',
        note: typeof req.body?.note === 'string' ? req.body.note : undefined,
      });
      res.json({ order });
    }),
  );

  app.post(
    '/api/shop/:shopId/staff',
    requireOpsSession,
    requireShopAccess,
    asyncHandler(async (req, res) => {
      const staff = await commerceService.upsertShopStaff({
        shopId: req.params.shopId,
        staffId: req.body?.staffId,
        name: req.body?.name,
        shiftLabel: req.body?.shiftLabel,
        deviceLabel: req.body?.deviceLabel,
        roleTier: req.body?.roleTier as ShopStaffRole,
        permissions: req.body?.permissions as ShopStaffPermissions,
        isActive: req.body?.isActive !== undefined ? Boolean(req.body.isActive) : true,
      });
      res.json({ staff });
    }),
  );

  app.post(
    '/api/shop/:shopId/staff/:staffId/passcode',
    requireOpsSession,
    requireShopAccess,
    asyncHandler(async (req, res) => {
      const staff = await commerceService.setShopStaffPasscode({
        shopId: req.params.shopId,
        staffId: req.params.staffId,
        passcode: req.body?.passcode,
      });
      res.json({ staff });
    }),
  );

  app.post(
    '/api/shop/:shopId/shifts/:shiftId/force-close',
    requireOpsSession,
    requireShopAccess,
    asyncHandler(async (req, res) => {
      const shops = await commerceService.getShops();
      const shop = shops.find((s) => s.id === req.params.shopId);
      const shift = await commerceService.closeShopShift({
        shopId: req.params.shopId,
        shiftId: req.params.shiftId,
        declaredClosingCashEGP:
          req.body?.declaredClosingCashEGP !== undefined
            ? Number(req.body.declaredClosingCashEGP)
            : undefined,
        closingNote: req.body?.closingNote || 'إغلاق إجباري من صاحب المحل',
        closedBy: shop?.ownerName || 'صاحب المحل',
        isForceClose: true,
      });
      res.json({ shift });
    }),
  );

  app.post(
    '/api/shop/:shopId/qr/regenerate',
    requireOpsSession,
    requireShopAccess,
    asyncHandler(async (req, res) => {
      const posConfig = await commerceService.regenerateShopQrKey(req.params.shopId);
      res.json({ posConfig });
    }),
  );

  app.post(
    '/api/shop/:shopId/qr/concurrency',
    requireOpsSession,
    requireShopAccess,
    asyncHandler(async (req, res) => {
      const posConfig = await commerceService.updateShopMaxConcurrentSessions(
        req.params.shopId,
        Number(req.body?.maxConcurrentSessions),
      );
      res.json({ posConfig });
    }),
  );

  // --- Standalone Printed-QR Shop Live POS & Shift Staff Routes ---
  app.get(
    '/api/pos/:shopId/gate',
    asyncHandler(async (req, res) => {
      const qrKey = typeof req.query.k === 'string' ? req.query.k : '';
      const gate = await commerceService.verifyShopQrGate(req.params.shopId, qrKey);
      res.json(gate);
    }),
  );

  app.post(
    '/api/pos/:shopId/login',
    asyncHandler(async (req, res) => {
      const result = await commerceService.loginAndOpenShift({
        shopId: req.params.shopId,
        qrKey: String(req.body?.qrKey ?? ''),
        staffId: String(req.body?.staffId ?? ''),
        passcode: String(req.body?.passcode ?? ''),
        deviceId: String(req.body?.deviceId ?? ''),
        openingCashEGP:
          req.body?.openingCashEGP !== undefined ? Number(req.body.openingCashEGP) : 0,
      });

      const token = signPosToken({
        tokenKind: 'pos_staff',
        shopId: req.params.shopId,
        staffId: result.staff.id,
        shiftId: result.shift.id,
        tokenVersion: result.tokenVersion,
        deviceId: result.shift.deviceId,
        exp: Date.now() + TOKEN_TTL_MS,
      });

      res.json({
        token,
        staff: result.staff,
        shift: result.shift,
      });
    }),
  );

  app.get(
    '/api/pos/:shopId/workspace',
    requirePosSession,
    asyncHandler(async (req, res) => {
      const pos = req.posSession!;
      const workspace = await commerceService.getLivePosWorkspace(
        req.params.shopId,
        pos.staff.id,
        pos.shift.id,
      );
      res.json(workspace);
    }),
  );

  app.post(
    '/api/pos/:shopId/pos-sale',
    requirePosSession,
    requirePosPermission('canPosSell'),
    asyncHandler(async (req, res) => {
      const pos = req.posSession!;
      const result = await commerceService.recordPosOfflineSale({
        shopId: req.params.shopId,
        items: req.body?.items,
        deductInventory: Boolean(req.body?.deductInventory),
        note: req.body?.note,
        createdBy: `${pos.staff.name} (${pos.staff.shiftLabel})`,
        shiftId: pos.shift.id,
        staffId: pos.staff.id,
        staffName: pos.staff.name,
      });
      res.status(201).json(result);
    }),
  );

  app.post(
    '/api/pos/:shopId/orders/:orderNumber/status',
    requirePosSession,
    requirePosPermission('canManageOnlineOrders'),
    asyncHandler(async (req, res) => {
      const pos = req.posSession!;
      const nextStatus = req.body?.nextStatus as OrderStatus;
      if (nextStatus === 'cancelled' && !pos.staff.permissions.canModifyOrCancelOrders) {
        throw new DomainError(
          'ممنوع: إلغاء أو رفض الطلبات يتطلب صلاحية تعديل الطلبات (المسؤول الأعلى)',
          403,
        );
      }
      const order = await commerceService.shopUpdateOrderStatus({
        shopId: req.params.shopId,
        orderNumber: req.params.orderNumber,
        nextStatus,
        reason: req.body?.reason,
        actorName: `${pos.staff.name} (${pos.staff.shiftLabel})`,
        actorRole: 'shop_owner',
      });
      await commerceService.incrementShiftOnlineHandled(req.params.shopId, pos.shift.id);
      res.json({ order });
    }),
  );

  app.post(
    '/api/pos/:shopId/orders/:orderNumber/handover-volunteer',
    requirePosSession,
    requirePosPermission('canManageOnlineOrders'),
    asyncHandler(async (req, res) => {
      const pos = req.posSession!;
      const order = await commerceService.shopHandoverOrderToVolunteer({
        shopId: req.params.shopId,
        orderNumber: req.params.orderNumber,
        actorName: `${pos.staff.name} (${pos.staff.shiftLabel})`,
        shiftId: pos.shift.id,
      });
      res.json({ order });
    }),
  );

  app.post(
    '/api/pos/:shopId/orders/:orderNumber/confirm-remittance',
    requirePosSession,
    requirePosPermission('canManageOnlineOrders'),
    asyncHandler(async (req, res) => {
      const pos = req.posSession!;
      const order = await commerceService.shopConfirmRemittanceReceipt({
        shopId: req.params.shopId,
        orderNumber: req.params.orderNumber,
        confirmedBy: `${pos.staff.name} (${pos.staff.shiftLabel})`,
        shiftId: pos.shift.id,
        note: typeof req.body?.note === 'string' ? req.body.note : undefined,
      });
      res.json({ order });
    }),
  );

  app.post(
    '/api/pos/:shopId/orders/:orderNumber/propose-modification',
    requirePosSession,
    requirePosPermission('canModifyOrCancelOrders'),
    asyncHandler(async (req, res) => {
      const pos = req.posSession!;
      const order = await commerceService.proposeOrderModification({
        shopId: req.params.shopId,
        orderNumber: req.params.orderNumber,
        type: req.body?.type as OrderModificationRequest['type'],
        targetItemId: req.body?.targetItemId,
        proposedProductId: req.body?.proposedProductId,
        proposedQuantity:
          req.body?.proposedQuantity !== undefined ? Number(req.body.proposedQuantity) : undefined,
        proposedUnitPriceEGP:
          req.body?.proposedUnitPriceEGP !== undefined
            ? Number(req.body.proposedUnitPriceEGP)
            : undefined,
        reason: req.body?.reason,
        actorName: `${pos.staff.name} (${pos.staff.shiftLabel})`,
      });
      res.json({ order });
    }),
  );

  app.post(
    '/api/pos/:shopId/orders/:orderNumber/record-customer-approval',
    requirePosSession,
    requirePosPermission('canModifyOrCancelOrders'),
    asyncHandler(async (req, res) => {
      const pos = req.posSession!;
      const orderCheck = await commerceService.getOrderByNumber(req.params.orderNumber);
      if (orderCheck.shopId !== req.params.shopId) {
        throw new DomainError('لا تملك صلاحية تعديل طلب خاص بمحل آخر', 403);
      }
      const decision = req.body?.decision === 'approved' ? 'approved' : 'rejected';
      const order = await commerceService.resolveOrderModification({
        orderNumber: req.params.orderNumber,
        decision,
        resolutionChannel: 'phone_recorded_by_shop',
        resolutionNote: req.body?.note || 'تأكيد هاتفي مسجل بواسطة كاشير المحل',
        actorRole: 'shop_owner',
        actorName: pos.staff.name,
      });
      res.json({ order });
    }),
  );

  app.post(
    '/api/pos/:shopId/catalog',
    requirePosSession,
    requirePosPermission('canAddProducts'),
    asyncHandler(async (req, res) => {
      const pos = req.posSession!;
      const item = await commerceService.addProductToShop({
        shopId: req.params.shopId,
        name: req.body?.name,
        brand: req.body?.brand,
        category: req.body?.category as ProductCategory,
        packSize: req.body?.packSize,
        unit: req.body?.unit,
        barcode: req.body?.barcode,
        isWeighted: req.body?.isWeighted,
        scalePlu: req.body?.scalePlu,
        description: req.body?.description,
        priceEGP: Number(req.body?.priceEGP),
        initialStock: Number(req.body?.initialStock),
        lowStockThreshold:
          req.body?.lowStockThreshold !== undefined
            ? Number(req.body.lowStockThreshold)
            : undefined,
        actorName: pos.staff.name,
      });
      res.status(201).json({ item });
    }),
  );

  app.patch(
    '/api/pos/:shopId/catalog/:productId',
    requirePosSession,
    requirePosPermission('canAdjustPricesOrStock'),
    asyncHandler(async (req, res) => {
      const pos = req.posSession!;
      const updated = await commerceService.updateShopProductListing({
        shopId: req.params.shopId,
        productId: req.params.productId,
        priceEGP: req.body?.priceEGP !== undefined ? Number(req.body.priceEGP) : undefined,
        isAvailable:
          req.body?.isAvailable !== undefined ? Boolean(req.body.isAvailable) : undefined,
        stockDelta: req.body?.stockDelta !== undefined ? Number(req.body.stockDelta) : undefined,
        lowStockThreshold:
          req.body?.lowStockThreshold !== undefined
            ? Number(req.body.lowStockThreshold)
            : undefined,
        reason: req.body?.reason,
        actorName: pos.staff.name,
      });
      res.json({ item: updated });
    }),
  );

  app.post(
    '/api/pos/:shopId/shifts/:shiftId/close',
    requirePosSession,
    asyncHandler(async (req, res) => {
      const pos = req.posSession!;
      const isSelfClose = req.params.shiftId === pos.shift.id;
      if (!isSelfClose && !pos.staff.permissions.canForceCloseShifts) {
        throw new DomainError(
          'ممنوع: إغلاق وردية موظف آخر متاح فقط للمسؤول الأعلى للوردية أو صاحب المحل',
          403,
        );
      }
      const shift = await commerceService.closeShopShift({
        shopId: req.params.shopId,
        shiftId: req.params.shiftId,
        declaredClosingCashEGP:
          req.body?.declaredClosingCashEGP !== undefined
            ? Number(req.body.declaredClosingCashEGP)
            : undefined,
        closingNote: req.body?.closingNote,
        closedBy: isSelfClose ? pos.staff.name : `${pos.staff.name} (إغلاق مشرف)`,
        isForceClose: !isSelfClose,
      });
      res.json({ shift });
    }),
  );

  // --- Role-Protected Delivery Volunteer Routes ---
  app.get(
    '/api/volunteer/:volunteerId/dashboard',
    requireOpsSession,
    requireVolunteerAccess,
    asyncHandler(async (req, res) => {
      const volunteerId = req.params.volunteerId;
      const [ordersData, statement, rules] = await Promise.all([
        commerceService.getVolunteerOrders(volunteerId),
        commerceService.getVolunteerStatement(volunteerId),
        commerceService.getDistributionRules(),
      ]);
      res.json({ ...ordersData, statement, rules });
    }),
  );

  app.post(
    '/api/volunteer/:volunteerId/orders/:orderNumber/claim',
    requireOpsSession,
    requireVolunteerAccess,
    asyncHandler(async (req, res) => {
      const order = await commerceService.volunteerClaimOrder({
        volunteerId: req.params.volunteerId,
        orderNumber: req.params.orderNumber,
      });
      res.json({ order });
    }),
  );

  app.post(
    '/api/volunteer/:volunteerId/orders/:orderNumber/status',
    requireOpsSession,
    requireVolunteerAccess,
    asyncHandler(async (req, res) => {
      const rawRem = req.body?.remittance;
      const remittance =
        rawRem && typeof rawRem === 'object' && rawRem.mode
          ? {
              mode: rawRem.mode as CashRemittanceMode,
              shopTransferChannel: rawRem.shopTransferChannel as RemittanceChannel | undefined,
              platformTransferChannel: rawRem.platformTransferChannel as
                | RemittanceChannel
                | undefined,
              instapayReference:
                typeof rawRem.instapayReference === 'string'
                  ? rawRem.instapayReference
                  : undefined,
              note: typeof rawRem.note === 'string' ? rawRem.note : undefined,
            }
          : undefined;

      const order = await commerceService.volunteerUpdateDeliveryStatus({
        volunteerId: req.params.volunteerId,
        orderNumber: req.params.orderNumber,
        nextDeliveryStatus: req.body?.nextDeliveryStatus as DeliveryStatus,
        collectedAmountEGP:
          req.body?.collectedAmountEGP !== undefined
            ? Number(req.body.collectedAmountEGP)
            : undefined,
        discrepancyNote: req.body?.discrepancyNote,
        failureReason: req.body?.failureReason,
        remittance,
      });
      res.json({ order });
    }),
  );

  app.post(
    '/api/volunteer/:volunteerId/orders/:orderNumber/remittance',
    requireOpsSession,
    requireVolunteerAccess,
    asyncHandler(async (req, res) => {
      const order = await commerceService.volunteerSubmitRemittance({
        volunteerId: req.params.volunteerId,
        orderNumber: req.params.orderNumber,
        mode: req.body?.mode as CashRemittanceMode,
        shopTransferChannel: req.body?.shopTransferChannel as RemittanceChannel | undefined,
        platformTransferChannel: req.body?.platformTransferChannel as
          | RemittanceChannel
          | undefined,
        instapayReference:
          typeof req.body?.instapayReference === 'string'
            ? req.body.instapayReference
            : undefined,
        note: typeof req.body?.note === 'string' ? req.body.note : undefined,
      });
      res.json({ order });
    }),
  );

  // --- Role-Protected Super Admin Routes ---
  app.get(
    '/api/admin/overview',
    requireOpsSession,
    requireAdminAccess,
    asyncHandler(async (req, res) => {
      const filters = {
        shopId: typeof req.query.shopId === 'string' ? req.query.shopId : undefined,
        volunteerId: typeof req.query.volunteerId === 'string' ? req.query.volunteerId : undefined,
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
        dateFrom: typeof req.query.dateFrom === 'string' ? req.query.dateFrom : undefined,
        dateTo: typeof req.query.dateTo === 'string' ? req.query.dateTo : undefined,
      };
      const [
        shops,
        volunteers,
        customers,
        orders,
        analytics,
        rules,
        shopAStatement,
        shopBStatement,
        vol1Statement,
        vol2Statement,
      ] = await Promise.all([
        commerceService.getShops(),
        commerceService.getVolunteers(),
        commerceService.getDemoCustomers(),
        commerceService.getAdminOrders(filters),
        commerceService.getAnalytics(filters),
        commerceService.getDistributionRules(),
        commerceService.getShopStatement('shop_a'),
        commerceService.getShopStatement('shop_b'),
        commerceService.getVolunteerStatement('vol_1'),
        commerceService.getVolunteerStatement('vol_2'),
      ]);
      res.json({
        shops,
        volunteers,
        customers,
        orders,
        analytics,
        rules,
        shopStatements: [shopAStatement, shopBStatement],
        volunteerStatements: [vol1Statement, vol2Statement],
      });
    }),
  );

  app.post(
    '/api/admin/orders/:orderNumber/assign-volunteer',
    requireOpsSession,
    requireAdminAccess,
    asyncHandler(async (req, res) => {
      const order = await commerceService.assignVolunteer({
        orderNumber: req.params.orderNumber,
        volunteerId: req.body?.volunteerId,
        reason: req.body?.reason,
        actorName: 'الإدارة المركزية',
        actorRole: 'super_admin',
      });
      res.json({ order });
    }),
  );

  app.post(
    '/api/admin/orders/:orderNumber/settle',
    requireOpsSession,
    requireAdminAccess,
    asyncHandler(async (req, res) => {
      const party = req.body?.party as 'shop' | 'volunteer' | 'both';
      if (!['shop', 'volunteer', 'both'].includes(party)) {
        throw new DomainError('جهة التسوية غير صالحة');
      }
      const order = await commerceService.settleOrderParty({
        orderNumber: req.params.orderNumber,
        party,
        actorName: 'الإدارة المركزية',
      });
      res.json({ order });
    }),
  );

  app.post(
    '/api/admin/orders/:orderNumber/confirm-remittance',
    requireOpsSession,
    requireAdminAccess,
    asyncHandler(async (req, res) => {
      const target = req.body?.target as 'from_shop' | 'from_volunteer' | 'full';
      if (!['from_shop', 'from_volunteer', 'full'].includes(target)) {
        throw new DomainError('جهة التحصيل غير صالحة');
      }
      const order = await commerceService.adminConfirmRemittance({
        orderNumber: req.params.orderNumber,
        target,
        actorName: 'الإدارة المركزية',
        settleVolunteerShareToo: Boolean(req.body?.settleVolunteerShareToo),
      });
      res.json({ order });
    }),
  );

  app.put(
    '/api/admin/distribution-rules',
    requireOpsSession,
    requireAdminAccess,
    asyncHandler(async (req, res) => {
      const rules = await commerceService.updateDistributionRules(req.body ?? {});
      res.json({ rules });
    }),
  );

  app.post(
    '/api/admin/reset-demo',
    requireOpsSession,
    requireAdminAccess,
    asyncHandler(async (_req, res) => {
      await commerceService.resetDemoData();
      res.json({ ok: true, message: 'تمت إعادة ضبط البيانات التجريبية بنجاح' });
    }),
  );

  app.post(
    '/api/admin/run-verification-suite',
    requireOpsSession,
    requireAdminAccess,
    asyncHandler(async (_req, res) => {
      const result = await executeMandatoryVerificationSuite();
      res.json(result);
    }),
  );

  // --- API Error Handler ---
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof DomainError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ داخلي غير متوقع في الخادم' });
  });

  // --- Vite Dev / Prod Static Serving ---
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.use((_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  return app;
}

const PORT = 3000;
createApp()
  .then((app) => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Local Commerce OS listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
