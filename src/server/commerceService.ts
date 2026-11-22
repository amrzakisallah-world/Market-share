import type {
  AnalyticsReport,
  AuditCategory,
  AuditLogEntry,
  BackupSnapshotInfo,
  CashRemittanceMode,
  CatalogItemView,
  CommerceDatabase,
  DeliveryStatus,
  DistributionRules,
  InventoryMovement,
  OperationalMode,
  Order,
  OrderModificationRequest,
  OrderStatus,
  OwnerOperationalMemory,
  ProductCategory,
  PublicShopStaffView,
  RemittanceChannel,
  RuntimeConfig,
  ShopDailyEntry,
  ShopDailyEntryType,
  ShopPosQrConfig,
  ShopShiftSession,
  ShopStaffPermissions,
  ShopStaffRole,
  ShopStatement,
  UserRole,
  VerificationStepResult,
  VolunteerStatement,
} from '../types/commerce.ts';
import { InMemoryStorageAdapter, type CommerceStorageAdapter } from './storage.ts';
import { AnalyticsBackupService } from './services/analyticsBackupService.ts';
import { CatalogInventoryService } from './services/catalogInventoryService.ts';
import { OrderLifecycleService } from './services/orderLifecycleService.ts';
import { PosShiftService } from './services/posShiftService.ts';
import { SettlementAccountingService } from './services/settlementAccountingService.ts';
import { DomainError } from './services/shared.ts';

export { DomainError };

export class CommerceService {
  private readonly storage: CommerceStorageAdapter;
  private readonly catalogService: CatalogInventoryService;
  private readonly orderService: OrderLifecycleService;
  private readonly posService: PosShiftService;
  private readonly settlementService: SettlementAccountingService;
  private readonly analyticsService: AnalyticsBackupService;

