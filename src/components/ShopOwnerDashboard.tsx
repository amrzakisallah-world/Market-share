import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeftRight,
  BookOpen,
  Boxes,
  Check,
  PackagePlus,
  Plus,
  QrCode,
  RefreshCw,
  ScanBarcode,
  ShoppingBag,
  Star,
  Truck,
  XCircle,
} from 'lucide-react';
import { navigateToAppPath } from '../App';
import { shopApi, type ShopDashboardData } from '../api/client';
import type { Order, OrderModificationRequest, OrderStatus, ProductCategory } from '../types/commerce';
import { ShopPosScanner } from './ShopPosScanner';
import { ShopShiftsAndQrManager } from './ShopShiftsAndQrManager';
import {
  DAILY_ENTRY_LABELS,
  INVENTORY_MOVEMENT_LABELS,
  ORDER_STATUS_META,
  PRODUCT_CATEGORIES,
  REMITTANCE_CHANNEL_LABELS,
  REMITTANCE_MODE_LABELS,
  REMITTANCE_STATUS_META,
  SETTLEMENT_STATUS_META,
  formatDateTimeAr,
  formatEGP,
} from '../utils/arabicLabels';

interface ShopOwnerDashboardProps {
  shopId: string;
}

const ORDER_TABS: Array<{ key: OrderStatus; label: string }> = [
  { key: 'new', label: 'الطلبات الجديدة' },
  { key: 'confirmed', label: 'المؤكدة' },
  { key: 'preparing', label: 'جاري التجهيز' },
  { key: 'ready', label: 'جاهزة للاستلام' },
  { key: 'completed', label: 'المكتملة' },
  { key: 'cancelled', label: 'الملغاة' },
];

