export type UserRole = 'customer' | 'shop_owner' | 'delivery_volunteer' | 'super_admin';

export type OrderStatus =
  | 'new'
  | 'confirmed'
  | 'preparing'
  | 'ready'
  | 'completed'
  | 'cancelled';

export type DeliveryStatus =
  | 'unassigned'
  | 'assigned'
  | 'heading_to_shop'
  | 'picked_up'
  | 'heading_to_customer'
  | 'delivered'
  | 'delivery_failed';

export type SettlementStatus =
  | 'uncollected'
  | 'collected'
  | 'shop_unsettled'
  | 'shop_settled'
  | 'volunteer_settled'
  | 'fully_settled';

export type CashRemittanceMode =
  | 'full_to_shop'
  | 'split_shop_and_courier'
  | 'full_to_platform_instapay';

export type RemittanceChannel = 'cash' | 'instapay';

export type RemittanceStatus =
  | 'pending_shop_confirmation'
  | 'pending_platform_confirmation'
  | 'settled';

export interface OrderRemittanceRecord {
  mode: CashRemittanceMode;
  shopTransferChannel?: RemittanceChannel;
  platformTransferChannel?: RemittanceChannel;
  amountToShopEGP: number;
  amountWithCourierForPlatformEGP: number;
  amountDirectToPlatformEGP: number;
  amountPlatformAtShopEGP: number;
  instapayReference?: string;
  note?: string;
  status: RemittanceStatus;
  submittedBy: string;
  submittedAt: string;
  shopConfirmedAt?: string;
  shopConfirmedBy?: string;
  shopConfirmedShiftId?: string;
  platformConfirmedAt?: string;
  platformConfirmedBy?: string;
}

export type ProductCategory =
  | 'الأرز والسكر والزيوت'
  | 'المكرونة والدقيق والبقوليات'
  | 'الشاي والقهوة'
  | 'اللبن والجبن والزبادي'
  | 'البيض والمعلبات'
  | 'المياه والعصائر والمشروبات'
  | 'سناكس وحلويات وبسكويت'
  | 'مخبوزات ومعجنات'
  | 'مجمدات ولحوم ودواجن'
  | 'المنظفات'
  | 'الصابون والشامبو'
  | 'المناديل والورقيات'
  | 'دخان وتبغ'
  | 'أدوات منزلية ومكتبية'
  | 'أخرى / منتجات عامة'
  | (string & {});

export interface Shop {
  id: string;
  code: 'A' | 'B';
  name: string;
  ownerName: string;
  phone: string;
  address: string;
  area: string;
  defaultDeliveryFeeEGP: number;
  imageUrl: string;
  isActive: boolean;
}

export interface MasterProduct {
  id: string;
  sku: string;
  barcode?: string;
  isWeighted?: boolean;
  scalePlu?: string;
  name: string;
  brand: string;
  category: ProductCategory;
  packSize: string;
  unit: string;
  description: string;
}

export interface ShopProductListing {
  id: string;
  shopId: string;
  productId: string;
  priceEGP: number;
  priceUpdatedAt: string;
  priceSourceNote: string;
  isAvailable: boolean;
  currentStock: number;
  reservedStock: number;
  lowStockThreshold: number;
}

export interface CatalogItemView {
  listingId: string;
  shopId: string;
  productId: string;
  sku: string;
  barcode?: string;
  isWeighted?: boolean;
  scalePlu?: string;
  name: string;
  brand: string;
  category: ProductCategory;
  packSize: string;
  unit: string;
  description: string;
  priceEGP: number;
  priceUpdatedAt: string;
  priceSourceNote: string;
  isAvailable: boolean;
  currentStock: number;
  reservedStock: number;
  availableToSell: number;
  lowStockThreshold: number;
  isLowStock: boolean;
}

export type InventoryMovementType =
  | 'initial_seed'
  | 'reserve'
  | 'release_reservation'
  | 'deduct_on_fulfill'
  | 'return_to_stock'
  | 'manual_add'
  | 'manual_deduct'
  | 'purchase_restock'
  | 'pos_offline_sale';

export interface InventoryMovement {
  id: string;
  shopId: string;
  productId: string;
  productName: string;
  type: InventoryMovementType;
  quantityDelta: number;
  reservedDelta: number;
  stockAfter: number;
  reservedAfter: number;
  orderNumber?: string;
  actorRole: UserRole;
  actorName: string;
  reason: string;
  createdAt: string;
}

export interface CustomerProfile {
  id: string;
  name: string;
  phone: string;
  address: string;
  area: string;
  createdAt: string;
}

export interface VolunteerProfile {
  id: string;
  name: string;
  phone: string;
  vehicleType: string;
  area: string;
  isActive: boolean;
}

export interface OrderItem {
  id: string;
  productId: string;
  productName: string;
  brand: string;
  packSize: string;
  unit: string;
  quantity: number;
  unitPriceEGP: number;
  lineTotalEGP: number;
  status: 'active' | 'unavailable_removed' | 'substituted';
  originalProductId?: string;
  originalProductName?: string;
}