  constructor(storage: CommerceStorageAdapter) {
    this.storage = storage;
    this.catalogService = new CatalogInventoryService(storage);
    this.orderService = new OrderLifecycleService(storage);
    this.posService = new PosShiftService(storage, this.catalogService, this.orderService);
    this.settlementService = new SettlementAccountingService(storage);
    this.analyticsService = new AnalyticsBackupService(storage);
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

  /**
   * Returns demo quick-fill customer profiles ONLY in Experiment Mode.
   * Real customer orders added after launch never leak via this endpoint.
   */
  async getDemoCustomers() {
    const db = await this.storage.read();
    const mode = db.runtimeConfig?.mode ?? 'experiment';
    if (mode !== 'experiment') {
      return [];
    }
    return db.customers.filter((c) => c.isDemoFixture === true);
  }

  async getVolunteers() {
    const db = await this.storage.read();
    return db.volunteers;
  }

  async getRuntimeConfig(): Promise<RuntimeConfig> {
    return this.analyticsService.getRuntimeConfig();
  }

  async setRuntimeMode(mode: OperationalMode, actorName: string): Promise<RuntimeConfig> {
    return this.analyticsService.setRuntimeMode(mode, actorName);
  }

  async getOperationalMemory(): Promise<OwnerOperationalMemory> {
    return this.analyticsService.getOperationalMemory();
  }

  async getAuditLogs(options?: {
    category?: AuditCategory | 'all';
    shopId?: string;
    limit?: number;
  }): Promise<AuditLogEntry[]> {
    return this.analyticsService.getAuditLogs(options);
  }

  async createBackupSnapshot(label: string, actorName: string): Promise<BackupSnapshotInfo> {
    return this.analyticsService.createBackupSnapshot(label, actorName);
  }

  async listBackupSnapshots(): Promise<BackupSnapshotInfo[]> {
    return this.analyticsService.listBackupSnapshots();
  }

  async exportBackupPayload(actorName: string): Promise<CommerceDatabase> {
    return this.analyticsService.exportBackupPayload(actorName);
  }

  async restoreBackupFromSnapshot(filename: string, actorName: string) {
    return this.analyticsService.restoreBackupFromSnapshot(filename, actorName);
  }

  async restoreBackupFromPayload(payload: unknown, actorName: string) {
    return this.analyticsService.restoreBackupFromPayload(payload, actorName);
  }

  // --- Catalog & Inventory ---

  async getShopCatalog(shopId: string, _includeUnavailable = false): Promise<CatalogItemView[]> {
    return this.catalogService.getShopCatalog(shopId);
  }

  async getShopInventoryMovements(shopId: string): Promise<InventoryMovement[]> {
    return this.catalogService.getShopInventoryMovements(shopId);
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
    return this.catalogService.updateShopProductListing(input);
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
    return this.catalogService.addProductToShop(input);
  }

  // --- Orders & Delivery ---

  async createCustomerOrder(input: {
    shopId: string;
    customerName: string;
    customerPhone: string;
    deliveryAddress: string;
    deliveryLocation?: { lat: number; lng: number };
    deliveryNotes?: string;
    items: Array<{ productId: string; quantity: number }>;
  }): Promise<{ order: Order; accessToken: string }> {
    return this.orderService.createCustomerOrder(input);
  }

  async getOrderForAuthorizedCaller(
    orderNumber: string,
    auth: {
      accessToken?: string;
      bypassAuth?: boolean;
      shopIdScope?: string;
      volunteerIdScope?: string;
    },
  ): Promise<Order> {
    return this.orderService.getOrderForAuthorizedCaller(orderNumber, auth);
  }

  async getOrdersForShop(shopId: string): Promise<Order[]> {
    return this.orderService.getOrdersForShop(shopId);
  }

  async shopUpdateOrderStatus(input: {
    shopId: string;
    orderNumber: string;
    nextStatus: OrderStatus;
    reason?: string;
    actorName: string;
    actorRole: UserRole;
  }): Promise<Order> {
    return this.orderService.shopUpdateOrderStatus(input);
  }

  async customerCancelOrder(input: {
    orderNumber: string;
    reason: string;
    accessToken?: string;
    bypassAuth?: boolean;
  }): Promise<Order> {
    return this.orderService.customerCancelOrder(input);
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
    return this.orderService.submitOrderRating(input);
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
    return this.orderService.proposeOrderModification(input);
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
    return this.orderService.resolveOrderModification(input);
  }

  async assignVolunteer(input: {
    orderNumber: string;
    volunteerId: string;
    reason?: string;
    actorName: string;
    actorRole: UserRole;
  }): Promise<Order> {
    return this.orderService.assignVolunteer(input);
  }

  async getVolunteerOrders(volunteerId: string) {
    return this.orderService.getVolunteerOrders(volunteerId);
  }

  async volunteerClaimOrder(input: { volunteerId: string; orderNumber: string }): Promise<Order> {
    return this.orderService.volunteerClaimOrder(input);
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
    return this.orderService.volunteerUpdateDeliveryStatus(input);
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
    return this.orderService.volunteerSubmitRemittance(input);
  }

  // --- Settlements & Daily Ledger ---

  async shopConfirmRemittanceReceipt(input: {
    shopId: string;
    orderNumber: string;
    confirmedBy: string;
    shiftId?: string;
    note?: string;
  }): Promise<Order> {
    return this.settlementService.shopConfirmRemittanceReceipt(input);
  }

  async adminConfirmRemittance(input: {
    orderNumber: string;
    target: 'from_shop' | 'from_volunteer' | 'full';
    actorName: string;
    settleVolunteerShareToo?: boolean;
    overrideReason?: string;
  }): Promise<Order> {
    return this.settlementService.adminConfirmRemittance(input);
  }

  async settleOrderParty(input: {
    orderNumber: string;
    party: 'shop' | 'volunteer' | 'both';
    actorName: string;
    forceOverrideReason?: string;
  }): Promise<Order> {
    return this.settlementService.settleOrderParty(input);
  }

  async getShopDailyEntries(shopId: string): Promise<ShopDailyEntry[]> {
    return this.settlementService.getShopDailyEntries(shopId);
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
    return this.settlementService.addShopDailyEntry(input);
  }

  async getDistributionRules(): Promise<DistributionRules> {
    return this.settlementService.getDistributionRules();
  }

  async updateDistributionRules(
    input: Partial<DistributionRules>,
    actorName?: string,
  ): Promise<DistributionRules> {
    return this.settlementService.updateDistributionRules(input, actorName);
  }

  async getShopStatement(shopId: string): Promise<ShopStatement> {
    return this.settlementService.getShopStatement(shopId);
  }

  async getVolunteerStatement(volunteerId: string): Promise<VolunteerStatement> {
    return this.settlementService.getVolunteerStatement(volunteerId);
  }

  // --- POS & Multi-Shift ---

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
    return this.posService.recordPosOfflineSale(input);
  }

  async shopHandoverOrderToVolunteer(input: {
    shopId: string;
    orderNumber: string;
    actorName: string;
    shiftId?: string;
  }): Promise<Order> {
    return this.posService.shopHandoverOrderToVolunteer(input);
  }

  async incrementShiftOnlineHandled(shopId: string, shiftId?: string): Promise<void> {
    return this.posService.incrementShiftOnlineHandled(shopId, shiftId);
  }