export const ShopOwnerDashboard: React.FC<ShopOwnerDashboardProps> = ({ shopId }) => {
  const [data, setData] = useState<ShopDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const [section, setSection] = useState<
    'orders' | 'pos' | 'shifts' | 'inventory' | 'movements' | 'daily'
  >('orders');
  const [orderTab, setOrderTab] = useState<OrderStatus>('new');

  // Cancel modal/inline state
  const [cancellingOrder, setCancellingOrder] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState('');

  // Modification proposal modal state
  const [modTarget, setModTarget] = useState<{
    orderNumber: string;
    itemId: string;
    itemName: string;
    currentQty: number;
    currentPrice: number;
  } | null>(null);
  const [modType, setModType] = useState<OrderModificationRequest['type']>('substitute_item');
  const [modSubProductId, setModSubProductId] = useState('');
  const [modQty, setModQty] = useState<number>(1);
  const [modPrice, setModPrice] = useState<number>(10);
  const [modReason, setModReason] = useState('');

  // Inventory filters & edit state
  const [invSearch, setInvSearch] = useState('');
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [editPrice, setEditPrice] = useState<string>('');
  const [editStockDelta, setEditStockDelta] = useState<string>('0');
  const [editAvailable, setEditAvailable] = useState<boolean>(true);
  const [editReason, setEditReason] = useState<string>('');

  // Add product form
  const [showAddProduct, setShowAddProduct] = useState(false);
  const [newProd, setNewProd] = useState<{
    name: string;
    brand: string;
    category: ProductCategory;
    customCategory: string;
    packSize: string;
    unit: string;
    priceEGP: string;
    initialStock: string;
    barcode: string;
    isWeighted: boolean;
    scalePlu: string;
  }>({
    name: '',
    brand: '',
    category: PRODUCT_CATEGORIES[0],
    customCategory: '',
    packSize: '1 كجم',
    unit: 'كيس',
    priceEGP: '',
    initialStock: '20',
    barcode: '',
    isWeighted: false,
    scalePlu: '',
  });

  // Daily entry form
  const [entryType, setEntryType] = useState<'expense' | 'purchase' | 'offline_sale'>('expense');
  const [entryCategory, setEntryCategory] = useState('أكياس وتغليف');
  const [entryDesc, setEntryDesc] = useState('');
  const [entryAmount, setEntryAmount] = useState('');
  const [entryProductId, setEntryProductId] = useState('');
  const [entryRestockQty, setEntryRestockQty] = useState('');

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await shopApi.getDashboard(shopId);
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل لوحة المحل');
    } finally {
      setLoading(false);
    }
  }, [shopId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const countsByStatus = useMemo(() => {
    const map: Record<OrderStatus, number> = {
      new: 0,
      confirmed: 0,
      preparing: 0,
      ready: 0,
      completed: 0,
      cancelled: 0,
    };
    for (const o of data?.orders ?? []) {
      map[o.status] += 1;
    }
    return map;
  }, [data]);

  const filteredOrders = useMemo(
    () => (data?.orders ?? []).filter((o) => o.status === orderTab),
    [data, orderTab],
  );

  const lowStockItems = useMemo(
    () => (data?.catalog ?? []).filter((c) => c.isLowStock),
    [data],
  );

  const filteredCatalog = useMemo(() => {
    const q = invSearch.trim().toLowerCase();
    return (data?.catalog ?? []).filter((item) => {
      if (lowStockOnly && !item.isLowStock) return false;
      if (!q) return true;
      return (
        item.name.toLowerCase().includes(q) ||
        item.brand.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q)
      );
    });
  }, [data, invSearch, lowStockOnly]);

  const handleStatusChange = async (orderNumber: string, nextStatus: OrderStatus, reason?: string) => {
    setError(null);
    setActionMsg(null);
    try {
      await shopApi.updateOrderStatus(shopId, orderNumber, nextStatus, reason);
      setCancellingOrder(null);
      setCancelReason('');
      setActionMsg(`تم تحديث حالة الطلب ${orderNumber} بنجاح`);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تحديث حالة الطلب');
    }
  };

  const handleHandoverVolunteer = async (orderNumber: string) => {
    setError(null);
    setActionMsg(null);
    try {
      await shopApi.handoverOrderToVolunteer(shopId, orderNumber);
      setActionMsg(`تم توثيق تسليم الطلب ${orderNumber} للمتطوع بنجاح`);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تأكيد تسليم الطلب للمتطوع');
    }
  };

  const handleConfirmRemittanceReceipt = async (orderNumber: string) => {
    setError(null);
    setActionMsg(null);
    try {
      await shopApi.confirmRemittanceReceipt(shopId, orderNumber);
      setActionMsg(
        `تم تأكيد استلام المبلغ من المندوب وتقفيل تسوية المحل للطلب ${orderNumber}`,
      );
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تأكيد استلام التحصيل');
    }
  };

  const handleSubmitModification = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!modTarget) return;
    setError(null);
    try {
      await shopApi.proposeModification(shopId, modTarget.orderNumber, {
        type: modType,
        targetItemId: modTarget.itemId,
        proposedProductId: modType === 'substitute_item' ? modSubProductId : undefined,
        proposedQuantity:
          modType === 'adjust_quantity' || modType === 'substitute_item' ? modQty : undefined,
        proposedUnitPriceEGP: modType === 'price_adjustment' ? modPrice : undefined,
        reason: modReason,
      });
      setModTarget(null);
      setModReason('');
      setActionMsg('تم تسجيل مقترح التعديل وإرساله لموافقة العميل');
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر إرسال مقترح التعديل');
    }
  };

  const handleRecordCustomerApproval = async (
    orderNumber: string,
    decision: 'approved' | 'rejected',
  ) => {
    setError(null);
    try {
      await shopApi.recordCustomerApproval(shopId, orderNumber, decision);
      setActionMsg(
        decision === 'approved'
          ? `تم تسجيل موافقة العميل وتحديث الطلب ${orderNumber}`
          : `تم تسجيل رفض العميل للبديل في الطلب ${orderNumber}`,
      );
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تسجيل قرار العميل');
    }
  };

  const handleSaveProductEdit = async (productId: string) => {
    setError(null);
    try {
      await shopApi.updateProduct(shopId, productId, {
        priceEGP: editPrice ? Number(editPrice) : undefined,
        stockDelta: editStockDelta ? Number(editStockDelta) : 0,
        isAvailable: editAvailable,
        reason: editReason,
      });
      setEditingProductId(null);
      setEditReason('');
      setActionMsg('تم حفظ تعديل المنتج في السجل وتحديث المخزون');
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تعديل المنتج');
    }
  };

  const handleAddProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const resolvedCategory = (
      newProd.category === '__custom__' ? newProd.customCategory.trim() : newProd.category
    ) as ProductCategory;
    if (!resolvedCategory) {
      setError('يرجى اختيار التصنيف أو كتابته يدويًا');
      return;
    }
    try {
      await shopApi.addProduct(shopId, {
        name: newProd.name,
        brand: newProd.brand || 'عام',
        category: resolvedCategory,
        packSize: newProd.packSize,
        unit: newProd.unit,
        priceEGP: Number(newProd.priceEGP),
        initialStock: Number(newProd.initialStock),
        barcode: newProd.barcode.trim() || undefined,
        isWeighted: newProd.isWeighted,
        scalePlu: newProd.isWeighted && newProd.scalePlu.trim() ? newProd.scalePlu.trim() : undefined,
      });
      setShowAddProduct(false);
      setNewProd({
        name: '',
        brand: '',
        category: PRODUCT_CATEGORIES[0],
        customCategory: '',
        packSize: '1 كجم',
        unit: 'كيس',
        priceEGP: '',
        initialStock: '20',
        barcode: '',
        isWeighted: false,
        scalePlu: '',
      });
      setActionMsg('تمت إضافة المنتج الجديد إلى كتالوج المحل');
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر إضافة المنتج');
    }
  };

  const handleAddDailyEntry = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await shopApi.addDailyEntry(shopId, {
        type: entryType,
        category: entryCategory,
        description: entryDesc,
        amountEGP: Number(entryAmount),
        relatedProductId: entryType === 'purchase' && entryProductId ? entryProductId : undefined,
        quantityRestocked:
          entryType === 'purchase' && entryRestockQty ? Number(entryRestockQty) : undefined,
      });
      setEntryDesc('');
      setEntryAmount('');
      setEntryProductId('');
      setEntryRestockQty('');
      setActionMsg('تم تسجيل القيد اليومي بنجاح');
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تسجيل القيد');
    }
  };

  if (loading && !data) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
        جاري تحميل بيانات المحل...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Shop Summary Strip */}
      <div className="flex flex-col justify-between gap-4 rounded-xl border border-slate-200 bg-white p-5 sm:flex-row sm:items-center">
        <div>
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span>لوحة تشغيل المحل</span>
            <span aria-hidden="true">·</span>
            <span>{data?.shop.area}</span>
            <span aria-hidden="true">·</span>
            <span>{data?.shop.ownerName}</span>
          </div>
          <h1 className="font-display mt-1 text-xl font-bold text-slate-900">{data?.shop.name}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <div>
            <p className="text-xs text-slate-500">مبيعات المنصة المكتملة</p>
            <p className="font-mono text-base font-bold text-teal-800 tabular-nums">
              {formatEGP(data?.statement.platformSalesGMV ?? 0)}
            </p>
          </div>
          <div className="h-8 w-px bg-slate-200" />
          <div>
            <p className="text-xs text-slate-500">مستحقات المحل غير المسواة</p>
            <p className="font-mono text-base font-bold text-amber-700 tabular-nums">
              {formatEGP(data?.statement.pendingSettlementToShopEGP ?? 0)}
            </p>
          </div>
          <div className="h-8 w-px bg-slate-200" />
          <div>
            <p className="text-xs text-slate-500">أمانة للمنصة لدى المحل</p>
            <p className="font-mono text-base font-bold text-indigo-800 tabular-nums">
              {formatEGP(data?.statement.platformReceivableFromShopEGP ?? 0)}
            </p>
          </div>
          <div className="h-8 w-px bg-slate-200" />
          <div>
            <p className="text-xs text-slate-500">نواقص المخزون</p>
            <p className="font-mono text-base font-bold text-rose-700 tabular-nums">
              {lowStockItems.length} صنف
            </p>
          </div>
          {data && data.statement.ratingsCount > 0 && data.statement.averageRating !== null && (
            <>
              <div className="h-8 w-px bg-slate-200" />
              <div>
                <p className="text-xs text-slate-500">تقييم العملاء ({data.statement.ratingsCount})</p>
                <p className="flex items-center gap-1 font-mono text-base font-bold text-amber-700 tabular-nums">
                  <Star className="h-4 w-4 fill-amber-400 text-amber-500" />
                  <span>{data.statement.averageRating}/5</span>
                </p>
              </div>
            </>
          )}
          <button
            type="button"
            onClick={loadData}
            className="flex min-h-[38px] items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>تحديث</span>
          </button>
        </div>
      </div>

      {/* Shop Navigation Tabs */}
      <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-slate-200 bg-white p-1.5">
        {[
          { id: 'orders', label: 'إدارة الطلبات', Icon: ShoppingBag },
          { id: 'pos', label: 'كاشير الموبايل والباركود', Icon: ScanBarcode },
          {
            id: 'shifts',
            label: `الورديات وكود QR (${data?.posManagement?.shifts.filter((s) => s.status === 'open').length ?? 0})`,
            Icon: QrCode,
          },
          { id: 'inventory', label: `المخزون والأسعار (${data?.catalog.length ?? 0})`, Icon: Boxes },
          { id: 'movements', label: 'حركة المخزون', Icon: ArrowLeftRight },
          { id: 'daily', label: 'الإدارة اليومية والحسابات', Icon: BookOpen },
        ].map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setSection(id as typeof section)}
            className={`flex min-h-[40px] shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-4 py-2 text-xs font-semibold transition-colors ${
              section === id
                ? 'bg-slate-900 text-white'
                : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
            }`}
          >
            <Icon className="h-4 w-4" />
            <span>{label}</span>
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          {error}
        </div>
      )}
      {actionMsg && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          {actionMsg}
        </div>
      )}

      {/* SECTION POS: MOBILE BARCODE & SCALE SCANNER */}
      {section === 'pos' && data && (
        <ShopPosScanner
          shopId={shopId}
          shopName={data.shop.name}
          catalog={data.catalog}
          onSaleRecorded={loadData}
        />
      )}

      {/* SECTION SHIFTS & QR */}
      {section === 'shifts' && data?.posManagement && (
        <ShopShiftsAndQrManager
          shopId={shopId}
          shopName={data.shop.name}
          posManagement={data.posManagement}
          onRefresh={loadData}
          onOpenPosPreview={(posPath) => navigateToAppPath(posPath)}
        />
      )}

      {/* SECTION 1: ORDERS */}
      {section === 'orders' && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-1.5">
            {ORDER_TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setOrderTab(t.key)}
                className={`min-h-[38px] shrink-0 whitespace-nowrap rounded-lg border px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                  orderTab === t.key
                    ? 'border-teal-700 bg-teal-700 text-white'
                    : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                {t.label}{' '}
                <span className="font-mono tabular-nums">({countsByStatus[t.key]})</span>
              </button>
            ))}
          </div>

          {(data?.statement.pendingShopRemittanceConfirmationsCount ?? 0) > 0 &&
            orderTab !== 'completed' && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-950">
                <span className="font-semibold">
                  يوجد {data?.statement.pendingShopRemittanceConfirmationsCount} طلب سلّم فيه المندوب
                  التحصيل وبانتظار تأكيد الاستلام لتقفيل التسوية.
                </span>
                <button
                  type="button"
                  onClick={() => setOrderTab('completed')}
                  className="font-bold text-teal-800 hover:underline"
                >
                  عرض الطلبات المكتملة ←
                </button>
              </div>
            )}

          {filteredOrders.length === 0 ? (
            <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
              لا توجد طلبات في قائمة "{ORDER_TABS.find((t) => t.key === orderTab)?.label}".
            </div>
          ) : (
            <div className="space-y-4">
              {filteredOrders.map((order: Order) => (
                <div
                  key={order.id}
                  className="rounded-xl border border-slate-200 bg-white p-5 space-y-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-3">
                    <div>
                      <div className="flex items-center gap-2 text-xs text-slate-500">
                        <span className="font-mono font-bold text-slate-900">
                          {order.orderNumber}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{formatDateTimeAr(order.createdAt)}</span>
                        <span aria-hidden="true">·</span>
                        <span>المخزون: {order.stockState === 'deducted' ? 'مخصوم فعليًا' : order.stockState === 'reserved' ? 'محجوز' : 'مُرجع'}</span>
                      </div>
                      <p className="mt-1 text-sm font-semibold text-slate-900">
                        العميل: {order.customerName} ({order.customerPhone})
                      </p>
                      <p className="text-xs text-slate-600">العنوان: {order.deliveryAddress}</p>
                      {order.deliveryNotes && (
                        <p className="mt-0.5 text-xs text-amber-800">
                          ملاحظة: {order.deliveryNotes}
                        </p>
                      )}
                    </div>

                    <div className="text-left">
                      <span
                        className={`inline-block rounded-md border px-2.5 py-1 text-xs font-semibold ${
                          ORDER_STATUS_META[order.status].surfaceClass
                        } ${ORDER_STATUS_META[order.status].textClass}`}
                      >
                        {ORDER_STATUS_META[order.status].label}
                      </span>
                      <p className="mt-1 font-mono text-sm font-bold text-slate-900 tabular-nums">
                        مستحق المحل: {formatEGP(order.financials.shopDueEGP)}
                      </p>
                      <p className="text-[11px] text-slate-500">
                        التحصيل من العميل: {formatEGP(order.financials.customerExpectedTotalEGP)}
                      </p>
                    </div>
                  </div>

                  {order.rating && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="flex items-center gap-1.5 font-bold text-amber-950">
                          <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-500" />
                          <span>
                            تقييم العميل: {order.rating.overallRating}/5
                            {order.rating.shopRating
                              ? ` (تجهيز المحل: ${order.rating.shopRating}/5)`
                              : ''}
                          </span>
                        </span>
                        {order.rating.complimentTags.length > 0 && (
                          <span className="text-amber-900">
                            {order.rating.complimentTags.join(' · ')}
                          </span>
                        )}
                      </div>
                      {order.rating.comment && (
                        <p className="mt-1 text-slate-700">"{order.rating.comment}"</p>
                      )}
                    </div>
                  )}

                  {/* Courier Cash / InstaPay Remittance Confirmation */}
                  {order.status === 'completed' && order.financials.remittance && (
                    <div
                      className={`rounded-lg border p-3.5 text-xs ${
                        order.financials.remittance.status === 'pending_shop_confirmation'
                          ? 'border-amber-300 bg-amber-50/70'
                          : 'border-emerald-200 bg-emerald-50/50'
                      }`}
                    >
                      {(() => {
                        const rem = order.financials.remittance!;
                        const channelText =
                          rem.shopTransferChannel === 'instapay'
                            ? 'تحويل إنستاباي للمحل'
                            : 'نقدي في إيد المحل';
                        if (rem.status === 'pending_shop_confirmation') {
                          return (
                            <div className="flex flex-wrap items-center justify-between gap-3">
                              <div className="space-y-1">
                                <p className="font-bold text-slate-900">
                                  بانتظار تأكيد المحل لاستلام{' '}
                                  <span className="font-mono text-teal-800 tabular-nums">
                                    {formatEGP(rem.amountToShopEGP)}
                                  </span>{' '}
                                  من المندوب ({order.volunteerName}) — {channelText}
                                  {rem.instapayReference ? ` · مرجع: ${rem.instapayReference}` : ''}
                                </p>
                                <p className="text-[11px] text-slate-700 tabular-nums">
                                  {rem.mode === 'full_to_shop'
                                    ? `بتأكيد الاستلام: تتقفل تسوية المحل وعهدة المندوب، ويبقى مبلغ ${formatEGP(rem.amountPlatformAtShopEGP)} أمانة للمنصة لدى المحل.`
                                    : `بتأكيد الاستلام: تتقفل تسوية السوبر ماركت بالكامل، ويبقى جزء المنصة (${formatEGP(rem.amountWithCourierForPlatformEGP)}) مع المندوب.`}
                                </p>
                              </div>
                              <button
                                type="button"
                                onClick={() => handleConfirmRemittanceReceipt(order.orderNumber)}
                                className="min-h-[38px] rounded-lg bg-emerald-700 px-4 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800"
                              >
                                تأكيد استلام المبلغ وتقفيل تسوية المحل
                              </button>
                            </div>
                          );
                        }
                        return (
                          <div className="space-y-1">
                            <p className="font-bold text-emerald-900">
                              {rem.shopConfirmedAt
                                ? `تم تأكيد استلام المحل (${formatEGP(rem.amountToShopEGP)} — ${
                                    REMITTANCE_CHANNEL_LABELS[rem.shopTransferChannel ?? 'cash']
                                  }) · اتقفلت تسوية المحل`
                                : REMITTANCE_MODE_LABELS[rem.mode]}
                            </p>
                            <p className="text-[11px] text-slate-700 tabular-nums">
                              {REMITTANCE_STATUS_META[rem.status].label}
                              {rem.mode === 'full_to_shop' &&
                              rem.shopConfirmedAt &&
                              !rem.platformConfirmedAt
                                ? ` · فلوس المنصة لدى المحل: ${formatEGP(rem.amountPlatformAtShopEGP)}`
                                : ''}
                            </p>
                          </div>
                        );
                      })()}
                    </div>
                  )}

                  {/* Pending Customer Approval Notice */}
                  {order.pendingModification && (
                    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">
                      <p className="font-bold">
                        مقترح تعديل معلق بانتظار موافقة العميل ({order.pendingModification.targetProductName}):
                      </p>
                      <p className="mt-1">السبب: {order.pendingModification.reason}</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => handleRecordCustomerApproval(order.orderNumber, 'approved')}
                          className="rounded bg-teal-700 px-3 py-1.5 font-semibold text-white hover:bg-teal-800"
                        >
                          تسجيل موافقة العميل هاتفيًا
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRecordCustomerApproval(order.orderNumber, 'rejected')}
                          className="rounded border border-rose-300 bg-white px-3 py-1.5 font-semibold text-rose-800 hover:bg-rose-50"
                        >
                          تسجيل رفض العميل للبديل
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Order Items Table */}
                  <div className="overflow-x-auto">
                    <table className="w-full text-right text-xs">
                      <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                        <tr>
                          <th className="px-3 py-2 font-semibold">المنتج</th>
                          <th className="px-3 py-2 font-semibold">الكمية</th>
                          <th className="px-3 py-2 font-semibold">السعر</th>
                          <th className="px-3 py-2 font-semibold">الإجمالي</th>
                          <th className="px-3 py-2 font-semibold">إجراء الصنف</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {order.items.map((item) => (
                          <tr key={item.id}>
                            <td className="px-3 py-2">
                              <span
                                className={
                                  item.status === 'unavailable_removed'
                                    ? 'text-slate-400 line-through'
                                    : 'font-medium text-slate-900'
                                }
                              >
                                {item.productName} ({item.packSize})
                              </span>
                              {item.status === 'substituted' && item.originalProductName && (
                                <span className="mr-2 text-[11px] text-teal-700">
                                  (بديل عن {item.originalProductName})
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2 font-mono tabular-nums">{item.quantity}</td>
                            <td className="px-3 py-2 font-mono tabular-nums">
                              {formatEGP(item.unitPriceEGP)}
                            </td>
                            <td className="px-3 py-2 font-mono font-semibold tabular-nums">
                              {formatEGP(item.lineTotalEGP)}
                            </td>
                            <td className="px-3 py-2">
                              {item.status === 'active' &&
                                (order.status === 'new' ||
                                  order.status === 'confirmed' ||
                                  order.status === 'preparing') &&
                                !order.pendingModification && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setModTarget({
                                        orderNumber: order.orderNumber,
                                        itemId: item.id,
                                        itemName: item.productName,
                                        currentQty: item.quantity,
                                        currentPrice: item.unitPriceEGP,
                                      });
                                      setModType('substitute_item');
                                      setModQty(item.quantity);
                                      setModPrice(item.unitPriceEGP);
                                      const firstAlt = data?.catalog.find(
                                        (c) =>
                                          c.productId !== item.productId &&
                                          c.isAvailable &&
                                          c.availableToSell > 0,
                                      );
                                      setModSubProductId(firstAlt?.productId ?? '');
                                    }}
                                    className="text-xs font-semibold text-teal-800 hover:underline"
                                  >
                                    تعديل / بديل غير متوفر
                                  </button>
                                )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Order Workflow Action Buttons */}
                  <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
                    {order.status === 'new' && (
                      <button
                        type="button"
                        onClick={() => handleStatusChange(order.orderNumber, 'confirmed')}
                        className="flex min-h-[38px] items-center gap-1.5 rounded-lg bg-teal-700 px-4 py-1.5 text-xs font-semibold text-white hover:bg-teal-800"
                      >
                        <Check className="h-3.5 w-3.5" />
                        <span>تأكيد الطلب</span>
                      </button>
                    )}
                    {order.status === 'confirmed' && (
                      <button
                        type="button"
                        onClick={() => handleStatusChange(order.orderNumber, 'preparing')}
                        className="min-h-[38px] rounded-lg bg-indigo-700 px-4 py-1.5 text-xs font-semibold text-white hover:bg-indigo-800"
                      >
                        بدء التجهيز
                      </button>
                    )}
                    {order.status === 'preparing' && (
                      <button
                        type="button"
                        onClick={() => handleStatusChange(order.orderNumber, 'ready')}
                        className="min-h-[38px] rounded-lg bg-emerald-700 px-4 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800"
                      >
                        جاهز للاستلام (خصم المخزون)
                      </button>
                    )}
                    {order.status === 'ready' &&
                      order.volunteerId &&
                      (order.deliveryStatus === 'assigned' ||
                        order.deliveryStatus === 'heading_to_shop') && (
                        <button
                          type="button"
                          onClick={() => handleHandoverVolunteer(order.orderNumber)}
                          className="flex min-h-[38px] items-center gap-1.5 rounded-lg bg-teal-700 px-4 py-1.5 text-xs font-semibold text-white hover:bg-teal-800"
                        >
                          <Truck className="h-3.5 w-3.5" />
                          <span>تأكيد تسليم الطلب للمتطوع ({order.volunteerName})</span>
                        </button>
                      )}
                    {order.status === 'ready' && order.deliveryStatus === 'picked_up' && (
                      <span className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800">
                        تم تسليم الطلب للمتطوع ({order.volunteerName})
                      </span>
                    )}
                    {(order.status === 'new' ||
                      order.status === 'confirmed' ||
                      order.status === 'preparing') && (
                      <>
                        {cancellingOrder === order.orderNumber ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <input
                              type="text"
                              value={cancelReason}
                              onChange={(e) => setCancelReason(e.target.value)}
                              placeholder="سبب الرفض أو الإلغاء (إلزامي)"
                              className="min-h-[38px] rounded-lg border border-rose-300 px-3 py-1.5 text-xs"
                            />
                            <button
                              type="button"
                              onClick={() =>
                                handleStatusChange(order.orderNumber, 'cancelled', cancelReason)
                              }
                              className="min-h-[38px] rounded-lg bg-rose-700 px-3 py-1.5 text-xs font-semibold text-white"
                            >
                              تأكيد الإلغاء
                            </button>
                            <button
                              type="button"
                              onClick={() => setCancellingOrder(null)}
                              className="min-h-[38px] rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-700"
                            >
                              إغلاق
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setCancellingOrder(order.orderNumber)}
                            className="flex min-h-[38px] items-center gap-1 rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-50"
                          >
                            <XCircle className="h-3.5 w-3.5" />
                            <span>رفض / إلغاء</span>
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* SECTION 2: INVENTORY & CATALOG */}
      {section === 'inventory' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="search"
                value={invSearch}
                onChange={(e) => setInvSearch(e.target.value)}
                placeholder="بحث في منتجات المحل..."
                className="min-h-[40px] w-64 rounded-lg border border-slate-200 px-3 py-1.5 text-xs focus:border-teal-700 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setLowStockOnly((v) => !v)}
                className={`flex min-h-[40px] items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold ${
                  lowStockOnly
                    ? 'border-amber-600 bg-amber-50 text-amber-900'
                    : 'border-slate-200 text-slate-700 hover:bg-slate-50'
                }`}
              >
                <AlertTriangle className="h-3.5 w-3.5" />
                <span>المنتجات الناقصة فقط ({lowStockItems.length})</span>
              </button>
            </div>
            <button
              type="button"
              onClick={() => setShowAddProduct((v) => !v)}
              className="flex min-h-[40px] items-center gap-1.5 rounded-lg bg-teal-700 px-4 py-2 text-xs font-semibold text-white hover:bg-teal-800"
            >
              <PackagePlus className="h-4 w-4" />
              <span>إضافة منتج جديد</span>
            </button>
          </div>

          {showAddProduct && (
            <form
              onSubmit={handleAddProduct}
              className="grid gap-3 rounded-xl border border-teal-200 bg-white p-5 sm:grid-cols-3"
            >
              <h3 className="font-display text-sm font-bold text-slate-900 sm:col-span-3">
                إضافة منتج جديد إلى {data?.shop.name}
              </h3>
              <input
                type="text"
                required
                placeholder="اسم المنتج"
                value={newProd.name}
                onChange={(e) => setNewProd({ ...newProd, name: e.target.value })}
                className="min-h-[40px] rounded-lg border border-slate-200 px-3 text-xs"
              />
              <input
                type="text"
                placeholder="العلامة التجارية"
                value={newProd.brand}
                onChange={(e) => setNewProd({ ...newProd, brand: e.target.value })}
                className="min-h-[40px] rounded-lg border border-slate-200 px-3 text-xs"
              />
              <select
                value={newProd.category}
                onChange={(e) =>
                  setNewProd({ ...newProd, category: e.target.value as ProductCategory })
                }
                className="min-h-[40px] rounded-lg border border-slate-200 px-3 text-xs"
              >
                {PRODUCT_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
                <option value="__custom__">+ تصنيف مخصص (كتابة يدوية)</option>
              </select>
              {newProd.category === '__custom__' && (
                <input
                  type="text"
                  required
                  placeholder="اكتب اسم التصنيف الجديد..."
                  value={newProd.customCategory}
                  onChange={(e) => setNewProd({ ...newProd, customCategory: e.target.value })}
                  className="min-h-[40px] rounded-lg border border-teal-300 px-3 text-xs sm:col-span-3"
                />
              )}
              <input
                type="text"
                required
                placeholder="الحجم (مثال: 1 كجم)"
                value={newProd.packSize}
                onChange={(e) => setNewProd({ ...newProd, packSize: e.target.value })}
                className="min-h-[40px] rounded-lg border border-slate-200 px-3 text-xs"
              />
              <input
                type="text"
                required
                placeholder="الوحدة (مثال: كيس)"
                value={newProd.unit}
                onChange={(e) => setNewProd({ ...newProd, unit: e.target.value })}
                className="min-h-[40px] rounded-lg border border-slate-200 px-3 text-xs"
              />
              <input
                type="number"
                required
                step="0.5"
                min="1"
                placeholder="السعر بالجنيه"
                value={newProd.priceEGP}
                onChange={(e) => setNewProd({ ...newProd, priceEGP: e.target.value })}
                className="min-h-[40px] rounded-lg border border-slate-200 px-3 text-xs"
              />
              <input
                type="number"
                required
                min="0"
                placeholder="الكمية الافتتاحية"
                value={newProd.initialStock}
                onChange={(e) => setNewProd({ ...newProd, initialStock: e.target.value })}
                className="min-h-[40px] rounded-lg border border-slate-200 px-3 text-xs"
              />
              <input
                type="text"
                dir="ltr"
                placeholder="رقم الباركود (اختياري)"
                value={newProd.barcode}
                onChange={(e) => setNewProd({ ...newProd, barcode: e.target.value })}
                className="min-h-[40px] rounded-lg border border-slate-200 px-3 text-right font-mono text-xs"
              />
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5 text-xs text-slate-700">
                  <input
                    type="checkbox"
                    checked={newProd.isWeighted}
                    onChange={(e) => setNewProd({ ...newProd, isWeighted: e.target.checked })}
                  />
                  <span>صنف ميزان (وزن بالكيلو)</span>
                </label>
                {newProd.isWeighted && (
                  <input
                    type="text"
                    dir="ltr"
                    maxLength={5}
                    placeholder="PLU (5 أرقام)"
                    value={newProd.scalePlu}
                    onChange={(e) => setNewProd({ ...newProd, scalePlu: e.target.value })}
                    className="min-h-[36px] w-28 rounded-lg border border-slate-200 px-2 text-right font-mono text-xs"
                  />
                )}
              </div>
              <div className="flex items-center gap-2 sm:col-span-3">
                <button
                  type="submit"
                  className="min-h-[40px] rounded-lg bg-teal-700 px-5 text-xs font-semibold text-white hover:bg-teal-800"
                >
                  حفظ المنتج
                </button>
                <button
                  type="button"
                  onClick={() => setShowAddProduct(false)}
                  className="min-h-[40px] rounded-lg border border-slate-200 px-4 text-xs text-slate-600"
                >
                  إلغاء
                </button>
              </div>
            </form>
          )}

          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="w-full text-right text-xs">
              <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-4 py-3 font-semibold">المنتج</th>
                  <th className="px-4 py-3 font-semibold">السعر وملاحظته</th>
                  <th className="px-4 py-3 font-semibold">الفعلي</th>
                  <th className="px-4 py-3 font-semibold">المحجوز</th>
                  <th className="px-4 py-3 font-semibold">المتاح للبيع</th>
                  <th className="px-4 py-3 font-semibold">التوفر</th>
                  <th className="px-4 py-3 font-semibold">إدارة</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredCatalog.map((item) => {
                  const isEditing = editingProductId === item.productId;
                  return (
                    <React.Fragment key={item.listingId}>
                      <tr className="hover:bg-slate-50/70">
                        <td className="px-4 py-3">
                          <p className="font-semibold text-slate-900">{item.name}</p>
                          <p className="text-[11px] text-slate-500">
                            {item.category} · {item.packSize} · {item.unit}
                            {item.barcode ? ` · باركود ${item.barcode}` : ''}
                            {item.isWeighted && item.scalePlu ? ` · ميزان PLU ${item.scalePlu}` : ''}
                          </p>
                        </td>
                        <td className="px-4 py-3">
                          <p className="font-mono font-bold text-slate-900 tabular-nums">
                            {formatEGP(item.priceEGP)}
                          </p>
                          <p className="text-[11px] text-slate-400">
                            {formatDateTimeAr(item.priceUpdatedAt)}
                          </p>
                        </td>
                        <td className="px-4 py-3 font-mono tabular-nums">{item.currentStock}</td>
                        <td className="px-4 py-3 font-mono text-amber-700 tabular-nums">
                          {item.reservedStock}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`font-mono font-bold tabular-nums ${
                              item.isLowStock ? 'text-rose-700' : 'text-emerald-700'
                            }`}
                          >
                            {item.availableToSell}
                          </span>
                          {item.isLowStock && (
                            <span className="mr-1.5 text-[11px] text-rose-600">
                              (حد التنبيه {item.lowStockThreshold})
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={
                              item.isAvailable
                                ? 'font-semibold text-emerald-700'
                                : 'font-semibold text-rose-700'
                            }
                          >
                            {item.isAvailable ? 'متاح' : 'متوقف'}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <button
                            type="button"
                            onClick={() => {
                              if (isEditing) {
                                setEditingProductId(null);
                              } else {
                                setEditingProductId(item.productId);
                                setEditPrice(String(item.priceEGP));
                                setEditStockDelta('0');
                                setEditAvailable(item.isAvailable);
                                setEditReason('');
                              }
                            }}
                            className="font-semibold text-teal-800 hover:underline"
                          >
                            {isEditing ? 'إغلاق' : 'تعديل السعر / المخزون'}
                          </button>
                        </td>
                      </tr>
                      {isEditing && (
                        <tr className="bg-slate-50">
                          <td colSpan={7} className="px-4 py-3">
                            <div className="flex flex-wrap items-end gap-3">
                              <div>
                                <label className="mb-1 block text-[11px] text-slate-600">
                                  السعر الجديد (ج.م)
                                </label>
                                <input
                                  type="number"
                                  step="0.5"
                                  value={editPrice}
                                  onChange={(e) => setEditPrice(e.target.value)}
                                  className="min-h-[36px] w-28 rounded border border-slate-300 bg-white px-2 font-mono text-xs"
                                />
                              </div>
                              <div>
                                <label className="mb-1 block text-[11px] text-slate-600">
                                  تعديل الكمية (+ إضافة / - خصم)
                                </label>
                                <input
                                  type="number"
                                  value={editStockDelta}
                                  onChange={(e) => setEditStockDelta(e.target.value)}
                                  className="min-h-[36px] w-28 rounded border border-slate-300 bg-white px-2 font-mono text-xs"
                                />
                              </div>
                              <label className="flex min-h-[36px] items-center gap-1.5 text-xs text-slate-700">
                                <input
                                  type="checkbox"
                                  checked={editAvailable}
                                  onChange={(e) => setEditAvailable(e.target.checked)}
                                />
                                <span>متاح للبيع</span>
                              </label>
                              <div className="min-w-[220px] flex-1">
                                <label className="mb-1 block text-[11px] text-slate-600">
                                  سبب التعديل (إلزامي للتوثيق)
                                </label>
                                <input
                                  type="text"
                                  value={editReason}
                                  onChange={(e) => setEditReason(e.target.value)}
                                  placeholder="مثال: جرد يومي / تغيير سعر المورد"
                                  className="min-h-[36px] w-full rounded border border-slate-300 bg-white px-2.5 text-xs"
                                />
                              </div>
                              <button
                                type="button"
                                onClick={() => handleSaveProductEdit(item.productId)}
                                className="min-h-[36px] rounded-lg bg-slate-900 px-4 text-xs font-semibold text-white hover:bg-teal-700"
                              >
                                حفظ التعديل
                              </button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SECTION 3: INVENTORY MOVEMENTS LEDGER */}
      {section === 'movements' && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-right text-xs">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
              <tr>
                <th className="px-4 py-3 font-semibold">التوقيت</th>
                <th className="px-4 py-3 font-semibold">المنتج</th>
                <th className="px-4 py-3 font-semibold">نوع الحركة</th>
                <th className="px-4 py-3 font-semibold">الفعلي</th>
                <th className="px-4 py-3 font-semibold">المحجوز</th>
                <th className="px-4 py-3 font-semibold">الرصيد بعد</th>
                <th className="px-4 py-3 font-semibold">السبب / المرجع</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(data?.movements ?? []).slice(0, 80).map((m) => (
                <tr key={m.id}>
                  <td className="px-4 py-2.5 text-slate-500">{formatDateTimeAr(m.createdAt)}</td>
                  <td className="px-4 py-2.5 font-medium text-slate-900">{m.productName}</td>
                  <td className="px-4 py-2.5 text-slate-700">
                    {INVENTORY_MOVEMENT_LABELS[m.type]}
                  </td>
                  <td className="px-4 py-2.5 font-mono tabular-nums">
                    {m.quantityDelta > 0 ? `+${m.quantityDelta}` : m.quantityDelta}
                  </td>
                  <td className="px-4 py-2.5 font-mono tabular-nums">
                    {m.reservedDelta > 0 ? `+${m.reservedDelta}` : m.reservedDelta}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-slate-700 tabular-nums">
                    {m.stockAfter} (محجوز {m.reservedAfter})
                  </td>
                  <td className="px-4 py-2.5 text-slate-600">
                    {m.reason} — {m.actorName}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* SECTION 4: DAILY MANAGEMENT & SEPARATED LEDGERS */}
      {section === 'daily' && data && (
        <div className="space-y-6">
          {/* Strictly Separated Platform vs Offline Summary */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <p className="text-xs text-slate-500">مبيعات القناة الإلكترونية (المنصة)</p>
              <p className="mt-1 font-mono text-xl font-bold text-teal-800 tabular-nums">
                {formatEGP(data.statement.platformSalesGMV)}
              </p>
              <p className="mt-1 text-[11px] text-slate-500">
                منفصلة عن مبيعات المحل الداخلية
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <p className="text-xs text-slate-500">مبيعات المحل المباشرة (خارج المنصة)</p>
              <p className="mt-1 font-mono text-xl font-bold text-slate-900 tabular-nums">
                {formatEGP(data.statement.offlineSalesEGP)}
              </p>
              <p className="mt-1 text-[11px] text-slate-500">تسجيل اختياري للملخص اليومي</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <p className="text-xs text-slate-500">المشتريات والمصروفات المسجلة</p>
              <p className="mt-1 font-mono text-xl font-bold text-rose-700 tabular-nums">
                {formatEGP(data.statement.totalPurchasesEGP + data.statement.totalExpensesEGP)}
              </p>
              <p className="mt-1 text-[11px] text-slate-500 tabular-nums">
                مشتريات {formatEGP(data.statement.totalPurchasesEGP)} · مصروفات{' '}
                {formatEGP(data.statement.totalExpensesEGP)}
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <p className="text-xs text-slate-500">تسوية المنصة مع المحل</p>
              <p className="mt-1 font-mono text-xl font-bold text-amber-700 tabular-nums">
                {formatEGP(data.statement.pendingSettlementToShopEGP)}
              </p>
              <p className="mt-1 text-[11px] text-slate-500 tabular-nums">
                تم تسويته: {formatEGP(data.statement.settledToShopEGP)} · أمانة للمنصة عند المحل:{' '}
                <strong className="text-indigo-800">
                  {formatEGP(data.statement.platformReceivableFromShopEGP)}
                </strong>
              </p>
            </div>
          </div>

          {/* Add Daily Entry Form */}
          <form
            onSubmit={handleAddDailyEntry}
            className="grid gap-3 rounded-xl border border-slate-200 bg-white p-5 sm:grid-cols-4"
          >
            <h3 className="font-display text-sm font-bold text-slate-900 sm:col-span-4">
              تسجيل حركة يومية (مصروف / مشتريات توريد / مبيعات داخل المحل)
            </h3>
            <select
              value={entryType}
              onChange={(e) => setEntryType(e.target.value as typeof entryType)}
              className="min-h-[40px] rounded-lg border border-slate-200 px-3 text-xs"
            >
              <option value="expense">مصروف تشغيل</option>
              <option value="purchase">فاتورة مشتريات / توريد</option>
              <option value="offline_sale">مبيعات داخل المحل (خارج المنصة)</option>
            </select>
            <input
              type="text"
              required
              placeholder="البند / التصنيف (مثال: كهرباء، توريد)"
              value={entryCategory}
              onChange={(e) => setEntryCategory(e.target.value)}
              className="min-h-[40px] rounded-lg border border-slate-200 px-3 text-xs"
            />
            <input
              type="text"
              required
              placeholder="الوصف التفصيلي"
              value={entryDesc}
              onChange={(e) => setEntryDesc(e.target.value)}
              className="min-h-[40px] rounded-lg border border-slate-200 px-3 text-xs"
            />
            <input
              type="number"
              required
              step="0.5"
              min="1"
              placeholder="المبلغ (ج.م)"
              value={entryAmount}
              onChange={(e) => setEntryAmount(e.target.value)}
              className="min-h-[40px] rounded-lg border border-slate-200 px-3 font-mono text-xs"
            />
            {entryType === 'purchase' && (
              <>
                <select
                  value={entryProductId}
                  onChange={(e) => setEntryProductId(e.target.value)}
                  className="min-h-[40px] rounded-lg border border-slate-200 px-3 text-xs sm:col-span-2"
                >
                  <option value="">(اختياري) إضافة الكمية مباشرة لمخزون منتج</option>
                  {data.catalog.map((c) => (
                    <option key={c.productId} value={c.productId}>
                      {c.name} (الحالي: {c.currentStock})
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  min="1"
                  placeholder="الكمية الموردة"
                  value={entryRestockQty}
                  onChange={(e) => setEntryRestockQty(e.target.value)}
                  className="min-h-[40px] rounded-lg border border-slate-200 px-3 font-mono text-xs"
                />
              </>
            )}
            <button
              type="submit"
              className="flex min-h-[40px] items-center justify-center gap-1.5 rounded-lg bg-slate-900 px-4 text-xs font-semibold text-white hover:bg-teal-700"
            >
              <Plus className="h-4 w-4" />
              <span>تسجيل القيد</span>
            </button>
          </form>

          {/* Daily Entries & Platform Statement Tables */}
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
              <div className="border-b border-slate-200 px-4 py-3">
                <h3 className="font-display text-sm font-bold text-slate-900">
                  دفتر المصروفات والمشتريات والمبيعات الداخلية
                </h3>
              </div>
              <table className="w-full text-right text-xs">
                <thead className="border-b border-slate-100 bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-3 py-2 font-semibold">النوع</th>
                    <th className="px-3 py-2 font-semibold">الوصف</th>
                    <th className="px-3 py-2 font-semibold">المبلغ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.dailyEntries.map((entry) => (
                    <tr key={entry.id}>
                      <td className="px-3 py-2 font-medium text-slate-700">
                        {DAILY_ENTRY_LABELS[entry.type]}
                      </td>
                      <td className="px-3 py-2 text-slate-600">
                        {entry.description}
                        {entry.relatedProductName && (
                          <span className="mr-1 text-[11px] text-teal-700">
                            (+{entry.quantityRestocked} {entry.relatedProductName})
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono font-semibold tabular-nums">
                        {formatEGP(entry.amountEGP)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
              <div className="border-b border-slate-200 px-4 py-3">
                <h3 className="font-display text-sm font-bold text-slate-900">
                  سجل مبيعات المنصة وكشف التسوية
                </h3>
              </div>
              {data.statement.orderRows.length === 0 ? (
                <p className="p-6 text-center text-xs text-slate-500">
                  لا توجد طلبات مسجلة عبر المنصة لهذا المحل بعد.
                </p>
              ) : (
                <table className="w-full text-right text-xs">
                  <thead className="border-b border-slate-100 bg-slate-50 text-slate-600">
                    <tr>
                      <th className="px-3 py-2 font-semibold">الطلب</th>
                      <th className="px-3 py-2 font-semibold">مستحق المحل</th>
                      <th className="px-3 py-2 font-semibold">حالة التسوية</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.statement.orderRows.map((row) => (
                      <tr key={row.orderNumber}>
                        <td className="px-3 py-2 font-mono font-semibold text-slate-900">
                          {row.orderNumber}
                        </td>
                        <td className="px-3 py-2 font-mono font-semibold tabular-nums">
                          {formatEGP(row.shopDueEGP)}
                        </td>
                        <td
                          className={`px-3 py-2 font-medium ${
                            SETTLEMENT_STATUS_META[row.settlementStatus].textClass
                          }`}
                        >
                          {SETTLEMENT_STATUS_META[row.settlementStatus].label}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Order Modification Proposal Modal */}
      {modTarget && data && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <form
            onSubmit={handleSubmitModification}
            className="w-full max-w-md space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-xl"
          >
            <div>
              <h3 className="font-display text-base font-bold text-slate-900">
                تعديل صنف بالطلب {modTarget.orderNumber}
              </h3>
              <p className="mt-0.5 text-xs text-slate-600">
                الصنف الحالي: {modTarget.itemName} (يتطلب موافقة العميل قبل اعتماده)
              </p>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-700">نوع التعديل</label>
              <select
                value={modType}
                onChange={(e) => setModType(e.target.value as OrderModificationRequest['type'])}
                className="min-h-[40px] w-full rounded-lg border border-slate-200 px-3 text-xs"
              >
                <option value="substitute_item">استبدال بمنتج بديل (غير متوفر)</option>
                <option value="adjust_quantity">تعديل الكمية</option>
                <option value="remove_unavailable">إزالة الصنف غير المتوفر</option>
                <option value="price_adjustment">تعديل سعر الوحدة بموافقة العميل</option>
              </select>
            </div>

            {modType === 'substitute_item' && (
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-700">
                  المنتج البديل
                </label>
                <select
                  required
                  value={modSubProductId}
                  onChange={(e) => setModSubProductId(e.target.value)}
                  className="min-h-[40px] w-full rounded-lg border border-slate-200 px-3 text-xs"
                >
                  {data.catalog
                    .filter((c) => c.isAvailable && c.availableToSell > 0)
                    .map((c) => (
                      <option key={c.productId} value={c.productId}>
                        {c.name} ({c.packSize}) — {formatEGP(c.priceEGP)}
                      </option>
                    ))}
                </select>
              </div>
            )}

            {(modType === 'adjust_quantity' || modType === 'substitute_item') && (
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-700">
                  الكمية المقترحة
                </label>
                <input
                  type="number"
                  min="1"
                  required
                  value={modQty}
                  onChange={(e) => setModQty(Number(e.target.value))}
                  className="min-h-[40px] w-full rounded-lg border border-slate-200 px-3 font-mono text-xs"
                />
              </div>
            )}

            {modType === 'price_adjustment' && (
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-700">
                  السعر الجديد المقترح للوحدة (ج.م)
                </label>
                <input
                  type="number"
                  step="0.5"
                  min="1"
                  required
                  value={modPrice}
                  onChange={(e) => setModPrice(Number(e.target.value))}
                  className="min-h-[40px] w-full rounded-lg border border-slate-200 px-3 font-mono text-xs"
                />
              </div>
            )}

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-700">
                السبب (يظهر للعميل)
              </label>
              <input
                type="text"
                required
                value={modReason}
                onChange={(e) => setModReason(e.target.value)}
                placeholder="مثال: نفد من المخزن ونقترح البديل الموضح"
                className="min-h-[40px] w-full rounded-lg border border-slate-200 px-3 text-xs"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setModTarget(null)}
                className="min-h-[40px] rounded-lg border border-slate-200 px-4 text-xs text-slate-700"
              >
                إلغاء
              </button>
              <button
                type="submit"
                className="min-h-[40px] rounded-lg bg-teal-700 px-4 text-xs font-semibold text-white hover:bg-teal-800"
              >
                إرسال للعميل للموافقة
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
