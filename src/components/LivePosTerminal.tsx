import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Boxes,
  Check,
  CheckCircle2,
  KeyRound,
  Lock,
  LogOut,
  RefreshCw,
  ScanBarcode,
  ShieldCheck,
  ShoppingBag,
  Truck,
  Users,
  XCircle,
} from 'lucide-react';
import {
  livePosApi,
  setPosToken,
  type LivePosGateInfo,
  type LivePosWorkspaceData,
} from '../api/client';
import type { Order, OrderModificationRequest, OrderStatus } from '../types/commerce';
import {
  DELIVERY_STATUS_META,
  ORDER_STATUS_META,
  REMITTANCE_CHANNEL_LABELS,
  REMITTANCE_STATUS_META,
  formatDateTimeAr,
  formatEGP,
} from '../utils/arabicLabels';
import { ShopPosScanner } from './ShopPosScanner';

interface LivePosTerminalProps {
  shopId: string;
  qrKey: string;
  onExitToStore: () => void;
}

const DEVICE_ID_STORAGE_KEY = 'local_commerce_pos_device_id_v1';

function getOrCreatePosDeviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_ID_STORAGE_KEY);
    if (existing && existing.length >= 6) return existing;
    const created = `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    localStorage.setItem(DEVICE_ID_STORAGE_KEY, created);
    return created;
  } catch {
    return `dev_${Date.now().toString(36)}`;
  }
}

const ORDER_SUBTABS: Array<{ key: OrderStatus; label: string }> = [
  { key: 'new', label: 'الطلبات الجديدة' },
  { key: 'confirmed', label: 'المؤكدة' },
  { key: 'preparing', label: 'جاري التجهيز' },
  { key: 'ready', label: 'جاهزة / تسليم المتطوع' },
  { key: 'completed', label: 'المكتملة' },
];

export const LivePosTerminal: React.FC<LivePosTerminalProps> = ({
  shopId,
  qrKey,
  onExitToStore,
}) => {
  const [deviceId] = useState<string>(getOrCreatePosDeviceId);

  // Gate / Login state
  const [gate, setGate] = useState<LivePosGateInfo | null>(null);
  const [gateLoading, setGateLoading] = useState(true);
  const [gateError, setGateError] = useState<string | null>(null);
  const [selectedStaffId, setSelectedStaffId] = useState<string>('');
  const [pinInput, setPinInput] = useState('');
  const [openingCashInput, setOpeningCashInput] = useState('0');
  const [loggingIn, setLoggingIn] = useState(false);

  // Active workspace state
  const [workspace, setWorkspace] = useState<LivePosWorkspaceData | null>(null);
  const [lockedScreen, setLockedScreen] = useState(false);
  const [activeTab, setActiveTab] = useState<'pos' | 'orders' | 'stock' | 'shifts'>('pos');
  const [orderTab, setOrderTab] = useState<OrderStatus>('new');
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);

  // Cancel / Mod state for online orders
  const [cancellingOrder, setCancellingOrder] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [modTarget, setModTarget] = useState<{
    orderNumber: string;
    itemId: string;
    itemName: string;
    currentQty: number;
    currentPrice: number;
  } | null>(null);
  const [modType, setModType] = useState<OrderModificationRequest['type']>('substitute_item');
  const [modSubProductId, setModSubProductId] = useState('');
  const [modQty, setModQty] = useState(1);
  const [modPrice, setModPrice] = useState(10);
  const [modReason, setModReason] = useState('');

  // Quick stock/price edit state (if permission granted)
  const [stockSearch, setStockSearch] = useState('');
  const [editingProdId, setEditingProdId] = useState<string | null>(null);
  const [editPrice, setEditPrice] = useState('');
  const [editDelta, setEditDelta] = useState('0');
  const [editAvail, setEditAvail] = useState(true);
  const [editReason, setEditReason] = useState('');

  // Close shift modal
  const [closeShiftTargetId, setCloseShiftTargetId] = useState<string | null>(null);
  const [declaredCash, setDeclaredCash] = useState('');
  const [closingNote, setClosingNote] = useState('');
  const [closedSummary, setClosedSummary] = useState<{
    staffName: string;
    expectedCashEGP: number;
    declaredClosingCashEGP?: number;
    cashVarianceEGP?: number;
  } | null>(null);

  const loadGate = useCallback(async () => {
    setGateLoading(true);
    setGateError(null);
    try {
      const info = await livePosApi.getGate(shopId, qrKey);
      setGate(info);
      if (info.staffList.length > 0 && !selectedStaffId) {
        setSelectedStaffId(info.staffList[0].id);
      }
    } catch (err) {
      setGateError(err instanceof Error ? err.message : 'تعذر التحقق من رابط كاشير المحل');
    } finally {
      setGateLoading(false);
    }
  }, [shopId, qrKey, selectedStaffId]);

  useEffect(() => {
    loadGate();
  }, [loadGate]);

  const loadWorkspace = useCallback(async () => {
    try {
      const ws = await livePosApi.getWorkspace(shopId);
      setWorkspace(ws);
      // Ensure active tab is permitted for this staff member
      if (activeTab === 'pos' && !ws.staff.permissions.canPosSell) {
        if (ws.staff.permissions.canManageOnlineOrders) setActiveTab('orders');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'انتهت جلسة الوردية';
      // If server revoked token or force-closed shift, kick back to PIN login screen cleanly
      setPosToken(null);
      setWorkspace(null);
      setLockedScreen(false);
      setGateError(msg);
      await loadGate();
    }
  }, [shopId, activeTab, loadGate]);

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedStaffId) {
      setGateError('اختر الوردية أو الموظف أولًا');
      return;
    }
    setLoggingIn(true);
    setGateError(null);
    setClosedSummary(null);
    try {
      const res = await livePosApi.login(shopId, {
        qrKey,
        staffId: selectedStaffId,
        passcode: pinInput,
        deviceId,
        openingCashEGP: Number(openingCashInput || 0),
      });
      setPosToken(res.token);
      setPinInput('');
      setLockedScreen(false);
      const ws = await livePosApi.getWorkspace(shopId);
      setWorkspace(ws);
      if (ws.staff.permissions.canPosSell) {
        setActiveTab('pos');
      } else if (ws.staff.permissions.canManageOnlineOrders) {
        setActiveTab('orders');
      }
    } catch (err) {
      setGateError(err instanceof Error ? err.message : 'تعذر تسجيل الدخول');
    } finally {
      setLoggingIn(false);
    }
  };

  const handleOrderStatus = async (orderNumber: string, nextStatus: OrderStatus, reason?: string) => {
    setActionErr(null);
    setActionMsg(null);
    try {
      await livePosApi.updateOrderStatus(shopId, orderNumber, nextStatus, reason);
      setCancellingOrder(null);
      setCancelReason('');
      setActionMsg(`تم تحديث الطلب ${orderNumber} بنجاح`);
      await loadWorkspace();
    } catch (err) {
      setActionErr(err instanceof Error ? err.message : 'تعذر تحديث الطلب');
    }
  };

  const handleHandoverVolunteer = async (orderNumber: string) => {
    setActionErr(null);
    setActionMsg(null);
    try {
      await livePosApi.handoverVolunteer(shopId, orderNumber);
      setActionMsg(`تم توثيق تسليم الطلب ${orderNumber} إلى المتطوع بنجاح`);
      await loadWorkspace();
    } catch (err) {
      setActionErr(err instanceof Error ? err.message : 'تعذر توثيق تسليم المتطوع');
    }
  };

  const handleConfirmRemittance = async (orderNumber: string) => {
    setActionErr(null);
    setActionMsg(null);
    try {
      await livePosApi.confirmRemittanceReceipt(shopId, orderNumber);
      setActionMsg(`تم تأكيد استلام التحصيل من المندوب وتقفيل تسوية المحل للطلب ${orderNumber}`);
      await loadWorkspace();
    } catch (err) {
      setActionErr(err instanceof Error ? err.message : 'تعذر تأكيد استلام المبلغ');
    }
  };

  const handleSubmitModification = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!modTarget) return;
    setActionErr(null);
    try {
      await livePosApi.proposeModification(shopId, modTarget.orderNumber, {
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
      setActionMsg('تم إرسال مقترح التعديل لموافقة العميل');
      await loadWorkspace();
    } catch (err) {
      setActionErr(err instanceof Error ? err.message : 'تعذر إرسال التعديل');
    }
  };

  const handleRecordApproval = async (orderNumber: string, decision: 'approved' | 'rejected') => {
    setActionErr(null);
    try {
      await livePosApi.recordCustomerApproval(shopId, orderNumber, decision);
      setActionMsg(
        decision === 'approved' ? 'تم تسجيل موافقة العميل وتحديث الطلب' : 'تم تسجيل رفض العميل',
      );
      await loadWorkspace();
    } catch (err) {
      setActionErr(err instanceof Error ? err.message : 'تعذر تسجيل قرار العميل');
    }
  };

  const handleSaveStockEdit = async (productId: string) => {
    setActionErr(null);
    try {
      await livePosApi.updateProduct(shopId, productId, {
        priceEGP: editPrice ? Number(editPrice) : undefined,
        stockDelta: editDelta ? Number(editDelta) : 0,
        isAvailable: editAvail,
        reason: editReason,
      });
      setEditingProdId(null);
      setEditReason('');
      setActionMsg('تم تحديث الصنف في المخزون بنجاح');
      await loadWorkspace();
    } catch (err) {
      setActionErr(err instanceof Error ? err.message : 'تعذر تعديل الصنف');
    }
  };

  const handleCloseShiftSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!closeShiftTargetId || !workspace) return;
    setActionErr(null);
    try {
      const { shift: closed } = await livePosApi.closeShift(shopId, closeShiftTargetId, {
        declaredClosingCashEGP: declaredCash ? Number(declaredCash) : undefined,
        closingNote: closingNote.trim() || undefined,
      });
      const wasSelf = closeShiftTargetId === workspace.shift.id;
      setCloseShiftTargetId(null);
      setDeclaredCash('');
      setClosingNote('');

      if (wasSelf) {
        setPosToken(null);
        setWorkspace(null);
        setClosedSummary({
          staffName: closed.staffName,
          expectedCashEGP: closed.expectedCashEGP,
          declaredClosingCashEGP: closed.declaredClosingCashEGP,
          cashVarianceEGP: closed.cashVarianceEGP,
        });
        await loadGate();
      } else {
        setActionMsg(`تم تقفيل وردية "${closed.staffName}" بنجاح`);
        await loadWorkspace();
      }
    } catch (err) {
      setActionErr(err instanceof Error ? err.message : 'تعذر تقفيل الوردية');
    }
  };

  const orderCounts = useMemo(() => {
    const map: Record<OrderStatus, number> = {
      new: 0,
      confirmed: 0,
      preparing: 0,
      ready: 0,
      completed: 0,
      cancelled: 0,
    };
    for (const o of workspace?.orders ?? []) {
      map[o.status] += 1;
    }
    return map;
  }, [workspace]);

  const filteredOrders = useMemo(
    () => (workspace?.orders ?? []).filter((o) => o.status === orderTab),
    [workspace, orderTab],
  );

  const pendingShopRemittancesCount = useMemo(
    () =>
      (workspace?.orders ?? []).filter(
        (o) =>
          o.status === 'completed' &&
          o.financials.remittance?.status === 'pending_shop_confirmation',
      ).length,
    [workspace],
  );

  const filteredStock = useMemo(() => {
    const q = stockSearch.trim().toLowerCase();
    return (workspace?.catalog ?? []).filter(
      (c) =>
        !q ||
        c.name.toLowerCase().includes(q) ||
        c.category.toLowerCase().includes(q) ||
        (c.barcode && c.barcode.includes(q)),
    );
  }, [workspace, stockSearch]);

  // Screen 1: QR Gate & PIN Login (or Lock Screen)
  if (!workspace || lockedScreen) {
    const selectedStaff = gate?.staffList.find((s) => s.id === selectedStaffId);
    const selectedAlreadyOpenHere = gate?.openShifts.some((sh) => sh.staffId === selectedStaffId);

    return (
      <div className="min-h-screen bg-slate-50 px-4 py-8 text-slate-900">
        <div className="mx-auto max-w-md space-y-5">
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={onExitToStore}
              className="flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-900"
            >
              <ArrowRight className="h-3.5 w-3.5" />
              <span>العودة لواجهة المتجر</span>
            </button>
            <span className="text-xs font-semibold text-teal-800">بوابة الكاشير المباشرة</span>
          </div>

          {closedSummary && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-xs text-emerald-950 space-y-1">
              <p className="font-bold">تم تقفيل وردية {closedSummary.staffName} بنجاح</p>
              <p className="font-mono tabular-nums">
                المتوقع بالدرج: {formatEGP(closedSummary.expectedCashEGP)}
                {closedSummary.declaredClosingCashEGP !== undefined &&
                  ` · الفعلي المُسلَّم: ${formatEGP(closedSummary.declaredClosingCashEGP)}`}
              </p>
              {closedSummary.cashVarianceEGP !== undefined && (
                <p className="font-mono font-bold tabular-nums">
                  الفرق:{' '}
                  {closedSummary.cashVarianceEGP === 0
                    ? 'مطابق تمامًا (0 ج.م)'
                    : closedSummary.cashVarianceEGP > 0
                      ? `زيادة +${formatEGP(closedSummary.cashVarianceEGP)}`
                      : `عجز ${formatEGP(closedSummary.cashVarianceEGP)}`}
                </p>
              )}
            </div>
          )}

          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
            {gateLoading ? (
              <p className="py-6 text-center text-xs text-slate-500">جاري التحقق من كود المحل...</p>
            ) : gateError && !gate ? (
              <div className="space-y-3 text-center">
                <p className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs font-semibold text-rose-800">
                  {gateError}
                </p>
                <button
                  type="button"
                  onClick={onExitToStore}
                  className="min-h-[40px] rounded-lg bg-slate-900 px-4 text-xs font-semibold text-white"
                >
                  الرجوع للمتجر
                </button>
              </div>
            ) : gate ? (
              <>
                <div className="border-b border-slate-100 pb-3">
                  <div className="flex items-center justify-between gap-2">
                    <h1 className="font-display text-lg font-bold text-slate-900">
                      {gate.shop.name}
                    </h1>
                    <span className="font-mono text-xs font-semibold text-teal-800 tabular-nums">
                      {gate.openShifts.length} / {gate.maxConcurrentSessions} جلسات مفتوحة
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {lockedScreen
                      ? 'الشاشة مقفولة مؤقتًا — أدخل الباسوورد لاستكمال العمل'
                      : 'اختر ورديتك وأدخل باسوورد الموبايل لبدء البيع وتحضير الطلبات'}
                  </p>
                </div>

                {gateError && (
                  <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs font-medium text-rose-800">
                    {gateError}
                  </div>
                )}

                <form onSubmit={handleLoginSubmit} className="space-y-4">
                  <div className="space-y-2">
                    <label className="block text-xs font-semibold text-slate-700">
                      1. اختر الوردية / الموظف:
                    </label>
                    <div className="space-y-2">
                      {gate.staffList.map((st) => {
                        const isOpen = gate.openShifts.some((o) => o.staffId === st.id);
                        const selected = selectedStaffId === st.id;
                        return (
                          <button
                            key={st.id}
                            type="button"
                            onClick={() => setSelectedStaffId(st.id)}
                            className={`w-full rounded-xl border p-3 text-right transition-colors ${
                              selected
                                ? 'border-teal-700 bg-teal-50/70'
                                : 'border-slate-200 bg-white hover:bg-slate-50'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2 text-xs">
                              <span className="font-bold text-slate-900">{st.name}</span>
                              <span
                                className={
                                  st.roleTier === 'shift_supervisor'
                                    ? 'font-semibold text-teal-800'
                                    : 'text-slate-500'
                                }
                              >
                                {st.roleTier === 'shift_supervisor' ? 'مسؤول أعلى' : 'كاشير'}
                              </span>
                            </div>
                            <p className="mt-0.5 text-[11px] text-slate-500">
                              {st.shiftLabel} · {st.deviceLabel}
                              {isOpen ? ' · (مفتوحة حاليًا)' : ''}
                              {!st.hasPasscode ? ' · (بانتظار تعيين الباسوورد من صاحب المحل)' : ''}
                            </p>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-700">
                      2. رمز المرور (PIN / باسوورد الجهاز):
                    </label>
                    <div className="relative">
                      <KeyRound className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                      <input
                        type="password"
                        dir="ltr"
                        required
                        value={pinInput}
                        onChange={(e) => setPinInput(e.target.value)}
                        placeholder="أدخل باسوورد ورديتك..."
                        className="min-h-[44px] w-full rounded-lg border border-slate-300 pr-9 pl-3 text-right font-mono text-sm focus:border-teal-700 focus:outline-none"
                      />
                    </div>
                  </div>

                  {!selectedAlreadyOpenHere && !lockedScreen && (
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-700">
                        رصيد الفكة الافتتاحي بالدرج عند فتح الوردية (ج.م):
                      </label>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={openingCashInput}
                        onChange={(e) => setOpeningCashInput(e.target.value)}
                        className="min-h-[42px] w-full rounded-lg border border-slate-200 px-3 font-mono text-sm"
                      />
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={loggingIn || !selectedStaff?.hasPasscode}
                    className="min-h-[46px] w-full rounded-lg bg-teal-700 px-4 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-50"
                  >
                    {loggingIn
                      ? 'جاري فتح الجلسة...'
                      : lockedScreen || selectedAlreadyOpenHere
                        ? 'فتح القفل واستكمال الوردية'
                        : 'دخول وفتح الوردية'}
                  </button>
                </form>
              </>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  const { staff, shift, openShiftsInShop, catalog, shiftReceipts } = workspace;

  return (
    <div className="min-h-screen bg-slate-50 pb-10 text-slate-900">
      {/* Live Shift Header */}
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <span className="font-bold text-slate-900">{workspace.shop.name}</span>
              <span aria-hidden="true">·</span>
              <span className="font-semibold text-teal-800">{staff.name}</span>
              <span aria-hidden="true">·</span>
              <span>
                {staff.roleTier === 'shift_supervisor' && (
                  <ShieldCheck className="ml-1 inline h-3.5 w-3.5 text-teal-700" />
                )}
                {staff.roleTier === 'shift_supervisor' ? 'مسؤول أعلى' : 'كاشير وتجهيز'}
              </span>
            </div>
            <p className="mt-0.5 font-mono text-[11px] text-slate-600 tabular-nums">
              {shift.shiftLabel} · فواتير ورديتك: {shift.posSalesCount} (
              {formatEGP(shift.posSalesTotalEGP)}) · المتوقع بالدرج:{' '}
              <strong>{formatEGP(shift.expectedCashEGP)}</strong>
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={loadWorkspace}
              className="flex min-h-[38px] items-center gap-1 rounded-lg border border-slate-200 px-3 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span>تحديث</span>
            </button>
            <button
              type="button"
              onClick={() => setLockedScreen(true)}
              className="flex min-h-[38px] items-center gap-1 rounded-lg border border-slate-200 px-3 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              <Lock className="h-3.5 w-3.5" />
              <span>قفل مؤقت</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setCloseShiftTargetId(shift.id);
                setDeclaredCash(String(shift.expectedCashEGP));
                setClosingNote('');
              }}
              className="flex min-h-[38px] items-center gap-1 rounded-lg bg-rose-700 px-3.5 text-xs font-semibold text-white hover:bg-rose-800"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span>تقفيل الوردية</span>
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-5 px-4 py-5">
        {/* Permission-Filtered Navigation Tabs */}
        <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-slate-200 bg-white p-1.5">
          {staff.permissions.canPosSell && (
            <button
              type="button"
              onClick={() => setActiveTab('pos')}
              className={`flex min-h-[40px] items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold ${
                activeTab === 'pos'
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              <ScanBarcode className="h-4 w-4" />
              <span>البيع السريع والباركود</span>
            </button>
          )}
          {staff.permissions.canManageOnlineOrders && (
            <button
              type="button"
              onClick={() => setActiveTab('orders')}
              className={`flex min-h-[40px] items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold ${
                activeTab === 'orders'
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              <ShoppingBag className="h-4 w-4" />
              <span>
                طلبات الأونلاين وتسليم المتطوع ({orderCounts.new + orderCounts.preparing + orderCounts.ready})
              </span>
            </button>
          )}
          {staff.permissions.canAdjustPricesOrStock && (
            <button
              type="button"
              onClick={() => setActiveTab('stock')}
              className={`flex min-h-[40px] items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold ${
                activeTab === 'stock'
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              <Boxes className="h-4 w-4" />
              <span>الأسعار والمخزون</span>
            </button>
          )}
          {staff.permissions.canForceCloseShifts && (
            <button
              type="button"
              onClick={() => setActiveTab('shifts')}
              className={`flex min-h-[40px] items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold ${
                activeTab === 'shifts'
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              <Users className="h-4 w-4" />
              <span>الورديات المفتوحة ({openShiftsInShop.length})</span>
            </button>
          )}
        </div>

        {actionErr && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs font-medium text-rose-800">
            {actionErr}
          </div>
        )}
        {actionMsg && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs font-medium text-emerald-800">
            {actionMsg}
          </div>
        )}

        {/* TAB 1: LIVE POS BARCODE & SCALE */}
        {activeTab === 'pos' && staff.permissions.canPosSell && (
          <div className="space-y-5">
            <ShopPosScanner
              shopId={shopId}
              shopName={workspace.shop.name}
              catalog={catalog}
              onSaleRecorded={loadWorkspace}
              mode="live_pos"
              canAddProducts={staff.permissions.canAddProducts}
            />

            {/* Receipts recorded by this shift */}
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
              <div className="border-b border-slate-200 px-4 py-3">
                <h3 className="font-display text-sm font-bold text-slate-900">
                  فواتير ورديتك الحالية ({shiftReceipts.length})
                </h3>
              </div>
              {shiftReceipts.length === 0 ? (
                <p className="p-6 text-center text-xs text-slate-500">
                  لم تسجل فواتير في هذه الوردية بعد.
                </p>
              ) : (
                <table className="w-full text-right text-xs">
                  <thead className="border-b border-slate-100 bg-slate-50 text-slate-600">
                    <tr>
                      <th className="px-4 py-2 font-semibold">التوقيت</th>
                      <th className="px-4 py-2 font-semibold">تفاصيل الفاتورة</th>
                      <th className="px-4 py-2 font-semibold">المبلغ</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {shiftReceipts.map((r) => (
                      <tr key={r.id}>
                        <td className="px-4 py-2 text-[11px] text-slate-500">
                          {formatDateTimeAr(r.createdAt)}
                        </td>
                        <td className="px-4 py-2 text-slate-700">{r.description}</td>
                        <td className="px-4 py-2 font-mono font-bold tabular-nums">
                          {formatEGP(r.amountEGP)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {/* TAB 2: INCOMING ONLINE ORDERS & VOLUNTEER HANDOVER */}
        {activeTab === 'orders' && staff.permissions.canManageOnlineOrders && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-1.5">
              {ORDER_SUBTABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setOrderTab(t.key)}
                  className={`min-h-[38px] rounded-lg border px-3.5 py-1.5 text-xs font-semibold ${
                    orderTab === t.key
                      ? 'border-teal-700 bg-teal-700 text-white'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  {t.label} <span className="font-mono tabular-nums">({orderCounts[t.key]})</span>
                </button>
              ))}
            </div>

            {pendingShopRemittancesCount > 0 && orderTab !== 'completed' && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-950">
                <span className="font-semibold">
                  يوجد {pendingShopRemittancesCount} طلب سلّم فيه المندوب المبلغ وبانتظار تأكيد
                  استلام الكاشير لتقفيل التسوية.
                </span>
                <button
                  type="button"
                  onClick={() => setOrderTab('completed')}
                  className="font-bold text-teal-800 hover:underline"
                >
                  عرض المكتملة ←
                </button>
              </div>
            )}

            {filteredOrders.length === 0 ? (
              <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-xs text-slate-500">
                لا توجد طلبات في هذا القسم حاليًا.
              </div>
            ) : (
              <div className="space-y-4">
                {filteredOrders.map((order: Order) => (
                  <div
                    key={order.id}
                    className="space-y-3 rounded-xl border border-slate-200 bg-white p-4"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 pb-3">
                      <div>
                        <div className="flex items-center gap-2 text-xs text-slate-500">
                          <span className="font-mono font-bold text-slate-900">
                            {order.orderNumber}
                          </span>
                          <span>·</span>
                          <span>{formatDateTimeAr(order.createdAt)}</span>
                        </div>
                        <p className="mt-1 text-sm font-bold text-slate-900">
                          {order.customerName} ({order.customerPhone})
                        </p>
                        <p className="text-xs text-slate-600">{order.deliveryAddress}</p>
                        {order.deliveryNotes && (
                          <p className="mt-0.5 text-xs text-amber-800">ملاحظة: {order.deliveryNotes}</p>
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
                          {formatEGP(order.financials.shopDueEGP)}
                        </p>
                      </div>
                    </div>

                    {order.pendingModification && staff.permissions.canModifyOrCancelOrders && (
                      <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">
                        <p className="font-bold">
                          تعديل معلق ({order.pendingModification.targetProductName}):{' '}
                          {order.pendingModification.reason}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => handleRecordApproval(order.orderNumber, 'approved')}
                            className="rounded bg-teal-700 px-3 py-1 font-semibold text-white"
                          >
                            تسجيل موافقة العميل هاتفيًا
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRecordApproval(order.orderNumber, 'rejected')}
                            className="rounded border border-rose-300 bg-white px-3 py-1 font-semibold text-rose-800"
                          >
                            تسجيل رفض العميل
                          </button>
                        </div>
                      </div>
                    )}

                    <div className="divide-y divide-slate-100 text-xs">
                      {order.items.map((item) => (
                        <div key={item.id} className="flex items-center justify-between gap-2 py-2">
                          <div>
                            <span
                              className={
                                item.status === 'unavailable_removed'
                                  ? 'text-slate-400 line-through'
                                  : 'font-semibold text-slate-900'
                              }
                            >
                              {item.productName} ({item.packSize}) × {item.quantity}
                            </span>
                          </div>
                          <div className="flex items-center gap-3">
                            <span className="font-mono font-bold tabular-nums">
                              {formatEGP(item.lineTotalEGP)}
                            </span>
                            {staff.permissions.canModifyOrCancelOrders &&
                              item.status === 'active' &&
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
                                    const alt = catalog.find(
                                      (c) =>
                                        c.productId !== item.productId &&
                                        c.isAvailable &&
                                        c.availableToSell > 0,
                                    );
                                    setModSubProductId(alt?.productId ?? '');
                                  }}
                                  className="text-[11px] font-semibold text-teal-800 hover:underline"
                                >
                                  بديل / تعديل
                                </button>
                              )}
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Volunteer status & Handover section */}
                    {order.status === 'ready' && (
                      <div className="rounded-lg border border-teal-200 bg-teal-50/50 p-3 text-xs">
                        {!order.volunteerId ? (
                          <p className="font-medium text-slate-700">
                            الطلب جاهز بالمحل — بانتظار قبول متطوع التوصيل أو الإسناد.
                          </p>
                        ) : (
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <p className="font-bold text-slate-900">
                                <Truck className="ml-1 inline h-3.5 w-3.5 text-teal-700" />
                                المتطوع: {order.volunteerName}
                              </p>
                              <p className={DELIVERY_STATUS_META[order.deliveryStatus].textClass}>
                                الحالة: {DELIVERY_STATUS_META[order.deliveryStatus].label}
                              </p>
                            </div>
                            {(order.deliveryStatus === 'assigned' ||
                              order.deliveryStatus === 'heading_to_shop') && (
                              <button
                                type="button"
                                onClick={() => handleHandoverVolunteer(order.orderNumber)}
                                className="flex min-h-[38px] items-center gap-1.5 rounded-lg bg-teal-700 px-4 py-1.5 text-xs font-semibold text-white hover:bg-teal-800"
                              >
                                <CheckCircle2 className="h-4 w-4" />
                                <span>تأكيد تسليم الطلب للمتطوع</span>
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Courier Cash / InstaPay Receipt Confirmation */}
                    {order.status === 'completed' && order.financials.remittance && (
                      <div
                        className={`rounded-lg border p-3 text-xs ${
                          order.financials.remittance.status === 'pending_shop_confirmation'
                            ? 'border-amber-300 bg-amber-50/70'
                            : 'border-emerald-200 bg-emerald-50/50'
                        }`}
                      >
                        {order.financials.remittance.status === 'pending_shop_confirmation' ? (
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <p className="font-bold text-slate-900">
                                توريد من {order.volunteerName}:{' '}
                                <span className="font-mono text-teal-800 tabular-nums">
                                  {formatEGP(order.financials.remittance.amountToShopEGP)}
                                </span>{' '}
                                (
                                {
                                  REMITTANCE_CHANNEL_LABELS[
                                    order.financials.remittance.shopTransferChannel ?? 'cash'
                                  ]
                                }
                                )
                              </p>
                              <p className="text-[11px] text-slate-600 tabular-nums">
                                {order.financials.remittance.mode === 'full_to_shop'
                                  ? `كامل المبلغ — سيبقى للمنصة لدى المحل: ${formatEGP(
                                      order.financials.remittance.amountPlatformAtShopEGP,
                                    )}`
                                  : `حصة المحل فقط — سيبقى جزء المنصة مع المندوب`}
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() => handleConfirmRemittance(order.orderNumber)}
                              className="min-h-[38px] rounded-lg bg-emerald-700 px-4 text-xs font-semibold text-white hover:bg-emerald-800"
                            >
                              تأكيد استلام المبلغ من المندوب
                            </button>
                          </div>
                        ) : (
                          <p className="font-semibold text-emerald-900">
                            {REMITTANCE_STATUS_META[order.financials.remittance.status].label}
                            {order.financials.remittance.shopConfirmedBy
                              ? ` · أكد الاستلام: ${order.financials.remittance.shopConfirmedBy}`
                              : ''}
                          </p>
                        )}
                      </div>
                    )}

                    {/* Workflow buttons */}
                    <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
                      {order.status === 'new' && (
                        <button
                          type="button"
                          onClick={() => handleOrderStatus(order.orderNumber, 'confirmed')}
                          className="flex min-h-[38px] items-center gap-1.5 rounded-lg bg-teal-700 px-4 text-xs font-semibold text-white"
                        >
                          <Check className="h-3.5 w-3.5" />
                          <span>موافقة وتأكيد الطلب</span>
                        </button>
                      )}
                      {order.status === 'confirmed' && (
                        <button
                          type="button"
                          onClick={() => handleOrderStatus(order.orderNumber, 'preparing')}
                          className="min-h-[38px] rounded-lg bg-indigo-700 px-4 text-xs font-semibold text-white"
                        >
                          بدء تحضير الطلب
                        </button>
                      )}
                      {order.status === 'preparing' && (
                        <button
                          type="button"
                          onClick={() => handleOrderStatus(order.orderNumber, 'ready')}
                          className="min-h-[38px] rounded-lg bg-emerald-700 px-4 text-xs font-semibold text-white"
                        >
                          جاهز للتسليم للمتطوع (خصم المخزون)
                        </button>
                      )}
                      {staff.permissions.canModifyOrCancelOrders &&
                        (order.status === 'new' ||
                          order.status === 'confirmed' ||
                          order.status === 'preparing') && (
                          <>
                            {cancellingOrder === order.orderNumber ? (
                              <div className="flex flex-wrap items-center gap-2">
                                <input
                                  type="text"
                                  value={cancelReason}
                                  onChange={(e) => setCancelReason(e.target.value)}
                                  placeholder="سبب الرفض / الإلغاء..."
                                  className="min-h-[38px] rounded-lg border border-rose-300 px-3 text-xs"
                                />
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleOrderStatus(order.orderNumber, 'cancelled', cancelReason)
                                  }
                                  className="min-h-[38px] rounded-lg bg-rose-700 px-3 text-xs font-semibold text-white"
                                >
                                  تأكيد الرفض
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setCancellingOrder(null)}
                                  className="min-h-[38px] rounded-lg border border-slate-200 px-3 text-xs"
                                >
                                  إغلاق
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setCancellingOrder(order.orderNumber)}
                                className="flex min-h-[38px] items-center gap-1 rounded-lg border border-rose-200 px-3 text-xs font-semibold text-rose-700"
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

        {/* TAB 3: SUPERVISOR STOCK & PRICE ADJUSTMENTS */}
        {activeTab === 'stock' && staff.permissions.canAdjustPricesOrStock && (
          <div className="space-y-4">
            <input
              type="search"
              value={stockSearch}
              onChange={(e) => setStockSearch(e.target.value)}
              placeholder="بحث في أصناف المحل لتعديل السعر أو الكمية..."
              className="min-h-[40px] w-full max-w-sm rounded-lg border border-slate-200 bg-white px-3 text-xs"
            />
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
              <table className="w-full text-right text-xs">
                <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-4 py-2.5 font-semibold">المنتج</th>
                    <th className="px-4 py-2.5 font-semibold">السعر</th>
                    <th className="px-4 py-2.5 font-semibold">المتاح</th>
                    <th className="px-4 py-2.5 font-semibold">إجراء</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredStock.map((item) => {
                    const isEd = editingProdId === item.productId;
                    return (
                      <React.Fragment key={item.productId}>
                        <tr>
                          <td className="px-4 py-2.5">
                            <p className="font-semibold text-slate-900">{item.name}</p>
                            <p className="text-[11px] text-slate-500">{item.category}</p>
                          </td>
                          <td className="px-4 py-2.5 font-mono tabular-nums">
                            {formatEGP(item.priceEGP)}
                          </td>
                          <td className="px-4 py-2.5 font-mono tabular-nums">
                            {item.availableToSell}
                          </td>
                          <td className="px-4 py-2.5">
                            <button
                              type="button"
                              onClick={() => {
                                if (isEd) {
                                  setEditingProdId(null);
                                } else {
                                  setEditingProdId(item.productId);
                                  setEditPrice(String(item.priceEGP));
                                  setEditDelta('0');
                                  setEditAvail(item.isAvailable);
                                  setEditReason('');
                                }
                              }}
                              className="font-semibold text-teal-800 hover:underline"
                            >
                              {isEd ? 'إغلاق' : 'تعديل'}
                            </button>
                          </td>
                        </tr>
                        {isEd && (
                          <tr className="bg-slate-50">
                            <td colSpan={4} className="px-4 py-3">
                              <div className="flex flex-wrap items-end gap-2.5">
                                <input
                                  type="number"
                                  step="0.5"
                                  value={editPrice}
                                  onChange={(e) => setEditPrice(e.target.value)}
                                  placeholder="السعر"
                                  className="min-h-[36px] w-24 rounded border border-slate-300 bg-white px-2 font-mono text-xs"
                                />
                                <input
                                  type="number"
                                  value={editDelta}
                                  onChange={(e) => setEditDelta(e.target.value)}
                                  placeholder="تعديل كمية +/-"
                                  className="min-h-[36px] w-24 rounded border border-slate-300 bg-white px-2 font-mono text-xs"
                                />
                                <label className="flex items-center gap-1 text-xs">
                                  <input
                                    type="checkbox"
                                    checked={editAvail}
                                    onChange={(e) => setEditAvail(e.target.checked)}
                                  />
                                  <span>متاح</span>
                                </label>
                                <input
                                  type="text"
                                  value={editReason}
                                  onChange={(e) => setEditReason(e.target.value)}
                                  placeholder="سبب التعديل (إلزامي)"
                                  className="min-h-[36px] min-w-[180px] flex-1 rounded border border-slate-300 bg-white px-2.5 text-xs"
                                />
                                <button
                                  type="button"
                                  onClick={() => handleSaveStockEdit(item.productId)}
                                  className="min-h-[36px] rounded bg-slate-900 px-3.5 text-xs font-semibold text-white"
                                >
                                  حفظ
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

        {/* TAB 4: SUPERVISOR CONCURRENT SHIFTS MANAGEMENT */}
        {activeTab === 'shifts' && staff.permissions.canForceCloseShifts && (
          <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-5">
            <h3 className="font-display text-sm font-bold text-slate-900">
              الورديات المفتوحة حاليًا في المحل ({openShiftsInShop.length})
            </h3>
            <p className="text-xs text-slate-500">
              بصفتك مسؤولًا أعلى، يمكنك مراجعة الجلسات المتزامنة بالمحل أو إغلاق وردية زميلك عند
              الحاجة.
            </p>
            <div className="space-y-3">
              {openShiftsInShop.map((sh) => (
                <div
                  key={sh.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 p-3.5"
                >
                  <div>
                    <p className="text-xs font-bold text-slate-900">
                      {sh.staffName} {sh.id === shift.id ? '(أنت)' : ''}
                    </p>
                    <p className="text-[11px] text-slate-600">
                      {sh.shiftLabel} · {sh.deviceLabel} · فُتحت: {formatDateTimeAr(sh.openedAt)}
                    </p>
                    <p className="mt-1 font-mono text-xs tabular-nums">
                      فواتير: {sh.posSalesCount} · المتوقع بالدرج: {formatEGP(sh.expectedCashEGP)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setCloseShiftTargetId(sh.id);
                      setDeclaredCash(String(sh.expectedCashEGP));
                      setClosingNote('');
                    }}
                    className="min-h-[36px] rounded-lg border border-rose-300 bg-rose-50 px-3 text-xs font-semibold text-rose-800 hover:bg-rose-100"
                  >
                    {sh.id === shift.id ? 'تقفيل ورديتي' : 'تقفيل وردية الموظف'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      {/* Close Shift Cash Handover Modal */}
      {closeShiftTargetId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <form
            onSubmit={handleCloseShiftSubmit}
            className="w-full max-w-sm space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-xl"
          >
            <div>
              <h3 className="font-display text-base font-bold text-slate-900">
                تقفيل الوردية وتسليم عهدة الدرج
              </h3>
              <p className="mt-1 font-mono text-xs text-slate-600 tabular-nums">
                المبلغ المتوقع بالدرج (الفكة + المبيعات):{' '}
                <strong>
                  {formatEGP(
                    openShiftsInShop.find((s) => s.id === closeShiftTargetId)?.expectedCashEGP ??
                      shift.expectedCashEGP,
                  )}
                </strong>
              </p>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-700">
                المبلغ الفعلي المعدود في الدرج (ج.م):
              </label>
              <input
                type="number"
                step="0.5"
                min="0"
                required
                value={declaredCash}
                onChange={(e) => setDeclaredCash(e.target.value)}
                className="min-h-[42px] w-full rounded-lg border border-slate-300 px-3 font-mono text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-700">
                ملاحظة تسليم الوردية (اختياري):
              </label>
              <input
                type="text"
                value={closingNote}
                onChange={(e) => setClosingNote(e.target.value)}
                placeholder="مثال: تم تسليم الدرج والمفتاح للوردية التالية"
                className="min-h-[40px] w-full rounded-lg border border-slate-200 px-3 text-xs"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCloseShiftTargetId(null)}
                className="min-h-[40px] rounded-lg border border-slate-200 px-4 text-xs text-slate-700"
              >
                إلغاء
              </button>
              <button
                type="submit"
                className="min-h-[40px] rounded-lg bg-rose-700 px-4 text-xs font-semibold text-white hover:bg-rose-800"
              >
                تأكيد تقفيل الوردية
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Supervisor Order Modification Proposal Modal */}
      {modTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <form
            onSubmit={handleSubmitModification}
            className="w-full max-w-md space-y-3 rounded-xl border border-slate-200 bg-white p-5 shadow-xl"
          >
            <h3 className="font-display text-base font-bold text-slate-900">
              تعديل صنف بالطلب {modTarget.orderNumber}
            </h3>
            <p className="text-xs text-slate-600">{modTarget.itemName}</p>
            <select
              value={modType}
              onChange={(e) => setModType(e.target.value as OrderModificationRequest['type'])}
              className="min-h-[40px] w-full rounded-lg border border-slate-200 px-3 text-xs"
            >
              <option value="substitute_item">استبدال بمنتج بديل</option>
              <option value="adjust_quantity">تعديل الكمية</option>
              <option value="remove_unavailable">إزالة الصنف غير المتوفر</option>
              <option value="price_adjustment">تعديل السعر</option>
            </select>
            {modType === 'substitute_item' && (
              <select
                required
                value={modSubProductId}
                onChange={(e) => setModSubProductId(e.target.value)}
                className="min-h-[40px] w-full rounded-lg border border-slate-200 px-3 text-xs"
              >
                {catalog
                  .filter((c) => c.isAvailable && c.availableToSell > 0)
                  .map((c) => (
                    <option key={c.productId} value={c.productId}>
                      {c.name} — {formatEGP(c.priceEGP)}
                    </option>
                  ))}
              </select>
            )}
            {(modType === 'adjust_quantity' || modType === 'substitute_item') && (
              <input
                type="number"
                min="1"
                required
                value={modQty}
                onChange={(e) => setModQty(Number(e.target.value))}
                className="min-h-[40px] w-full rounded-lg border border-slate-200 px-3 font-mono text-xs"
              />
            )}
            {modType === 'price_adjustment' && (
              <input
                type="number"
                step="0.5"
                min="1"
                required
                value={modPrice}
                onChange={(e) => setModPrice(Number(e.target.value))}
                className="min-h-[40px] w-full rounded-lg border border-slate-200 px-3 font-mono text-xs"
              />
            )}
            <input
              type="text"
              required
              value={modReason}
              onChange={(e) => setModReason(e.target.value)}
              placeholder="السبب (يظهر للعميل)"
              className="min-h-[40px] w-full rounded-lg border border-slate-200 px-3 text-xs"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setModTarget(null)}
                className="min-h-[40px] rounded-lg border border-slate-200 px-4 text-xs"
              >
                إلغاء
              </button>
              <button
                type="submit"
                className="min-h-[40px] rounded-lg bg-teal-700 px-4 text-xs font-semibold text-white"
              >
                إرسال للعميل
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
