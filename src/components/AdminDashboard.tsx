import React, { useCallback, useEffect, useState } from 'react';
import {
  BarChart3,
  CheckCircle2,
  ClipboardCheck,
  Eye,
  Play,
  RefreshCw,
  RotateCcw,
  Settings,
  Star,
  Truck,
  Wallet,
  X,
} from 'lucide-react';
import { adminApi, type AdminOverviewData } from '../api/client';
import type { Order, VerificationStepResult } from '../types/commerce';
import {
  DELIVERY_STATUS_META,
  ORDER_STATUS_META,
  REMITTANCE_CHANNEL_LABELS,
  REMITTANCE_MODE_LABELS,
  REMITTANCE_STATUS_META,
  SETTLEMENT_STATUS_META,
  formatDateTimeAr,
  formatEGP,
} from '../utils/arabicLabels';

interface AdminDashboardProps {
  initialSection?: 'overview' | 'analytics';
}

export const AdminDashboard: React.FC<AdminDashboardProps> = ({
  initialSection = 'overview',
}) => {
  const [section, setSection] = useState<'overview' | 'settlements' | 'analytics' | 'verification'>(
    initialSection === 'analytics' ? 'analytics' : 'overview',
  );
  useEffect(() => {
    setSection(initialSection === 'analytics' ? 'analytics' : 'overview');
  }, [initialSection]);

  const [data, setData] = useState<AdminOverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  // Filters
  const [shopFilter, setShopFilter] = useState('all');
  const [volunteerFilter, setVolunteerFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // Order Inspector Modal
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [assignVolId, setAssignVolId] = useState('vol_1');
  const [reassignReason, setReassignReason] = useState('');

  // Distribution Rules form
  const [rulesFee, setRulesFee] = useState('20');
  const [rulesMode, setRulesMode] = useState<'percentage' | 'fixed'>('percentage');
  const [rulesVal, setRulesVal] = useState('75');
  const [rulesOpCost, setRulesOpCost] = useState('2');
  const [rulesComm, setRulesComm] = useState('0');

  // Verification Suite Results
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{
    allPassed: boolean;
    steps: VerificationStepResult[];
  } | null>(null);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminApi.getOverview({
        shopId: shopFilter,
        volunteerId: volunteerFilter,
        status: statusFilter,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
      });
      setData(res);
      setRulesFee(String(res.rules.defaultDeliveryFeeEGP));
      setRulesMode(res.rules.volunteerShareMode);
      setRulesVal(String(res.rules.volunteerShareValue));
      setRulesOpCost(String(res.rules.operatingCostPerOrderEGP));
      setRulesComm(String(res.rules.platformCommissionPercent));
      if (selectedOrder) {
        const refreshed = res.orders.find((o) => o.orderNumber === selectedOrder.orderNumber);
        if (refreshed) setSelectedOrder(refreshed);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل لوحة الإدارة');
    } finally {
      setLoading(false);
    }
  }, [shopFilter, volunteerFilter, statusFilter, dateFrom, dateTo, selectedOrder]);

  useEffect(() => {
    loadOverview();
  }, [shopFilter, volunteerFilter, statusFilter, dateFrom, dateTo]);

  const handleAssignVolunteer = async () => {
    if (!selectedOrder) return;
    setError(null);
    setActionMsg(null);
    try {
      const res = await adminApi.assignVolunteer(
        selectedOrder.orderNumber,
        assignVolId,
        reassignReason.trim() || undefined,
      );
      setSelectedOrder(res.order);
      setReassignReason('');
      setActionMsg(`تم إسناد الطلب ${selectedOrder.orderNumber} للمتطوع بنجاح`);
      await loadOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر إسناد المتطوع');
    }
  };

  const handleSettle = async (orderNumber: string, party: 'shop' | 'volunteer' | 'both') => {
    setError(null);
    setActionMsg(null);
    try {
      const res = await adminApi.settleOrder(orderNumber, party);
      if (selectedOrder?.orderNumber === orderNumber) {
        setSelectedOrder(res.order);
      }
      setActionMsg(`تم تسجيل التسوية للطلب ${orderNumber}`);
      await loadOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تسجيل التسوية');
    }
  };

  const handleConfirmRemittance = async (
    orderNumber: string,
    target: 'from_shop' | 'from_volunteer' | 'full',
    settleVolunteerShareToo = false,
  ) => {
    setError(null);
    setActionMsg(null);
    try {
      const res = await adminApi.confirmRemittance(orderNumber, target, settleVolunteerShareToo);
      if (selectedOrder?.orderNumber === orderNumber) {
        setSelectedOrder(res.order);
      }
      setActionMsg(`تم توثيق استلام مسار التوريد للطلب ${orderNumber}`);
      await loadOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تأكيد التوريد');
    }
  };

  const handleSaveRules = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await adminApi.updateRules({
        defaultDeliveryFeeEGP: Number(rulesFee),
        volunteerShareMode: rulesMode,
        volunteerShareValue: Number(rulesVal),
        operatingCostPerOrderEGP: Number(rulesOpCost),
        platformCommissionPercent: Number(rulesComm),
      });
      setActionMsg('تم تحديث قواعد توزيع رسوم التوصيل والتشغيل للطلبات القادمة');
      await loadOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تحديث القواعد');
    }
  };

  const handleResetDemo = async () => {
    setError(null);
    try {
      const res = await adminApi.resetDemo();
      setSelectedOrder(null);
      setActionMsg(res.message);
      await loadOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر إعادة ضبط البيانات');
    }
  };

  const handleRunVerification = async () => {
    setVerifying(true);
    setError(null);
    try {
      const res = await adminApi.runVerificationSuite();
      setVerifyResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تشغيل اختبار السيناريو');
    } finally {
      setVerifying(false);
    }
  };

  if (loading && !data) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
        جاري تحميل الإدارة المركزية...
      </div>
    );
  }

  const a = data?.analytics;

  return (
    <div className="space-y-6">
      {/* Header & Section Switcher */}
      <div className="flex flex-col justify-between gap-4 rounded-xl border border-slate-200 bg-white p-5 sm:flex-row sm:items-center">
        <div>
          <p className="text-xs text-slate-500">
            Local Commerce Operating System · وحدة الإدارة المركزية
          </p>
          <h1 className="font-display mt-1 text-xl font-bold text-slate-900">
            المتابعة التشغيلية والمالية المركزية
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={loadOverview}
            className="flex min-h-[38px] items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>تحديث</span>
          </button>
          <button
            type="button"
            onClick={handleResetDemo}
            className="flex min-h-[38px] items-center gap-1.5 rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-50"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>إعادة ضبط البيانات التجريبية</span>
          </button>
        </div>
      </div>

      {/* Sub-navigation */}
      <div className="flex flex-wrap gap-1.5 rounded-xl border border-slate-200 bg-white p-1.5">
        {[
          { id: 'overview', label: 'الطلبات والعمليات المركزية', Icon: Truck },
          { id: 'settlements', label: 'التسوية المالية وقواعد التوزيع', Icon: Wallet },
          { id: 'analytics', label: 'التقارير والتحليلات التشغيلية', Icon: BarChart3 },
          { id: 'verification', label: 'اختبار السيناريو الإلزامي', Icon: ClipboardCheck },
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

      {/* KPI Grid */}
      {a && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {[
            { label: 'المحلات / المتطوعون', value: `${a.totalShops} / ${a.totalVolunteers}` },
            { label: 'إجمالي الطلبات', value: String(a.totalOrders) },
            { label: 'الطلبات النشطة', value: String(a.activeOrders) },
            { label: 'الطلبات المكتملة', value: String(a.completedOrders) },
            { label: 'الطلبات الملغاة', value: String(a.cancelledOrders) },
            {
              label: 'مبيعات القناة (مستحق المحلات)',
              value: formatEGP(a.platformGMV),
              sub: 'ليست ربحًا للشركة',
            },
            { label: 'إجمالي رسوم التوصيل', value: formatEGP(a.totalDeliveryFees) },
            { label: 'مستحقات المحلات', value: formatEGP(a.totalShopDues) },
            { label: 'مستحقات المتطوعين', value: formatEGP(a.totalVolunteerEarnings) },
            { label: 'تكاليف التشغيل', value: formatEGP(a.totalOperatingCosts) },
            { label: 'صافي مساهمة التشغيل', value: formatEGP(a.netOperatingContribution) },
            {
              label: 'أرصدة بانتظار التسوية',
              value: formatEGP(a.unsettledShopBalance + a.unsettledVolunteerBalance),
            },
            {
              label: 'فلوسنا عند المحلات',
              value: formatEGP(a.receivableFromShopsEGP),
              sub: 'تحصيل كامل لدى السوبر ماركت',
            },
            {
              label: 'فلوسنا مع المناديب',
              value: formatEGP(a.receivableFromVolunteersEGP),
              sub: 'بانتظار التوريد / التحويل',
            },
          ].map((kpi) => (
            <div key={kpi.label} className="rounded-xl border border-slate-200 bg-white p-3.5">
              <p className="text-[11px] text-slate-500">{kpi.label}</p>
              <p className="mt-1 font-mono text-base font-bold text-slate-900 tabular-nums">
                {kpi.value}
              </p>
              {kpi.sub && <p className="mt-0.5 text-[10px] text-slate-400">{kpi.sub}</p>}
            </div>
          ))}
        </div>
      )}

      {/* SECTION 1: CENTRAL ORDERS & FILTERS */}
      {section === 'overview' && data && (
        <div className="space-y-4">
          {/* Filters */}
          <div className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-5">
            <select
              value={shopFilter}
              onChange={(e) => setShopFilter(e.target.value)}
              className="min-h-[38px] rounded-lg border border-slate-200 px-2.5 text-xs"
            >
              <option value="all">كل المحلات</option>
              {data.shops.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <select
              value={volunteerFilter}
              onChange={(e) => setVolunteerFilter(e.target.value)}
              className="min-h-[38px] rounded-lg border border-slate-200 px-2.5 text-xs"
            >
              <option value="all">كل المتطوعين</option>
              {data.volunteers.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="min-h-[38px] rounded-lg border border-slate-200 px-2.5 text-xs"
            >
              <option value="all">كل الحالات</option>
              {Object.entries(ORDER_STATUS_META).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </select>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="min-h-[38px] rounded-lg border border-slate-200 px-2.5 text-xs"
            />
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="min-h-[38px] rounded-lg border border-slate-200 px-2.5 text-xs"
            />
          </div>

          {/* Orders Table */}
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="w-full text-right text-xs">
              <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-4 py-3 font-semibold">رقم الطلب</th>
                  <th className="px-4 py-3 font-semibold">المحل والعميل</th>
                  <th className="px-4 py-3 font-semibold">الحالة والتوصيل</th>
                  <th className="px-4 py-3 font-semibold">المتطوع</th>
                  <th className="px-4 py-3 font-semibold">المنتجات / التوصيل</th>
                  <th className="px-4 py-3 font-semibold">التسوية</th>
                  <th className="px-4 py-3 font-semibold">عرض الرحلة</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.orders.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-slate-500">
                      لا توجد طلبات مطابقة للفلاتر الحالية. أنشئ طلبًا من واجهة العميل أو شغّل
                      السيناريو الاختباري.
                    </td>
                  </tr>
                ) : (
                  data.orders.map((order) => (
                    <tr key={order.id} className="hover:bg-slate-50/70">
                      <td className="px-4 py-3">
                        <p className="font-mono font-bold text-slate-900">{order.orderNumber}</p>
                        <p className="text-[11px] text-slate-400">
                          {formatDateTimeAr(order.createdAt)}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-semibold text-slate-900">{order.shopName}</p>
                        <p className="text-slate-600">{order.customerName}</p>
                      </td>
                      <td className="px-4 py-3">
                        <p className={`font-semibold ${ORDER_STATUS_META[order.status].textClass}`}>
                          {ORDER_STATUS_META[order.status].label}
                        </p>
                        <p
                          className={`text-[11px] ${
                            DELIVERY_STATUS_META[order.deliveryStatus].textClass
                          }`}
                        >
                          {DELIVERY_STATUS_META[order.deliveryStatus].label}
                        </p>
                      </td>
                      <td className="px-4 py-3 text-slate-700">
                        {order.volunteerName ?? 'غير مسند'}
                      </td>
                      <td className="px-4 py-3 font-mono tabular-nums">
                        <p className="font-semibold text-slate-900">
                          {formatEGP(order.financials.itemsTotalEGP)}
                        </p>
                        <p className="text-[11px] text-slate-500">
                          + توصيل {formatEGP(order.financials.deliveryFeeEGP)}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <p
                          className={`font-medium ${
                            SETTLEMENT_STATUS_META[order.financials.settlementStatus].textClass
                          }`}
                        >
                          {SETTLEMENT_STATUS_META[order.financials.settlementStatus].label}
                        </p>
                        {order.financials.remittance && (
                          <p className="mt-0.5 text-[10px] text-slate-600 tabular-nums">
                            {order.financials.remittance.mode === 'full_to_shop' &&
                            order.financials.remittance.shopConfirmedAt &&
                            !order.financials.remittance.platformConfirmedAt
                              ? `فلوسنا عند المحل: ${formatEGP(order.financials.remittance.amountPlatformAtShopEGP)}`
                              : order.financials.remittance.mode === 'split_shop_and_courier' &&
                                  order.financials.remittance.shopConfirmedAt &&
                                  !order.financials.remittance.platformConfirmedAt
                                ? `جزء المنصة مع المندوب: ${formatEGP(order.financials.remittance.amountWithCourierForPlatformEGP)}`
                                : REMITTANCE_STATUS_META[order.financials.remittance.status].label}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedOrder(order);
                            setAssignVolId(order.volunteerId ?? 'vol_1');
                          }}
                          className="flex items-center gap-1 font-semibold text-teal-800 hover:underline"
                        >
                          <Eye className="h-3.5 w-3.5" />
                          <span>تفاصيل الرحلة</span>
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SECTION 2: SETTLEMENTS & RULES */}
      {section === 'settlements' && data && (
        <div className="space-y-6">
          {/* Distribution Rules Form */}
          <form
            onSubmit={handleSaveRules}
            className="grid gap-3 rounded-xl border border-slate-200 bg-white p-5 sm:grid-cols-5"
          >
            <div className="flex items-center gap-2 sm:col-span-5">
              <Settings className="h-4 w-4 text-teal-700" />
              <h2 className="font-display text-sm font-bold text-slate-900">
                قواعد توزيع رسوم التوصيل والتشغيل
              </h2>
            </div>
            <div>
              <label className="mb-1 block text-[11px] text-slate-600">رسوم التوصيل (ج.م)</label>
              <input
                type="number"
                step="0.5"
                min="0"
                value={rulesFee}
                onChange={(e) => setRulesFee(e.target.value)}
                className="min-h-[38px] w-full rounded-lg border border-slate-200 px-2.5 font-mono text-xs"
              />
            </div>
            <div>
              <label className="mb-1 block text-[11px] text-slate-600">نمط حصة المتطوع</label>
              <select
                value={rulesMode}
                onChange={(e) => setRulesMode(e.target.value as 'percentage' | 'fixed')}
                className="min-h-[38px] w-full rounded-lg border border-slate-200 px-2.5 text-xs"
              >
                <option value="percentage">نسبة مئوية % من رسوم التوصيل</option>
                <option value="fixed">مبلغ ثابت بالجنيه</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[11px] text-slate-600">
                قيمة حصة المتطوع ({rulesMode === 'percentage' ? '%' : 'ج.م'})
              </label>
              <input
                type="number"
                step="0.5"
                min="0"
                value={rulesVal}
                onChange={(e) => setRulesVal(e.target.value)}
                className="min-h-[38px] w-full rounded-lg border border-slate-200 px-2.5 font-mono text-xs"
              />
            </div>
            <div>
              <label className="mb-1 block text-[11px] text-slate-600">
                تكلفة التشغيل/طلب (ج.م)
              </label>
              <input
                type="number"
                step="0.5"
                min="0"
                value={rulesOpCost}
                onChange={(e) => setRulesOpCost(e.target.value)}
                className="min-h-[38px] w-full rounded-lg border border-slate-200 px-2.5 font-mono text-xs"
              />
            </div>
            <div className="flex items-end">
              <button
                type="submit"
                className="min-h-[38px] w-full rounded-lg bg-slate-900 px-4 text-xs font-semibold text-white hover:bg-teal-700"
              >
                حفظ القواعد
              </button>
            </div>
          </form>

          {/* Independent Shop Statements */}
          <div className="grid gap-4 lg:grid-cols-2">
            {data.shopStatements.map((st) => (
              <div key={st.shopId} className="rounded-xl border border-slate-200 bg-white p-5">
                <h3 className="font-display text-base font-bold text-slate-900">
                  كشف حساب مستقل: {st.shopName}
                </h3>
                <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                  <div className="rounded-lg bg-slate-50 p-3">
                    <p className="text-slate-500">إجمالي مستحقات المنصة للمحل</p>
                    <p className="mt-1 font-mono text-base font-bold text-slate-900 tabular-nums">
                      {formatEGP(st.totalShopDueEGP)}
                    </p>
                  </div>
                  <div className="rounded-lg bg-slate-50 p-3">
                    <p className="text-slate-500">رصيد بانتظار التسوية</p>
                    <p className="mt-1 font-mono text-base font-bold text-amber-700 tabular-nums">
                      {formatEGP(st.pendingSettlementToShopEGP)}
                    </p>
                  </div>
                  <div className="rounded-lg bg-slate-50 p-3">
                    <p className="text-slate-500">ما تم تسويته للمحل</p>
                    <p className="mt-1 font-mono text-sm font-semibold text-emerald-700 tabular-nums">
                      {formatEGP(st.settledToShopEGP)}
                    </p>
                  </div>
                  <div className="rounded-lg bg-slate-50 p-3">
                    <p className="text-slate-500">فلوسنا عند السوبر ماركت</p>
                    <p className="mt-1 font-mono text-sm font-bold text-indigo-800 tabular-nums">
                      {formatEGP(st.platformReceivableFromShopEGP)}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Independent Volunteer Statements */}
          <div className="grid gap-4 lg:grid-cols-2">
            {data.volunteerStatements.map((vst) => (
              <div key={vst.volunteerId} className="rounded-xl border border-slate-200 bg-white p-5">
                <h3 className="font-display text-base font-bold text-slate-900">
                  كشف حساب مستقل: {vst.volunteerName}
                </h3>
                <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                  <div className="rounded-lg bg-slate-50 p-3">
                    <p className="text-slate-500">إجمالي التحصيل النقدي</p>
                    <p className="mt-1 font-mono text-base font-bold text-slate-900 tabular-nums">
                      {formatEGP(vst.totalCashCollectedEGP)}
                    </p>
                  </div>
                  <div className="rounded-lg bg-slate-50 p-3">
                    <p className="text-slate-500">مستحق المتطوع الإجمالي</p>
                    <p className="mt-1 font-mono text-base font-bold text-teal-800 tabular-nums">
                      {formatEGP(vst.totalVolunteerEarningsEGP)}
                    </p>
                  </div>
                  <div className="rounded-lg bg-slate-50 p-3">
                    <p className="text-slate-500">مورّد للمحلات / إنستاباي</p>
                    <p className="mt-1 font-mono text-sm font-semibold text-emerald-700 tabular-nums">
                      {formatEGP(vst.remittedToShopTotalEGP + vst.remittedDirectInstapayEGP)}
                    </p>
                  </div>
                  <div className="rounded-lg bg-slate-50 p-3">
                    <p className="text-slate-500">المتبقي في عهدة المندوب للتوريد</p>
                    <p className="mt-1 font-mono text-sm font-bold text-rose-700 tabular-nums">
                      {formatEGP(vst.cashToRemitEGP)}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* SECTION 3: ANALYTICS REPORTS */}
      {section === 'analytics' && a && (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <p className="text-xs text-slate-500">متوسط زمن تجهيز المحل (منفصل)</p>
              <p className="mt-1 font-mono text-xl font-bold text-indigo-800 tabular-nums">
                {a.avgShopPrepMinutes} دقيقة
              </p>
              <p className="mt-1 text-[11px] text-slate-400">من التأكيد حتى الجاهزية</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <p className="text-xs text-slate-500">متوسط زمن التوصيل (منفصل)</p>
              <p className="mt-1 font-mono text-xl font-bold text-teal-800 tabular-nums">
                {a.avgDeliveryMinutes} دقيقة
              </p>
              <p className="mt-1 text-[11px] text-slate-400">من الاستلام من المحل حتى العميل</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <p className="text-xs text-slate-500">متوسط قيمة الطلب (AOV)</p>
              <p className="mt-1 font-mono text-xl font-bold text-slate-900 tabular-nums">
                {formatEGP(a.avgOrderValueEGP)}
              </p>
              <p className="mt-1 text-[11px] text-slate-400">
                جدد: {a.newCustomersCount} · متكررون: {a.returningCustomersCount}
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <p className="text-xs text-slate-500">اقتصاديات الطلب الواحد</p>
              <p className="mt-1 font-mono text-base font-bold text-emerald-800 tabular-nums">
                صافي المساهمة: {formatEGP(a.netContributionPerOrderEGP)}
              </p>
              <p className="mt-1 text-[11px] text-slate-500 tabular-nums">
                تكلفة التنفيذ: {formatEGP(a.fulfillmentCostPerOrderEGP)}
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <p className="text-xs text-slate-500">نسبة الطلبات الملغاة</p>
              <p className="mt-1 font-mono text-xl font-bold text-rose-700 tabular-nums">
                {a.cancellationRatePercent}%
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <p className="text-xs text-slate-500">نسبة الأصناف غير المتوفرة</p>
              <p className="mt-1 font-mono text-xl font-bold text-amber-700 tabular-nums">
                {a.unavailableItemRatePercent}%
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <p className="text-xs text-slate-500">المحل الأكثر نشاطًا</p>
              <p className="mt-1 font-display text-base font-bold text-slate-900">
                {a.mostActiveShop ? a.mostActiveShop.shopName : 'لا توجد طلبات بعد'}
              </p>
              {a.mostActiveShop && (
                <p className="text-[11px] text-slate-500 tabular-nums">
                  {a.mostActiveShop.ordersCount} طلب · {formatEGP(a.mostActiveShop.gmvEGP)}
                </p>
              )}
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <p className="text-xs text-slate-500">إجمالي فروق التحصيل النقدي</p>
              <p className="mt-1 font-mono text-xl font-bold text-slate-900 tabular-nums">
                {formatEGP(a.totalCashDiscrepancy)}
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <p className="text-xs text-slate-500">متوسط رضا العملاء</p>
              <p className="mt-1 flex items-center gap-1.5 font-mono text-xl font-bold text-amber-700 tabular-nums">
                <Star className="h-5 w-5 fill-amber-400 text-amber-500" />
                <span>{a.averageRating !== null ? `${a.averageRating}/5` : '—'}</span>
              </p>
              <p className="mt-1 text-[11px] text-slate-500 tabular-nums">
                {a.ratingsCount > 0 ? `من ${a.ratingsCount} تقييم` : 'بانتظار أول تقييم'}
              </p>
            </div>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            {/* Top Products */}
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
              <div className="border-b border-slate-200 px-5 py-3.5">
                <h3 className="font-display text-sm font-bold text-slate-900">
                  المنتجات الأكثر طلبًا
                </h3>
              </div>
              {a.topProducts.length === 0 ? (
                <p className="p-6 text-center text-xs text-slate-500">
                  ستظهر المنتجات الأكثر طلبًا بمجرد تسجيل طلبات مكتملة أو فعالة.
                </p>
              ) : (
                <table className="w-full text-right text-xs">
                  <thead className="border-b border-slate-100 bg-slate-50 text-slate-600">
                    <tr>
                      <th className="px-4 py-2.5 font-semibold">المنتج</th>
                      <th className="px-4 py-2.5 font-semibold">الكمية المطلوبة</th>
                      <th className="px-4 py-2.5 font-semibold">إجمالي القيمة</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {a.topProducts.map((p) => (
                      <tr key={p.productId}>
                        <td className="px-4 py-2.5 font-medium text-slate-900">{p.productName}</td>
                        <td className="px-4 py-2.5 font-mono tabular-nums">{p.totalQuantity}</td>
                        <td className="px-4 py-2.5 font-mono font-semibold tabular-nums">
                          {formatEGP(p.totalRevenueEGP)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Shop Activity Comparison */}
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
              <div className="border-b border-slate-200 px-5 py-3.5">
                <h3 className="font-display text-sm font-bold text-slate-900">
                  مقارنة أداء المحلات
                </h3>
              </div>
              <table className="w-full text-right text-xs">
                <thead className="border-b border-slate-100 bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-4 py-2.5 font-semibold">المحل</th>
                    <th className="px-4 py-2.5 font-semibold">الطلبات</th>
                    <th className="px-4 py-2.5 font-semibold">المكتملة</th>
                    <th className="px-4 py-2.5 font-semibold">متوسط التجهيز</th>
                    <th className="px-4 py-2.5 font-semibold">التقييم</th>
                    <th className="px-4 py-2.5 font-semibold">المبيعات</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {a.shopBreakdown.map((s) => (
                    <tr key={s.shopId}>
                      <td className="px-4 py-2.5 font-semibold text-slate-900">{s.shopName}</td>
                      <td className="px-4 py-2.5 font-mono tabular-nums">{s.ordersCount}</td>
                      <td className="px-4 py-2.5 font-mono tabular-nums">{s.completedCount}</td>
                      <td className="px-4 py-2.5 font-mono tabular-nums">
                        {s.avgPrepMinutes} د
                      </td>
                      <td className="px-4 py-2.5 font-mono tabular-nums">
                        {s.averageRating !== null ? (
                          <span className="inline-flex items-center gap-1 font-semibold text-amber-700">
                            <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-500" />
                            <span>
                              {s.averageRating}/5 ({s.ratingsCount})
                            </span>
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="px-4 py-2.5 font-mono font-semibold tabular-nums">
                        {formatEGP(s.gmvEGP)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* SECTION 4: MANDATORY VERIFICATION SUITE */}
      {section === 'verification' && (
        <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="font-display text-base font-bold text-slate-900">
                تشغيل سيناريو الاختبار الإلزامي المتكامل
              </h2>
              <p className="mt-1 text-xs text-slate-600">
                يختبر هذا المسار البرمجي المعزول جميع خطوات الطلب الـ 17 لماركت النور والمتطوع الأول،
                وتكرارها لماركت الأمانة والمتطوع الثاني، بالإضافة إلى الإلغاء، المنتج غير المتوفر،
                تعديل الكمية، رفض البديل، إعادة الإسناد، فشل التوصيل، واختلاف مبلغ التحصيل.
              </p>
            </div>
            <button
              type="button"
              onClick={handleRunVerification}
              disabled={verifying}
              className="flex min-h-[42px] items-center gap-2 rounded-lg bg-teal-700 px-5 py-2 text-xs font-semibold text-white hover:bg-teal-800 disabled:opacity-50"
            >
              <Play className="h-4 w-4" />
              <span>{verifying ? 'جاري التنفيذ...' : 'تشغيل الاختبار الإلزامي الآن'}</span>
            </button>
          </div>

          {verifyResult && (
            <div className="space-y-3 border-t border-slate-100 pt-4">
              <div
                className={`rounded-lg border p-3 text-sm font-bold ${
                  verifyResult.allPassed
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                    : 'border-rose-200 bg-rose-50 text-rose-900'
                }`}
              >
                {verifyResult.allPassed
                  ? 'نجحت جميع اختبارات السيناريو الإلزامي والحالات الحدية بنسبة 100%'
                  : 'فشلت بعض خطوات الاختبار، راجع التفاصيل بالأسفل'}
              </div>
              <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                {verifyResult.steps.map((s, idx) => (
                  <div key={idx} className="flex items-start gap-3 p-3.5 text-xs">
                    <CheckCircle2
                      className={`mt-0.5 h-4 w-4 shrink-0 ${
                        s.passed ? 'text-emerald-600' : 'text-rose-600'
                      }`}
                    />
                    <div>
                      <p className="font-semibold text-slate-900">{s.step}</p>
                      <p className="mt-0.5 text-slate-600">{s.details}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Order Journey Inspector Modal */}
      {selectedOrder && data && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
              <div>
                <h2 className="font-mono text-lg font-bold text-slate-900">
                  رحلة الطلب {selectedOrder.orderNumber}
                </h2>
                <p className="text-xs text-slate-500">
                  {selectedOrder.shopName} · العميل: {selectedOrder.customerName} (
                  {selectedOrder.customerPhone})
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedOrder(null)}
                className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 space-y-5 overflow-y-auto p-6 text-xs">
              {/* Financial Breakdown */}
              <div className="grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:grid-cols-4">
                <div>
                  <p className="text-slate-500">مستحق المحل</p>
                  <p className="mt-0.5 font-mono text-sm font-bold text-slate-900 tabular-nums">
                    {formatEGP(selectedOrder.financials.shopDueEGP)}
                  </p>
                </div>
                <div>
                  <p className="text-slate-500">رسوم التوصيل</p>
                  <p className="mt-0.5 font-mono text-sm font-bold text-slate-900 tabular-nums">
                    {formatEGP(selectedOrder.financials.deliveryFeeEGP)}
                  </p>
                </div>
                <div>
                  <p className="text-slate-500">مستحق المتطوع</p>
                  <p className="mt-0.5 font-mono text-sm font-bold text-teal-800 tabular-nums">
                    {formatEGP(selectedOrder.financials.volunteerShareEGP)}
                  </p>
                </div>
                <div>
                  <p className="text-slate-500">المحصل / الفرق</p>
                  <p className="mt-0.5 font-mono text-sm font-bold text-slate-900 tabular-nums">
                    {formatEGP(selectedOrder.financials.collectedAmountEGP)} (
                    {formatEGP(selectedOrder.financials.collectionDiscrepancyEGP)})
                  </p>
                </div>
              </div>

              {/* Volunteer Assignment / Reassignment */}
              {selectedOrder.status === 'ready' &&
                selectedOrder.deliveryStatus !== 'delivered' &&
                selectedOrder.deliveryStatus !== 'delivery_failed' && (
                  <div className="space-y-2 rounded-xl border border-slate-200 p-4">
                    <h3 className="font-display text-sm font-bold text-slate-900">
                      {selectedOrder.volunteerId
                        ? `إعادة إسناد المتطوع (الحالي: ${selectedOrder.volunteerName})`
                        : 'إسناد الطلب إلى متطوع للتوصيل'}
                    </h3>
                    <div className="flex flex-wrap gap-2">
                      <select
                        value={assignVolId}
                        onChange={(e) => setAssignVolId(e.target.value)}
                        className="min-h-[38px] rounded-lg border border-slate-200 px-3 text-xs"
                      >
                        {data.volunteers.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.name} ({v.area})
                          </option>
                        ))}
                      </select>
                      {selectedOrder.volunteerId &&
                        selectedOrder.volunteerId !== assignVolId && (
                          <input
                            type="text"
                            value={reassignReason}
                            onChange={(e) => setReassignReason(e.target.value)}
                            placeholder="سبب إعادة الإسناد (إلزامي)"
                            className="min-h-[38px] flex-1 rounded-lg border border-amber-300 px-3 text-xs"
                          />
                        )}
                      <button
                        type="button"
                        onClick={handleAssignVolunteer}
                        className="min-h-[38px] rounded-lg bg-slate-900 px-4 font-semibold text-white hover:bg-teal-700"
                      >
                        حفظ الإسناد
                      </button>
                    </div>
                  </div>
                )}

              {/* Settlement & Remittance Actions */}
              {selectedOrder.status === 'completed' && (
                <div className="space-y-3 rounded-xl border border-slate-200 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-bold text-slate-900">
                        حالة التسوية:{' '}
                        <span
                          className={
                            SETTLEMENT_STATUS_META[selectedOrder.financials.settlementStatus]
                              .textClass
                          }
                        >
                          {SETTLEMENT_STATUS_META[selectedOrder.financials.settlementStatus].label}
                        </span>
                      </p>
                      <p className="text-[11px] text-slate-500">
                        تكلفة التشغيل: {formatEGP(selectedOrder.financials.operatingCostEGP)} · صافي
                        مساهمة الإدارة: {formatEGP(selectedOrder.financials.platformRevenueEGP)}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {!selectedOrder.financials.shopSettledAt && (
                        <button
                          type="button"
                          onClick={() => handleSettle(selectedOrder.orderNumber, 'shop')}
                          className="min-h-[36px] rounded-lg border border-teal-700 px-3 font-semibold text-teal-800 hover:bg-teal-50"
                        >
                          تسوية المحل
                        </button>
                      )}
                      {!selectedOrder.financials.volunteerSettledAt && (
                        <button
                          type="button"
                          onClick={() => handleSettle(selectedOrder.orderNumber, 'volunteer')}
                          className="min-h-[36px] rounded-lg border border-indigo-700 px-3 font-semibold text-indigo-800 hover:bg-indigo-50"
                        >
                          تسوية المتطوع
                        </button>
                      )}
                      {selectedOrder.financials.settlementStatus !== 'fully_settled' && (
                        <button
                          type="button"
                          onClick={() => handleSettle(selectedOrder.orderNumber, 'both')}
                          className="min-h-[36px] rounded-lg bg-emerald-700 px-4 font-semibold text-white hover:bg-emerald-800"
                        >
                          تسوية بالكامل
                        </button>
                      )}
                    </div>
                  </div>

                  {selectedOrder.financials.remittance && (
                    <div className="space-y-2 border-t border-slate-100 pt-3">
                      {(() => {
                        const rem = selectedOrder.financials.remittance!;
                        return (
                          <>
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div>
                                <p className="font-bold text-slate-900">
                                  مسار التوريد: {REMITTANCE_MODE_LABELS[rem.mode]}
                                </p>
                                <p className="text-[11px] text-slate-600 tabular-nums">
                                  {rem.shopTransferChannel
                                    ? `للمحل: ${formatEGP(rem.amountToShopEGP)} (${
                                        REMITTANCE_CHANNEL_LABELS[rem.shopTransferChannel]
                                      })`
                                    : ''}
                                  {rem.instapayReference
                                    ? ` · مرجع إنستاباي: ${rem.instapayReference}`
                                    : ''}
                                  {rem.shopConfirmedBy
                                    ? ` · أكد المحل: ${rem.shopConfirmedBy}`
                                    : ''}
                                </p>
                                <p className={`text-[11px] font-semibold ${REMITTANCE_STATUS_META[rem.status].textClass}`}>
                                  {REMITTANCE_STATUS_META[rem.status].label}
                                  {rem.mode === 'full_to_shop' && rem.shopConfirmedAt && !rem.platformConfirmedAt
                                    ? ` · فلوسنا عند السوبر ماركت: ${formatEGP(rem.amountPlatformAtShopEGP)}`
                                    : rem.mode === 'split_shop_and_courier' && rem.shopConfirmedAt && !rem.platformConfirmedAt
                                      ? ` · الجزء بتاعنا مع المندوب: ${formatEGP(rem.amountWithCourierForPlatformEGP)}`
                                      : ''}
                                </p>
                              </div>
                              <div className="flex flex-wrap gap-2">
                                {rem.mode === 'full_to_shop' &&
                                  rem.shopConfirmedAt &&
                                  !rem.platformConfirmedAt && (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        handleConfirmRemittance(
                                          selectedOrder.orderNumber,
                                          'from_shop',
                                          true,
                                        )
                                      }
                                      className="min-h-[36px] rounded-lg bg-indigo-700 px-3 font-semibold text-white hover:bg-indigo-800"
                                    >
                                      استلام نصيبنا من السوبر ماركت ({formatEGP(rem.amountPlatformAtShopEGP)})
                                    </button>
                                  )}
                                {((rem.mode === 'split_shop_and_courier' && rem.shopConfirmedAt) ||
                                  rem.mode === 'full_to_platform_instapay') &&
                                  !rem.platformConfirmedAt && (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        handleConfirmRemittance(
                                          selectedOrder.orderNumber,
                                          'from_volunteer',
                                          true,
                                        )
                                      }
                                      className="min-h-[36px] rounded-lg bg-indigo-700 px-3 font-semibold text-white hover:bg-indigo-800"
                                    >
                                      استلام المبلغ من المندوب (
                                      {formatEGP(
                                        rem.mode === 'full_to_platform_instapay'
                                          ? rem.amountDirectToPlatformEGP
                                          : rem.amountWithCourierForPlatformEGP,
                                      )}
                                      )
                                    </button>
                                  )}
                              </div>
                            </div>
                          </>
                        );
                      })()}
                    </div>
                  )}
                </div>
              )}

              {/* Customer Rating Display */}
              {selectedOrder.rating && (
                <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-4 space-y-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 font-bold text-amber-950">
                      <Star className="h-4 w-4 fill-amber-400 text-amber-500" />
                      <span>
                        تقييم {selectedOrder.rating.customerName}: {selectedOrder.rating.overallRating}/5
                      </span>
                    </span>
                    <span className="text-[11px] text-amber-900">
                      {selectedOrder.rating.shopRating
                        ? `المحل: ${selectedOrder.rating.shopRating}/5`
                        : ''}
                      {selectedOrder.rating.shopRating && selectedOrder.rating.deliveryRating
                        ? ' · '
                        : ''}
                      {selectedOrder.rating.deliveryRating
                        ? `المتطوع: ${selectedOrder.rating.deliveryRating}/5`
                        : ''}
                    </span>
                  </div>
                  {selectedOrder.rating.complimentTags.length > 0 && (
                    <p className="text-amber-900">
                      {selectedOrder.rating.complimentTags.join(' · ')}
                    </p>
                  )}
                  {selectedOrder.rating.comment && (
                    <p className="text-slate-700">"{selectedOrder.rating.comment}"</p>
                  )}
                </div>
              )}

              {/* Items */}
              <div>
                <h3 className="font-display text-sm font-bold text-slate-900">المنتجات</h3>
                <div className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200">
                  {selectedOrder.items.map((i) => (
                    <div key={i.id} className="flex justify-between px-3 py-2">
                      <span
                        className={
                          i.status === 'unavailable_removed' ? 'text-slate-400 line-through' : ''
                        }
                      >
                        {i.productName} × {i.quantity}
                      </span>
                      <span className="font-mono font-semibold tabular-nums">
                        {formatEGP(i.lineTotalEGP)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Timeline */}
              <div>
                <h3 className="font-display text-sm font-bold text-slate-900">
                  السجل الزمني الكامل للعمليات
                </h3>
                <ol className="mt-2 space-y-2.5">
                  {selectedOrder.timeline.map((ev) => (
                    <li key={ev.id} className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-slate-900">{ev.title}</span>
                        <span className="text-[11px] text-slate-500">
                          {formatDateTimeAr(ev.timestamp)} · {ev.actorName}
                        </span>
                      </div>
                      {ev.details && <p className="mt-1 text-slate-600">{ev.details}</p>}
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