  async getShopPosManagement(shopId: string): Promise<{
    posConfig: ShopPosQrConfig;
    staffAccounts: PublicShopStaffView[];
    shifts: ShopShiftSession[];
  }> {
    return this.posService.getShopPosManagement(shopId);
  }

  async verifyShopQrGate(shopId: string, qrKey: string) {
    return this.posService.verifyShopQrGate(shopId, qrKey);
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
    return this.posService.upsertShopStaff(input);
  }

  async setShopStaffPasscode(input: {
    shopId: string;
    staffId: string;
    passcode: string;
  }): Promise<PublicShopStaffView> {
    return this.posService.setShopStaffPasscode(input);
  }

  async regenerateShopQrKey(shopId: string): Promise<ShopPosQrConfig> {
    return this.posService.regenerateShopQrKey(shopId);
  }

  async updateShopMaxConcurrentSessions(
    shopId: string,
    maxConcurrentSessions: number,
  ): Promise<ShopPosQrConfig> {
    return this.posService.updateShopMaxConcurrentSessions(shopId, maxConcurrentSessions);
  }

  async loginAndOpenShift(input: {
    shopId: string;
    qrKey: string;
    staffId: string;
    passcode: string;
    deviceId: string;
    openingCashEGP?: number;
  }): Promise<{ staff: PublicShopStaffView; shift: ShopShiftSession; tokenVersion: number }> {
    return this.posService.loginAndOpenShift(input);
  }

  async validatePosTokenState(input: {
    shopId: string;
    staffId: string;
    shiftId: string;
    tokenVersion: number;
  }): Promise<{ staff: PublicShopStaffView; shift: ShopShiftSession } | null> {
    return this.posService.validatePosTokenState(input);
  }

  async closeShopShift(input: {
    shopId: string;
    shiftId: string;
    declaredClosingCashEGP?: number;
    closingNote?: string;
    closedBy: string;
    isForceClose: boolean;
  }): Promise<ShopShiftSession> {
    return this.posService.closeShopShift(input);
  }

  async getLivePosWorkspace(shopId: string, staffId: string, shiftId: string) {
    return this.posService.getLivePosWorkspace(shopId, staffId, shiftId);
  }

  // --- Analytics & Admin ---

  async getAdminOrders(filters?: {
    shopId?: string;
    volunteerId?: string;
    status?: string;
    dateFrom?: string;
    dateTo?: string;
  }): Promise<Order[]> {
    return this.analyticsService.getAdminOrders(filters);
  }

