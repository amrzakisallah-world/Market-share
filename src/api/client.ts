import type {
  AnalyticsReport,
  CashRemittanceMode,
  CustomerProfile,
  DeliveryStatus,
  DistributionRules,
  InventoryMovement,
  Order,
  OrderModificationRequest,
  OrderStatus,
  ProductCategory,
  PublicShopStaffView,
  RemittanceChannel,
  Shop,
  ShopDailyEntry,
  ShopDailyEntryType,
  ShopPosQrConfig,
  ShopShiftSession,
  ShopStaffPermissions,
  ShopStaffRole,
  ShopStatement,
  UserRole,
  VerificationStepResult,
  VolunteerProfile,
  VolunteerStatement,
} from '../types/commerce';

// Session tokens held strictly in JS memory (never localStorage)
let opsBearerToken: string | null = null;
let posBearerToken: string | null = null;

export function setOpsToken(token: string | null): void {
  opsBearerToken = token;
}

export function getOpsToken(): string | null {
  return opsBearerToken;
}

export function setPosToken(token: string | null): void {
  posBearerToken = token;
}

export function getPosToken(): string | null {
  return posBearerToken;
}

async function apiFetch<T>(
  url: string,
  options: RequestInit = {},
  authMode: boolean | 'ops' | 'pos' = false,
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const effectiveMode = authMode === true ? 'ops' : authMode;
  if (effectiveMode === 'ops' && opsBearerToken) {
    headers.set('Authorization', `Bearer ${opsBearerToken}`);
  } else if (effectiveMode === 'pos' && posBearerToken) {
    headers.set('Authorization', `Bearer ${posBearerToken}`);
  }

  const res = await fetch(url, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || `خطأ في الاتصال (${res.status})`);
  }
  return data as T;
}

export interface OpsSessionInfo {
  baseRole: 'super_admin';
  effectiveRole: UserRole;
  effectiveActorId: string;
  effectiveLabel: string;
}

export interface PublicCatalogItem {
  listingId: string;
  shopId: string;
  productId: string;
  sku: string;
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
  availableQuantity: number;
}