export interface OrderModificationRequest {
  id: string;
  type: 'substitute_item' | 'adjust_quantity' | 'remove_unavailable' | 'price_adjustment';
  targetItemId: string;
  targetProductName: string;
  proposedProductId?: string;
  proposedProductName?: string;
  proposedPackSize?: string;
  proposedUnit?: string;
  proposedQuantity?: number;
  proposedUnitPriceEGP?: number;
  reason: string;
  status: 'pending_customer' | 'approved' | 'rejected';
  requestedBy: string;
  requestedAt: string;
  resolvedAt?: string;
  resolutionChannel?: 'customer_app' | 'phone_recorded_by_shop';
  resolutionNote?: string;
}

export interface OrderTimelineEvent {
  id: string;
  timestamp: string;
  actorRole: UserRole;
  actorName: string;
  eventType: string;
  title: string;
  details?: string;
}

export interface OrderFinancialRecord {
  itemsTotalEGP: number;
  deliveryFeeEGP: number;
  customerExpectedTotalEGP: number;
  collectedAmountEGP: number;
  collectionDiscrepancyEGP: number;
  discrepancyNote?: string;
  shopDueEGP: number;
  volunteerShareEGP: number;
  operatingCostEGP: number;
  platformRevenueEGP: number;
  settlementStatus: SettlementStatus;
  collectedAt?: string;
  shopSettledAt?: string;
  volunteerSettledAt?: string;
  fullySettledAt?: string;
  remittance?: OrderRemittanceRecord;
}

export interface OrderCustomerRating {
  overallRating: number;
  shopRating?: number;
  deliveryRating?: number;
  complimentTags: string[];
  comment?: string;
  customerName: string;
  submittedAt: string;
}

export interface Order {
  id: string;
  orderNumber: string;
  shopId: string;
  shopName: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  deliveryAddress: string;
  deliveryLocation?: { lat: number; lng: number };
  deliveryNotes: string;
  paymentMethod: 'cash_on_delivery';
  status: OrderStatus;
  deliveryStatus: DeliveryStatus;
  volunteerId?: string;
  volunteerName?: string;
  items: OrderItem[];
  pendingModification?: OrderModificationRequest;
  modificationHistory: OrderModificationRequest[];
  financials: OrderFinancialRecord;
  timeline: OrderTimelineEvent[];
  stockState: 'reserved' | 'deducted' | 'released' | 'returned';
  unavailableItemCount: number;
  cancellationReason?: string;
  deliveryFailureReason?: string;
  rating?: OrderCustomerRating;
  createdAt: string;
  confirmedAt?: string;
  preparingAt?: string;
  readyAt?: string;
  pickedUpAt?: string;
  deliveredAt?: string;
  cancelledAt?: string;
}

export type ShopDailyEntryType = 'expense' | 'purchase' | 'offline_sale';

export interface ShopDailyEntry {
  id: string;
  shopId: string;
  type: ShopDailyEntryType;
  category: string;
  description: string;
  amountEGP: number;
  relatedProductId?: string;
  relatedProductName?: string;
  quantityRestocked?: number;
  shiftId?: string;
  staffId?: string;
  staffName?: string;
  entryDate: string;
  createdBy: string;
  createdAt: string;
}

export type ShopStaffRole = 'shift_supervisor' | 'cashier_staff';

export interface ShopStaffPermissions {
  canPosSell: boolean;
  canManageOnlineOrders: boolean;
  canModifyOrCancelOrders: boolean;
  canAddProducts: boolean;
  canAdjustPricesOrStock: boolean;
  canForceCloseShifts: boolean;
}