  async getAnalytics(filters?: {
    shopId?: string;
    volunteerId?: string;
    dateFrom?: string;
    dateTo?: string;
    status?: string;
  }): Promise<AnalyticsReport> {
    return this.analyticsService.getAnalytics(filters);
  }
}

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
    // Scenario 1: ماركت النور + المتطوع الأول (5 منتجات) + Access Token Verification
    const catalogA = await svc.getShopCatalog('shop_a');
    const fiveItemsA = catalogA.slice(0, 5).map((item) => ({ productId: item.productId, quantity: 2 }));
    const { order: ordA, accessToken: tokenA } = await svc.createCustomerOrder({
      shopId: 'shop_a',
      customerName: 'سارة عبد الرحمن',
      customerPhone: '01091112233',
      deliveryAddress: '9 شارع مصدق، الدقي',
      deliveryNotes: 'يرجى الاتصال عند الوصول',
      items: fiveItemsA,
    });

    // Ensure order cannot be viewed without token or ops role
    let idorBlocked = false;
    try {
      await svc.getOrderForAuthorizedCaller(ordA.orderNumber, { accessToken: 'wrong-token' });
    } catch {
      idorBlocked = true;
    }
    const fetchedWithToken = await svc.getOrderForAuthorizedCaller(ordA.orderNumber, {
      accessToken: tokenA,
    });
    record(
      '1-6. إنشاء طلب 5 منتجات من ماركت النور + حماية رمز المتابعة',
      ordA.items.length === 5 &&
        ordA.status === 'new' &&
        ordA.stockState === 'reserved' &&
        idorBlocked &&
        fetchedWithToken.orderNumber === ordA.orderNumber,
      `تم إنشاء ${ordA.orderNumber} بإجمالي ${ordA.financials.customerExpectedTotalEGP} ج.م ومنع الوصول دون رمز المتابعة`,
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
      remittance: { mode: 'full_to_shop', shopTransferChannel: 'cash' },
    });
    // 3-Stage Settlement Verification: shop confirms first -> admin confirms platform share
    await svc.shopConfirmRemittanceReceipt({
      shopId: 'shop_a',
      orderNumber: ordA.orderNumber,
      confirmedBy: 'الحاج محمود',
    });
    await svc.adminConfirmRemittance({
      orderNumber: ordA.orderNumber,
      target: 'from_shop',
      actorName: 'الإدارة المركزية',
      settleVolunteerShareToo: true,
    });
    const settledA = await svc.getOrderForAuthorizedCaller(ordA.orderNumber, { bypassAuth: true });
    const analyticsAfterA = await svc.getAnalytics();
    record(
      '10-17. دورة التوصيل والتحصيل والتسوية ثلاثية المراحل',
      assignedA.volunteerId === 'vol_1' &&
        pickedA.deliveryStatus === 'picked_up' &&
        headingA.deliveryStatus === 'heading_to_customer' &&
        deliveredA.status === 'completed' &&
        settledA.financials.settlementStatus === 'fully_settled' &&
        analyticsAfterA.platformGMV === ordA.financials.itemsTotalEGP,
      `حالة التسوية: ${settledA.financials.settlementStatus} | مرحلة التحقق: ${settledA.financials.remittance?.verificationStage}`,
    );

    // Concurrent Oversell Race Test
    const targetItem = catalogA[12];
    await svc.updateShopProductListing({
      shopId: 'shop_a',
      productId: targetItem.productId,
      stockDelta: -(targetItem.availableToSell - 1),
      reason: 'ضبط المخزون على قطعة واحدة لاختبار التزامن',
      actorName: 'الاختبار الآلي',
    });
    const raceResults = await Promise.allSettled([
      svc.createCustomerOrder({
        shopId: 'shop_a',
        customerName: 'عميل متزامن 1',
        customerPhone: '01000000001',
        deliveryAddress: 'عنوان اختباري أول',
        items: [{ productId: targetItem.productId, quantity: 1 }],
      }),
      svc.createCustomerOrder({
        shopId: 'shop_a',
        customerName: 'عميل متزامن 2',
        customerPhone: '01000000002',
        deliveryAddress: 'عنوان اختباري ثان',
        items: [{ productId: targetItem.productId, quantity: 1 }],
      }),
    ]);
    const raceSuccesses = raceResults.filter((r) => r.status === 'fulfilled').length;
    const raceRejects = raceResults.filter((r) => r.status === 'rejected').length;
    record(
      'منع البيع الزائد تحت الطلبات المتزامنة (Race Condition)',
      raceSuccesses === 1 && raceRejects === 1,
      `نجح طلب واحد (${raceSuccesses}) ورُفض الطلب المتعارض (${raceRejects}) مع بقاء المخزون سليمًا`,
    );

    // Scenario 2: ماركت الأمانة + المتطوع الثاني + اختلاف التحصيل
    const catalogB = await svc.getShopCatalog('shop_b');
    const itemsB = catalogB.slice(10, 15).map((item) => ({ productId: item.productId, quantity: 1 }));
    const { order: ordB } = await svc.createCustomerOrder({
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
    const expectedB = ordB.financials.customerExpectedTotalEGP;
    const deliveredB = await svc.volunteerUpdateDeliveryStatus({
      volunteerId: 'vol_2',
      orderNumber: ordB.orderNumber,
      nextDeliveryStatus: 'delivered',
      collectedAmountEGP: expectedB - 5,
      discrepancyNote: 'عجز فكة 5 جنيه عند العميل',
    });
    record(
      'سيناريو ماركت الأمانة والمتطوع الثاني + فرق التحصيل',
      deliveredB.status === 'completed' && deliveredB.financials.collectionDiscrepancyEGP === -5,
      `تم التحصيل ${deliveredB.financials.collectedAmountEGP} ج.م من أصل ${expectedB} ج.م`,
    );

    // Edge Case: Modification Approval & Rejection
    const { order: ordMod, accessToken: tokenMod } = await svc.createCustomerOrder({
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
      resolutionChannel: 'customer_app',
      actorRole: 'customer',
      actorName: 'طارق مصطفى',
      accessToken: tokenMod,
    });
    record(
      'مقترح تعديل الطلب وموافقة العميل برمز المتابعة',
      afterQtyApproved.items[0].quantity === 1 && !afterQtyApproved.pendingModification,
      `تحدثت الكمية والفاتورة إلى ${afterQtyApproved.financials.customerExpectedTotalEGP} ج.م`,
    );
  } catch (err) {
    record('خطأ غير متوقع أثناء الاختبار', false, err instanceof Error ? err.message : String(err));
  }

  return {
    allPassed: steps.every((s) => s.passed),
    steps,
  };
}