export const storeApi = {
  getShops: () => apiFetch<{ shops: Shop[] }>('/api/store/shops'),
  getCatalog: (shopId: string) =>
    apiFetch<{ catalog: PublicCatalogItem[] }>(`/api/store/shops/${shopId}/catalog`),
  getDemoCustomers: () => apiFetch<{ customers: CustomerProfile[] }>('/api/store/demo-customers'),
  createOrder: (payload: {
    shopId: string;
    customerName: string;
    customerPhone: string;
    deliveryAddress: string;
    deliveryLocation?: { lat: number; lng: number };
    deliveryNotes?: string;
    items: Array<{ productId: string; quantity: number }>;
  }) =>
    apiFetch<{ order: Order }>('/api/store/orders', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getOrder: (orderNumber: string) =>
    apiFetch<{ order: Order }>(`/api/store/orders/${encodeURIComponent(orderNumber)}`),
  cancelOrder: (orderNumber: string, reason: string) =>
    apiFetch<{ order: Order }>(`/api/store/orders/${encodeURIComponent(orderNumber)}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  respondToModification: (
    orderNumber: string,
    decision: 'approved' | 'rejected',
    customerName?: string,
    note?: string,
  ) =>
    apiFetch<{ order: Order }>(
      `/api/store/orders/${encodeURIComponent(orderNumber)}/modification-response`,
      {
        method: 'POST',
        body: JSON.stringify({ decision, customerName, note }),
      },
    ),
  submitRating: (
    orderNumber: string,
    payload: {
      overallRating: number;
      shopRating?: number;
      deliveryRating?: number;
      complimentTags?: string[];
      comment?: string;
    },
  ) =>
    apiFetch<{ order: Order }>(
      `/api/store/orders/${encodeURIComponent(orderNumber)}/rating`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    ),
};

export const opsAuthApi = {
  getStatus: () =>
    apiFetch<{
      needsSetup: boolean;
      envConfigured: boolean;
      authenticated: boolean;
      session: OpsSessionInfo | null;
    }>('/api/ops/auth-status', {}, true),
  claimAdmin: (passcode: string) =>
    apiFetch<{ token: string; session: OpsSessionInfo }>('/api/ops/claim-admin', {
      method: 'POST',
      body: JSON.stringify({ passcode }),
    }),
  login: (passcode: string) =>
    apiFetch<{ token: string; session: OpsSessionInfo }>('/api/ops/login', {
      method: 'POST',
      body: JSON.stringify({ passcode }),
    }),
  impersonate: (target: 'customer' | 'shop_a' | 'shop_b' | 'vol_1' | 'vol_2' | 'super_admin') =>
    apiFetch<{ token: string; session: OpsSessionInfo }>(
      '/api/ops/impersonate',
      {
        method: 'POST',
        body: JSON.stringify({ target }),
      },
      true,
    ),
};

export interface ShopDashboardData {
  shop: Shop;
  catalog: Array<{
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
  }>;
  orders: Order[];
  movements: InventoryMovement[];
  dailyEntries: ShopDailyEntry[];
  statement: ShopStatement;
  posManagement?: {
    posConfig: ShopPosQrConfig;
    staffAccounts: PublicShopStaffView[];
    shifts: ShopShiftSession[];
  };
}

export const shopApi = {
  getDashboard: (shopId: string) =>
    apiFetch<ShopDashboardData>(`/api/shop/${shopId}/dashboard`, {}, true),
  updateOrderStatus: (shopId: string, orderNumber: string, nextStatus: OrderStatus, reason?: string) =>
    apiFetch<{ order: Order }>(
      `/api/shop/${shopId}/orders/${encodeURIComponent(orderNumber)}/status`,
      {
        method: 'POST',
        body: JSON.stringify({ nextStatus, reason }),
      },
      true,
    ),
  proposeModification: (
    shopId: string,
    orderNumber: string,
    payload: {
      type: OrderModificationRequest['type'];
      targetItemId: string;
      proposedProductId?: string;
      proposedQuantity?: number;
      proposedUnitPriceEGP?: number;
      reason: string;
    },
  ) =>
    apiFetch<{ order: Order }>(
      `/api/shop/${shopId}/orders/${encodeURIComponent(orderNumber)}/propose-modification`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      true,
    ),
  recordCustomerApproval: (
    shopId: string,
    orderNumber: string,
    decision: 'approved' | 'rejected',
    note?: string,
  ) =>
    apiFetch<{ order: Order }>(
      `/api/shop/${shopId}/orders/${encodeURIComponent(orderNumber)}/record-customer-approval`,
      {
        method: 'POST',
        body: JSON.stringify({ decision, note }),
      },
      true,
    ),
  updateProduct: (
    shopId: string,
    productId: string,
    payload: {
      priceEGP?: number;
      isAvailable?: boolean;
      stockDelta?: number;
      lowStockThreshold?: number;
      reason: string;
    },
  ) =>
    apiFetch<{ item: ShopDashboardData['catalog'][number] }>(
      `/api/shop/${shopId}/catalog/${productId}`,
      {
        method: 'PATCH',
        body: JSON.stringify(payload),
      },
      true,
    ),
  addProduct: (
    shopId: string,
    payload: {
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
    },
  ) =>
    apiFetch<{ item: ShopDashboardData['catalog'][number] }>(
      `/api/shop/${shopId}/catalog`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      true,
    ),
  addDailyEntry: (
    shopId: string,
    payload: {
      type: ShopDailyEntryType;
      category: string;
      description: string;
      amountEGP: number;
      relatedProductId?: string;
      quantityRestocked?: number;
    },
  ) =>
    apiFetch<{ entry: ShopDailyEntry }>(
      `/api/shop/${shopId}/daily-entries`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      true,
    ),
  recordPosSale: (
    shopId: string,
    payload: {
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
    },
  ) =>
    apiFetch<{ entry: ShopDailyEntry; receiptNumber: string }>(
      `/api/shop/${shopId}/pos-sale`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      true,
    ),
  handoverOrderToVolunteer: (shopId: string, orderNumber: string) =>
    apiFetch<{ order: Order }>(
      `/api/shop/${shopId}/orders/${encodeURIComponent(orderNumber)}/handover-volunteer`,
      { method: 'POST' },
      true,
    ),
  confirmRemittanceReceipt: (shopId: string, orderNumber: string, note?: string) =>
    apiFetch<{ order: Order }>(
      `/api/shop/${shopId}/orders/${encodeURIComponent(orderNumber)}/confirm-remittance`,
      {
        method: 'POST',
        body: JSON.stringify({ note }),
      },
      true,
    ),
  upsertStaff: (
    shopId: string,
    payload: {
      staffId?: string;
      name: string;
      shiftLabel: string;
      deviceLabel: string;
      roleTier: ShopStaffRole;
      permissions: ShopStaffPermissions;
      isActive: boolean;
    },
  ) =>
    apiFetch<{ staff: PublicShopStaffView }>(
      `/api/shop/${shopId}/staff`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      true,
    ),
  setStaffPasscode: (shopId: string, staffId: string, passcode: string) =>
    apiFetch<{ staff: PublicShopStaffView }>(
      `/api/shop/${shopId}/staff/${encodeURIComponent(staffId)}/passcode`,
      {
        method: 'POST',
        body: JSON.stringify({ passcode }),
      },
      true,
    ),
  forceCloseShift: (
    shopId: string,
    shiftId: string,
    payload?: { declaredClosingCashEGP?: number; closingNote?: string },
  ) =>
    apiFetch<{ shift: ShopShiftSession }>(
      `/api/shop/${shopId}/shifts/${encodeURIComponent(shiftId)}/force-close`,
      {
        method: 'POST',
        body: JSON.stringify(payload ?? {}),
      },
      true,
    ),
  regenerateQr: (shopId: string) =>
    apiFetch<{ posConfig: ShopPosQrConfig }>(
      `/api/shop/${shopId}/qr/regenerate`,
      { method: 'POST' },
      true,
    ),
  updateQrConcurrency: (shopId: string, maxConcurrentSessions: number) =>
    apiFetch<{ posConfig: ShopPosQrConfig }>(
      `/api/shop/${shopId}/qr/concurrency`,
      {
        method: 'POST',
        body: JSON.stringify({ maxConcurrentSessions }),
      },
      true,
    ),
};

export interface LivePosGateInfo {
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
}

export interface LivePosWorkspaceData {
  shop: { id: string; name: string; area: string; phone: string };
  staff: PublicShopStaffView;
  shift: ShopShiftSession;
  openShiftsInShop: ShopShiftSession[];
  catalog: ShopDashboardData['catalog'];
  orders: Order[];
  shiftReceipts: ShopDailyEntry[];
}

export const livePosApi = {
  getGate: (shopId: string, qrKey: string) =>
    apiFetch<LivePosGateInfo>(
      `/api/pos/${encodeURIComponent(shopId)}/gate?k=${encodeURIComponent(qrKey)}`,
    ),
  login: (
    shopId: string,
    payload: {
      qrKey: string;
      staffId: string;
      passcode: string;
      deviceId: string;
      openingCashEGP?: number;
    },
  ) =>
    apiFetch<{ token: string; staff: PublicShopStaffView; shift: ShopShiftSession }>(
      `/api/pos/${encodeURIComponent(shopId)}/login`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    ),
  getWorkspace: (shopId: string) =>
    apiFetch<LivePosWorkspaceData>(`/api/pos/${encodeURIComponent(shopId)}/workspace`, {}, 'pos'),
  recordPosSale: (
    shopId: string,
    payload: {
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
    },
  ) =>
    apiFetch<{ entry: ShopDailyEntry; receiptNumber: string }>(
      `/api/pos/${encodeURIComponent(shopId)}/pos-sale`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      'pos',
    ),
  updateOrderStatus: (shopId: string, orderNumber: string, nextStatus: OrderStatus, reason?: string) =>
    apiFetch<{ order: Order }>(
      `/api/pos/${encodeURIComponent(shopId)}/orders/${encodeURIComponent(orderNumber)}/status`,
      {
        method: 'POST',
        body: JSON.stringify({ nextStatus, reason }),
      },
      'pos',
    ),
  handoverVolunteer: (shopId: string, orderNumber: string) =>
    apiFetch<{ order: Order }>(
      `/api/pos/${encodeURIComponent(shopId)}/orders/${encodeURIComponent(orderNumber)}/handover-volunteer`,
      { method: 'POST' },
      'pos',
    ),
  confirmRemittanceReceipt: (shopId: string, orderNumber: string, note?: string) =>
    apiFetch<{ order: Order }>(
      `/api/pos/${encodeURIComponent(shopId)}/orders/${encodeURIComponent(orderNumber)}/confirm-remittance`,
      {
        method: 'POST',
        body: JSON.stringify({ note }),
      },
      'pos',
    ),
  proposeModification: (
    shopId: string,
    orderNumber: string,
    payload: {
      type: OrderModificationRequest['type'];
      targetItemId: string;
      proposedProductId?: string;
      proposedQuantity?: number;
      proposedUnitPriceEGP?: number;
      reason: string;
    },
  ) =>
    apiFetch<{ order: Order }>(
      `/api/pos/${encodeURIComponent(shopId)}/orders/${encodeURIComponent(orderNumber)}/propose-modification`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      'pos',
    ),
  recordCustomerApproval: (
    shopId: string,
    orderNumber: string,
    decision: 'approved' | 'rejected',
    note?: string,
  ) =>
    apiFetch<{ order: Order }>(
      `/api/pos/${encodeURIComponent(shopId)}/orders/${encodeURIComponent(orderNumber)}/record-customer-approval`,
      {
        method: 'POST',
        body: JSON.stringify({ decision, note }),
      },
      'pos',
    ),
  addProduct: (
    shopId: string,
    payload: {
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
    },
  ) =>
    apiFetch<{ item: ShopDashboardData['catalog'][number] }>(
      `/api/pos/${encodeURIComponent(shopId)}/catalog`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      'pos',
    ),
  updateProduct: (
    shopId: string,
    productId: string,
    payload: {
      priceEGP?: number;
      isAvailable?: boolean;
      stockDelta?: number;
      lowStockThreshold?: number;
      reason: string;
    },
  ) =>
    apiFetch<{ item: ShopDashboardData['catalog'][number] }>(
      `/api/pos/${encodeURIComponent(shopId)}/catalog/${encodeURIComponent(productId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(payload),
      },
      'pos',
    ),
  closeShift: (
    shopId: string,
    shiftId: string,
    payload: { declaredClosingCashEGP?: number; closingNote?: string },
  ) =>
    apiFetch<{ shift: ShopShiftSession }>(
      `/api/pos/${encodeURIComponent(shopId)}/shifts/${encodeURIComponent(shiftId)}/close`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      'pos',
    ),
};

export interface VolunteerOrderView extends Order {
  shopAddress: string;
  shopPhone: string;
}

export interface VolunteerDashboardData {
  volunteer: VolunteerProfile;
  availableOrders: VolunteerOrderView[];
  assignedOrders: VolunteerOrderView[];
  statement: VolunteerStatement;
  rules: DistributionRules;
}

export const volunteerApi = {
  getDashboard: (volunteerId: string) =>
    apiFetch<VolunteerDashboardData>(`/api/volunteer/${volunteerId}/dashboard`, {}, true),
  claimOrder: (volunteerId: string, orderNumber: string) =>
    apiFetch<{ order: Order }>(
      `/api/volunteer/${volunteerId}/orders/${encodeURIComponent(orderNumber)}/claim`,
      { method: 'POST' },
      true,
    ),
  updateStatus: (
    volunteerId: string,
    orderNumber: string,
    payload: {
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
    },
  ) =>
    apiFetch<{ order: Order }>(
      `/api/volunteer/${volunteerId}/orders/${encodeURIComponent(orderNumber)}/status`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      true,
    ),
  submitRemittance: (
    volunteerId: string,
    orderNumber: string,
    payload: {
      mode: CashRemittanceMode;
      shopTransferChannel?: RemittanceChannel;
      platformTransferChannel?: RemittanceChannel;
      instapayReference?: string;
      note?: string;
    },
  ) =>
    apiFetch<{ order: Order }>(
      `/api/volunteer/${volunteerId}/orders/${encodeURIComponent(orderNumber)}/remittance`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      true,
    ),
};

export interface AdminOverviewData {
  shops: Shop[];
  volunteers: VolunteerProfile[];
  customers: CustomerProfile[];
  orders: Order[];
  analytics: AnalyticsReport;
  rules: DistributionRules;
  shopStatements: ShopStatement[];
  volunteerStatements: VolunteerStatement[];
}

export const adminApi = {
  getOverview: (filters?: {
    shopId?: string;
    volunteerId?: string;
    status?: string;
    dateFrom?: string;
    dateTo?: string;
  }) => {
    const params = new URLSearchParams();
    if (filters?.shopId) params.set('shopId', filters.shopId);
    if (filters?.volunteerId) params.set('volunteerId', filters.volunteerId);
    if (filters?.status) params.set('status', filters.status);
    if (filters?.dateFrom) params.set('dateFrom', filters.dateFrom);
    if (filters?.dateTo) params.set('dateTo', filters.dateTo);
    const qs = params.toString();
    return apiFetch<AdminOverviewData>(`/api/admin/overview${qs ? `?${qs}` : ''}`, {}, true);
  },
  assignVolunteer: (orderNumber: string, volunteerId: string, reason?: string) =>
    apiFetch<{ order: Order }>(
      `/api/admin/orders/${encodeURIComponent(orderNumber)}/assign-volunteer`,
      {
        method: 'POST',
        body: JSON.stringify({ volunteerId, reason }),
      },
      true,
    ),
  settleOrder: (orderNumber: string, party: 'shop' | 'volunteer' | 'both') =>
    apiFetch<{ order: Order }>(
      `/api/admin/orders/${encodeURIComponent(orderNumber)}/settle`,
      {
        method: 'POST',
        body: JSON.stringify({ party }),
      },
      true,
    ),
  confirmRemittance: (
    orderNumber: string,
    target: 'from_shop' | 'from_volunteer' | 'full',
    settleVolunteerShareToo?: boolean,
  ) =>
    apiFetch<{ order: Order }>(
      `/api/admin/orders/${encodeURIComponent(orderNumber)}/confirm-remittance`,
      {
        method: 'POST',
        body: JSON.stringify({ target, settleVolunteerShareToo }),
      },
      true,
    ),
  updateRules: (rules: Partial<DistributionRules>) =>
    apiFetch<{ rules: DistributionRules }>(
      '/api/admin/distribution-rules',
      {
        method: 'PUT',
        body: JSON.stringify(rules),
      },
      true,
    ),
  resetDemo: () =>
    apiFetch<{ ok: boolean; message: string }>(
      '/api/admin/reset-demo',
      { method: 'POST' },
      true,
    ),
  runVerificationSuite: () =>
    apiFetch<{ allPassed: boolean; steps: VerificationStepResult[] }>(
      '/api/admin/run-verification-suite',
      { method: 'POST' },
      true,
    ),
};