export interface ShopStaffAccount {
  id: string;
  shopId: string;
  name: string;
  shiftLabel: string;
  deviceLabel: string;
  roleTier: ShopStaffRole;
  permissions: ShopStaffPermissions;
  passcodeHash: string;
  passcodeSalt: string;
  isActive: boolean;
  tokenVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface PublicShopStaffView {
  id: string;
  shopId: string;
  name: string;
  shiftLabel: string;
  deviceLabel: string;
  roleTier: ShopStaffRole;
  permissions: ShopStaffPermissions;
  hasPasscode: boolean;
  isActive: boolean;
  tokenVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface ShopPosQrConfig {
  shopId: string;
  qrAccessKey: string;
  maxConcurrentSessions: number;
  updatedAt: string;
}

export interface ShopShiftSession {
  id: string;
  shopId: string;
  staffId: string;
  staffName: string;
  shiftLabel: string;
  deviceLabel: string;
  roleTier: ShopStaffRole;
  deviceId: string;
  status: 'open' | 'closed' | 'force_closed';
  openedAt: string;
  openingCashEGP: number;
  posSalesCount: number;
  posSalesTotalEGP: number;
  onlineOrdersHandledCount: number;
  expectedCashEGP: number;
  declaredClosingCashEGP?: number;
  cashVarianceEGP?: number;
  closingNote?: string;
  closedAt?: string;
  closedBy?: string;
}

export interface DistributionRules {
  defaultDeliveryFeeEGP: number;
  volunteerShareMode: 'percentage' | 'fixed';
  volunteerShareValue: number; // 75 (%) or 15 (EGP)
  operatingCostPerOrderEGP: number;
  platformCommissionPercent: number; // default 0 so shop gets 100% of items unless configured
  updatedAt: string;
}

export interface AuthStateRecord {
  adminPasscodeHash?: string;
  adminPasscodeSalt?: string;
}

export interface CommerceDatabase {
  version: number;
  nextOrderSeq: number;
  shops: Shop[];
  masterProducts: MasterProduct[];
  shopListings: ShopProductListing[];
  inventoryMovements: InventoryMovement[];
  customers: CustomerProfile[];
  volunteers: VolunteerProfile[];
  orders: Order[];
  shopDailyEntries: ShopDailyEntry[];
  shopPosConfigs: ShopPosQrConfig[];
  shopStaffAccounts: ShopStaffAccount[];
  shopShiftSessions: ShopShiftSession[];
  distributionRules: DistributionRules;
  auth: AuthStateRecord;
}

export interface SimulatedActor {
  role: UserRole;
  actorId: string;
  label: string;
}

export interface ShopStatement {
  shopId: string;
  shopName: string;
  completedOrdersCount: number;
  platformSalesGMV: number;
  totalShopDueEGP: number;
  settledToShopEGP: number;
  pendingSettlementToShopEGP: number;
  platformReceivableFromShopEGP: number;
  pendingShopRemittanceConfirmationsCount: number;
  netBalanceWithShopEGP: number;
  offlineSalesEGP: number;
  totalPurchasesEGP: number;
  totalExpensesEGP: number;
  estimatedNetCashFlowEGP: number;
  averageRating: number | null;
  ratingsCount: number;
  orderRows: Array<{
    orderNumber: string;
    createdAt: string;
    status: OrderStatus;
    itemsTotalEGP: number;
    shopDueEGP: number;
    collectedAmountEGP: number;
    settlementStatus: SettlementStatus;
    remittance?: OrderRemittanceRecord;
  }>;
}

export interface VolunteerStatement {
  volunteerId: string;
  volunteerName: string;
  assignedCount: number;
  deliveredCount: number;
  failedCount: number;
  totalCashCollectedEGP: number;
  totalDeliveryFeesEGP: number;
  totalVolunteerEarningsEGP: number;
  settledEarningsEGP: number;
  pendingEarningsEGP: number;
  cashToRemitEGP: number;
  heldWithCourierForPlatformEGP: number;
  remittedToShopTotalEGP: number;
  remittedDirectInstapayEGP: number;
  averageDeliveryRating: number | null;
  ratingsCount: number;
  orderRows: Array<{
    orderNumber: string;
    shopName: string;
    customerName: string;
    deliveryStatus: DeliveryStatus;
    customerExpectedTotalEGP: number;
    collectedAmountEGP: number;
    collectionDiscrepancyEGP: number;
    deliveryFeeEGP: number;
    shopDueEGP: number;
    volunteerShareEGP: number;
    settlementStatus: SettlementStatus;
    remittance?: OrderRemittanceRecord;
    deliveredAt?: string;
    ratingScore?: number;
    ratingComment?: string;
    complimentTags?: string[];
  }>;
}

export interface AnalyticsReport {
  totalShops: number;
  totalVolunteers: number;
  totalOrders: number;
  activeOrders: number;
  completedOrders: number;
  cancelledOrders: number;
  failedDeliveryOrders: number;
  platformGMV: number;
  totalDeliveryFees: number;
  totalShopDues: number;
  totalVolunteerEarnings: number;
  totalOperatingCosts: number;
  netOperatingContribution: number;
  unsettledShopBalance: number;
  unsettledVolunteerBalance: number;
  receivableFromShopsEGP: number;
  receivableFromVolunteersEGP: number;
  totalCashDiscrepancy: number;
  avgOrderValueEGP: number;
  avgShopPrepMinutes: number;
  avgDeliveryMinutes: number;
  cancellationRatePercent: number;
  unavailableItemRatePercent: number;
  fulfillmentCostPerOrderEGP: number;
  netContributionPerOrderEGP: number;
  newCustomersCount: number;
  returningCustomersCount: number;
  averageRating: number | null;
  ratingsCount: number;
  mostActiveShop: { shopId: string; shopName: string; ordersCount: number; gmvEGP: number } | null;
  topProducts: Array<{
    productId: string;
    productName: string;
    totalQuantity: number;
    totalRevenueEGP: number;
  }>;
  shopBreakdown: Array<{
    shopId: string;
    shopName: string;
    ordersCount: number;
    completedCount: number;
    gmvEGP: number;
    avgPrepMinutes: number;
    averageRating: number | null;
    ratingsCount: number;
  }>;
}

export interface VerificationStepResult {
  step: string;
  passed: boolean;
  details: string;
}
