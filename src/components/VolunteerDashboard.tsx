import React, { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  MapPin,
  Phone,
  RefreshCw,
  Star,
  Store,
  Truck,
  Wallet,
  XCircle,
} from 'lucide-react';
import {
  volunteerApi,
  type VolunteerDashboardData,
  type VolunteerOrderView,
} from '../api/client';
import type { CashRemittanceMode, DeliveryStatus, RemittanceChannel } from '../types/commerce';
import {
  DELIVERY_STATUS_META,
  REMITTANCE_CHANNEL_LABELS,
  REMITTANCE_MODE_LABELS,
  REMITTANCE_STATUS_META,
  SETTLEMENT_STATUS_META,
  formatDateTimeAr,
  formatEGP,
} from '../utils/arabicLabels';

interface VolunteerDashboardProps {
  volunteerId: string;
}

export const VolunteerDashboard: React.FC<VolunteerDashboardProps> = ({ volunteerId }) => {
  const [data, setData] = useState<VolunteerDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  // Delivery collection form state
  const [deliveringOrder, setDeliveringOrder] = useState<VolunteerOrderView | null>(null);
  const [collectedCash, setCollectedCash] = useState<string>('');
  const [discrepancyNote, setDiscrepancyNote] = useState<string>('');
  const [remMode, setRemMode] = useState<CashRemittanceMode>('full_to_shop');
  const [remShopChannel, setRemShopChannel] = useState<RemittanceChannel>('cash');
  const [remInstapayRef, setRemInstapayRef] = useState<string>('');
  const [remNote, setRemNote] = useState<string>('');

  // Standalone post-delivery remittance modal
  const [remitTargetRow, setRemitTargetRow] = useState<{
    orderNumber: string;
    shopName: string;
    collectedAmountEGP: number;
    shopDueEGP: number;
  } | null>(null);

  // Failure form state
  const [failingOrderNumber, setFailingOrderNumber] = useState<string | null>(null);
  const [failureReason, setFailureReason] = useState<string>('');

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await volunteerApi.getDashboard(volunteerId);
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل لوحة المتطوع');
    } finally {
      setLoading(false);
    }
  }, [volunteerId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleClaim = async (orderNumber: string) => {
    setError(null);
    setActionMsg(null);
    try {
      await volunteerApi.claimOrder(volunteerId, orderNumber);
      setActionMsg(`تم استلام مهمة توصيل الطلب ${orderNumber}`);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر قبول الطلب');
    }
  };

  const handleUpdateTrip = async (orderNumber: string, nextDeliveryStatus: DeliveryStatus) => {
    setError(null);
    setActionMsg(null);
    try {
      await volunteerApi.updateStatus(volunteerId, orderNumber, { nextDeliveryStatus });
      setActionMsg(`تم تحديث حالة رحلة الطلب ${orderNumber}`);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تحديث حالة التوصيل');
    }
  };

  const handleConfirmDelivery = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!deliveringOrder) return;
    setError(null);
    try {
      await volunteerApi.updateStatus(volunteerId, deliveringOrder.orderNumber, {
        nextDeliveryStatus: 'delivered',
        collectedAmountEGP: Number(collectedCash),
        discrepancyNote: discrepancyNote.trim() || undefined,
        remittance: {
          mode: remMode,
          shopTransferChannel: remMode === 'full_to_platform_instapay' ? undefined : remShopChannel,
          platformTransferChannel: remMode === 'full_to_platform_instapay' ? 'instapay' : undefined,
          instapayReference: remInstapayRef.trim() || undefined,
          note: remNote.trim() || undefined,
        },
      });
      setActionMsg(
        `تم تسليم الطلب ${deliveringOrder.orderNumber} وتسجيل التحصيل النقدي ومسار التوريد`,
      );
      setDeliveringOrder(null);
      setDiscrepancyNote('');
      setRemInstapayRef('');
      setRemNote('');
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تأكيد التسليم');
    }
  };

  const handleSubmitStandaloneRemittance = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!remitTargetRow) return;
    setError(null);
    setActionMsg(null);
    try {
      await volunteerApi.submitRemittance(volunteerId, remitTargetRow.orderNumber, {
        mode: remMode,
        shopTransferChannel: remMode === 'full_to_platform_instapay' ? undefined : remShopChannel,
        platformTransferChannel: remMode === 'full_to_platform_instapay' ? 'instapay' : undefined,
        instapayReference: remInstapayRef.trim() || undefined,
        note: remNote.trim() || undefined,
      });
      setActionMsg(`تم تسجيل مسار توريد التحصيل للطلب ${remitTargetRow.orderNumber}`);
      setRemitTargetRow(null);
      setRemInstapayRef('');
      setRemNote('');
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تسجيل التوريد');
    }
  };

  const handleConfirmFailure = async (orderNumber: string) => {
    setError(null);
    try {
      await volunteerApi.updateStatus(volunteerId, orderNumber, {
        nextDeliveryStatus: 'delivery_failed',
        failureReason,
      });
      setActionMsg(`تم تسجيل فشل توصيل الطلب ${orderNumber} وإرجاع البضاعة للمحل`);
      setFailingOrderNumber(null);
      setFailureReason('');
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تسجيل فشل التسليم');
    }
  };

  if (loading && !data) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
        جاري تحميل بيانات المتطوع...
      </div>
    );
  }

  const activeAssigned = (data?.assignedOrders ?? []).filter(
    (o) => o.deliveryStatus !== 'delivered' && o.deliveryStatus !== 'delivery_failed',
  );
  const pastAssigned = (data?.assignedOrders ?? []).filter(
    (o) => o.deliveryStatus === 'delivered' || o.deliveryStatus === 'delivery_failed',
  );

  return (
    <div className="space-y-6">
      {/* Volunteer Header */}
      <div className="flex flex-col justify-between gap-4 rounded-xl border border-slate-200 bg-white p-5 sm:flex-row sm:items-center">
        <div>
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span>لوحة متطوع التوصيل</span>
            <span aria-hidden="true">·</span>
            <span>{data?.volunteer.vehicleType}</span>
            <span aria-hidden="true">·</span>
            <span>نطاق {data?.volunteer.area}</span>
          </div>
          <h1 className="font-display mt-1 text-xl font-bold text-slate-900">
            {data?.volunteer.name}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <div>
            <p className="text-xs text-slate-500">عهدة مطلوبة للتوريد</p>
            <p className="font-mono text-base font-bold text-rose-700 tabular-nums">
              {formatEGP(data?.statement.cashToRemitEGP ?? 0)}
            </p>
          </div>
          <div className="h-8 w-px bg-slate-200" />
          <div>
            <p className="text-xs text-slate-500">مورّد للمحلات</p>
            <p className="font-mono text-base font-bold text-emerald-700 tabular-nums">
              {formatEGP(data?.statement.remittedToShopTotalEGP ?? 0)}
            </p>
          </div>
          <div className="h-8 w-px bg-slate-200" />
          <div>
            <p className="text-xs text-slate-500">مستحق المتطوع</p>
            <p className="font-mono text-base font-bold text-teal-800 tabular-nums">
              {formatEGP(data?.statement.totalVolunteerEarningsEGP ?? 0)}
            </p>
          </div>
          <div className="h-8 w-px bg-slate-200" />
          <div>
            <p className="text-xs text-slate-500">مستحق غير مسوى</p>
            <p className="font-mono text-base font-bold text-amber-700 tabular-nums">
              {formatEGP(data?.statement.pendingEarningsEGP ?? 0)}
            </p>
          </div>
          {data &&
            data.statement.ratingsCount > 0 &&
            data.statement.averageDeliveryRating !== null && (
              <>
                <div className="h-8 w-px bg-slate-200" />
                <div>
                  <p className="text-xs text-slate-500">
                    تقييم العملاء ({data.statement.ratingsCount})
                  </p>
                  <p className="flex items-center gap-1 font-mono text-base font-bold text-amber-700 tabular-nums">
                    <Star className="h-4 w-4 fill-amber-400 text-amber-500" />
                    <span>{data.statement.averageDeliveryRating}/5</span>
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

      {/* Rules note */}
      {data && (
        <div className="rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-xs text-slate-600">
          قاعدة التوزيع الحالية:{' '}
          <span className="font-semibold text-slate-900">
            {data.rules.volunteerShareMode === 'percentage'
              ? `${data.rules.volunteerShareValue}% من رسوم التوصيل`
              : `${formatEGP(data.rules.volunteerShareValue)} ثابتة لكل طلب`}
          </span>{' '}
          (تكلفة التشغيل الإدارية {formatEGP(data.rules.operatingCostPerOrderEGP)} لكل طلب)
        </div>
      )}

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

      {/* Active Assigned Orders */}
      <section className="space-y-3">
        <h2 className="font-display text-base font-bold text-slate-900">
          الطلبات المسندة إليّ حاليًا ({activeAssigned.length})
        </h2>
        {activeAssigned.length === 0 ? (
          <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
            لا توجد رحلات توصيل نشطة مسندة إليك حاليًا.
          </div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {activeAssigned.map((order) => (
              <div
                key={order.id}
                className="flex flex-col justify-between space-y-4 rounded-xl border border-slate-200 bg-white p-5"
              >
                <div className="space-y-3">
                  <div className="flex items-start justify-between gap-3 border-b border-slate-100 pb-3">
                    <div>
                      <span className="font-mono text-base font-bold text-slate-900">
                        {order.orderNumber}
                      </span>
                      <p
                        className={`mt-0.5 text-xs font-semibold ${
                          DELIVERY_STATUS_META[order.deliveryStatus].textClass
                        }`}
                      >
                        حالة الرحلة: {DELIVERY_STATUS_META[order.deliveryStatus].label}
                      </p>
                    </div>
                    <div className="text-left text-xs">
                      <p className="font-mono font-bold text-slate-900 tabular-nums">
                        المطلوب تحصيله: {formatEGP(order.financials.customerExpectedTotalEGP)}
                      </p>
                      <p className="text-slate-500 tabular-nums">
                        قيمة الطلب {formatEGP(order.financials.itemsTotalEGP)} · التوصيل{' '}
                        {formatEGP(order.financials.deliveryFeeEGP)}
                      </p>
                      <p className="font-semibold text-teal-800 tabular-nums">
                        حصة المتطوع: {formatEGP(order.financials.volunteerShareEGP)}
                      </p>
                    </div>
                  </div>

                  <div className="grid gap-3 text-xs sm:grid-cols-2">
                    <div className="rounded-lg bg-slate-50 p-3 space-y-1">
                      <p className="flex items-center gap-1 font-semibold text-slate-900">
                        <Store className="h-3.5 w-3.5 text-teal-700" />
                        <span>الاستلام من: {order.shopName}</span>
                      </p>
                      <p className="text-slate-600">{order.shopAddress}</p>
                      <p className="font-mono text-slate-500">{order.shopPhone}</p>
                    </div>
                    <div className="rounded-lg bg-slate-50 p-3 space-y-1">
                      <p className="flex items-center gap-1 font-semibold text-slate-900">
                        <MapPin className="h-3.5 w-3.5 text-teal-700" />
                        <span>التسليم إلى: {order.customerName}</span>
                      </p>
                      <p className="text-slate-600">{order.deliveryAddress}</p>
                      <p className="flex items-center gap-1 font-mono text-slate-500">
                        <Phone className="h-3 w-3" />
                        {order.customerPhone}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Trip Step Buttons */}
                <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
                  {order.deliveryStatus === 'assigned' && (
                    <button
                      type="button"
                      onClick={() => handleUpdateTrip(order.orderNumber, 'heading_to_shop')}
                      className="min-h-[38px] rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50"
                    >
                      في الطريق إلى المحل
                    </button>
                  )}
                  {(order.deliveryStatus === 'assigned' ||
                    order.deliveryStatus === 'heading_to_shop') && (
                    <button
                      type="button"
                      onClick={() => handleUpdateTrip(order.orderNumber, 'picked_up')}
                      className="min-h-[38px] rounded-lg bg-indigo-700 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-indigo-800"
                    >
                      تم استلام الطلب من المحل
                    </button>
                  )}
                  {order.deliveryStatus === 'picked_up' && (
                    <button
                      type="button"
                      onClick={() => handleUpdateTrip(order.orderNumber, 'heading_to_customer')}
                      className="min-h-[38px] rounded-lg bg-sky-700 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-sky-800"
                    >
                      خروج للتوصيل (في الطريق للعميل)
                    </button>
                  )}
                  {(order.deliveryStatus === 'picked_up' ||
                    order.deliveryStatus === 'heading_to_customer') && (
                    <button
                      type="button"
                      onClick={() => {
                        setDeliveringOrder(order);
                        setCollectedCash(String(order.financials.customerExpectedTotalEGP));
                        setDiscrepancyNote('');
                        setRemMode('full_to_shop');
                        setRemShopChannel('cash');
                        setRemInstapayRef('');
                        setRemNote('');
                      }}
                      className="flex min-h-[38px] items-center gap-1.5 rounded-lg bg-emerald-700 px-4 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800"
                    >
                      <CheckCircle2 className="h-4 w-4" />
                      <span>إتمام التسليم والتحصيل النقدي</span>
                    </button>
                  )}

                  {failingOrderNumber === order.orderNumber ? (
                    <div className="flex w-full flex-wrap items-center gap-2 pt-2">
                      <input
                        type="text"
                        value={failureReason}
                        onChange={(e) => setFailureReason(e.target.value)}
                        placeholder="سبب فشل التسليم (إلزامي)"
                        className="min-h-[38px] flex-1 rounded-lg border border-rose-300 px-3 text-xs"
                      />
                      <button
                        type="button"
                        onClick={() => handleConfirmFailure(order.orderNumber)}
                        className="min-h-[38px] rounded-lg bg-rose-700 px-3 text-xs font-semibold text-white"
                      >
                        تأكيد فشل التسليم
                      </button>
                      <button
                        type="button"
                        onClick={() => setFailingOrderNumber(null)}
                        className="min-h-[38px] rounded-lg border border-slate-200 px-3 text-xs text-slate-600"
                      >
                        إلغاء
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setFailingOrderNumber(order.orderNumber)}
                      className="flex min-h-[38px] items-center gap-1 rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-50"
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      <span>فشل التسليم</span>
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Available Unassigned Orders */}
      <section className="space-y-3">
        <h2 className="font-display text-base font-bold text-slate-900">
          الطلبات الجاهزة المتاحة للاستلام ({data?.availableOrders.length ?? 0})
        </h2>
        {(data?.availableOrders.length ?? 0) === 0 ? (
          <div className="rounded-xl border border-slate-200 bg-white p-6 text-center text-xs text-slate-500">
            لا توجد طلبات جاهزة بانتظار الإسناد حاليًا.
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {data?.availableOrders.map((order) => (
              <div
                key={order.id}
                className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-4"
              >
                <div className="space-y-1 text-xs">
                  <p className="font-mono text-sm font-bold text-slate-900">
                    {order.orderNumber} — {order.shopName}
                  </p>
                  <p className="text-slate-600">الاستلام: {order.shopAddress}</p>
                  <p className="text-slate-600">التوصيل: {order.deliveryAddress}</p>
                  <p className="font-semibold text-teal-800 tabular-nums">
                    رسوم التوصيل: {formatEGP(order.financials.deliveryFeeEGP)} (مستحقك:{' '}
                    {formatEGP(order.financials.volunteerShareEGP)})
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleClaim(order.orderNumber)}
                  className="flex min-h-[40px] shrink-0 items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-teal-700"
                >
                  <Truck className="h-4 w-4" />
                  <span>استلام المهمة</span>
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Volunteer Independent Settlement Statement & Past Orders */}
      <section className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <Wallet className="h-4 w-4 text-teal-700" />
            <h2 className="font-display text-sm font-bold text-slate-900">
              سجل الطلبات السابقة وكشف حساب المتطوع المستقل
            </h2>
          </div>
          <span className="font-mono text-xs text-slate-600 tabular-nums">
            إجمالي التحصيل النقدي: {formatEGP(data?.statement.totalCashCollectedEGP ?? 0)}
          </span>
        </div>
        {pastAssigned.length === 0 ? (
          <p className="p-6 text-center text-xs text-slate-500">
            لم تكتمل أي رحلات توصيل لهذا المتطوع بعد.
          </p>
        ) : (
          <table className="w-full text-right text-xs">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
              <tr>
                <th className="px-4 py-3 font-semibold">الطلب</th>
                <th className="px-4 py-3 font-semibold">المحل / العميل</th>
                <th className="px-4 py-3 font-semibold">حالة التوصيل</th>
                <th className="px-4 py-3 font-semibold">المطلوب</th>
                <th className="px-4 py-3 font-semibold">المحصل فعليًا</th>
                <th className="px-4 py-3 font-semibold">الفرق</th>
                <th className="px-4 py-3 font-semibold">مستحق المتطوع</th>
                <th className="px-4 py-3 font-semibold">مسار التوريد (المحل / إنستاباي)</th>
                <th className="px-4 py-3 font-semibold">تقييم العميل</th>
                <th className="px-4 py-3 font-semibold">التسوية</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(data?.statement.orderRows ?? []).map((row) => {
                const rem = row.remittance;
                const canSubmitOrEditRemit =
                  row.deliveryStatus === 'delivered' &&
                  !rem?.shopConfirmedAt &&
                  !rem?.platformConfirmedAt;
                return (
                  <tr key={row.orderNumber}>
                    <td className="px-4 py-2.5">
                      <p className="font-mono font-bold text-slate-900">{row.orderNumber}</p>
                      <p className="text-[11px] text-slate-400">{formatDateTimeAr(row.deliveredAt)}</p>
                    </td>
                    <td className="px-4 py-2.5 text-slate-700">
                      {row.shopName} ← {row.customerName}
                    </td>
                    <td
                      className={`px-4 py-2.5 font-semibold ${
                        DELIVERY_STATUS_META[row.deliveryStatus].textClass
                      }`}
                    >
                      {DELIVERY_STATUS_META[row.deliveryStatus].label}
                    </td>
                    <td className="px-4 py-2.5 font-mono tabular-nums">
                      {formatEGP(row.customerExpectedTotalEGP)}
                    </td>
                    <td className="px-4 py-2.5 font-mono font-semibold tabular-nums">
                      {formatEGP(row.collectedAmountEGP)}
                    </td>
                    <td
                      className={`px-4 py-2.5 font-mono tabular-nums ${
                        Math.abs(row.collectionDiscrepancyEGP) > 0.01
                          ? 'font-bold text-rose-700'
                          : 'text-slate-500'
                      }`}
                    >
                      {formatEGP(row.collectionDiscrepancyEGP)}
                    </td>
                    <td className="px-4 py-2.5 font-mono font-bold text-teal-800 tabular-nums">
                      {formatEGP(row.volunteerShareEGP)}
                    </td>
                    <td className="px-4 py-2.5">
                      {rem ? (
                        <div className="space-y-0.5 text-[11px]">
                          <p className={`font-semibold ${REMITTANCE_STATUS_META[rem.status].textClass}`}>
                            {REMITTANCE_MODE_LABELS[rem.mode]}
                          </p>
                          <p className="text-slate-600 tabular-nums">
                            {rem.mode === 'full_to_shop'
                              ? `للمحل: ${formatEGP(rem.amountToShopEGP)} (${REMITTANCE_CHANNEL_LABELS[rem.shopTransferChannel ?? 'cash']}) · عند المحل للمنصة: ${formatEGP(rem.amountPlatformAtShopEGP)}`
                              : rem.mode === 'split_shop_and_courier'
                                ? `للمحل: ${formatEGP(rem.amountToShopEGP)} (${REMITTANCE_CHANNEL_LABELS[rem.shopTransferChannel ?? 'cash']}) · جزء المنصة معي: ${formatEGP(rem.amountWithCourierForPlatformEGP)}`
                                : `إنستاباي مباشر للإدارة: ${formatEGP(rem.amountDirectToPlatformEGP)}`}
                          </p>
                          <p className="text-[10px] text-slate-500">
                            {REMITTANCE_STATUS_META[rem.status].label}
                          </p>
                        </div>
                      ) : row.deliveryStatus === 'delivered' ? (
                        <span className="text-[11px] font-medium text-amber-700">
                          لم يتم تسجيل مسار التوريد بعد
                        </span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                      {canSubmitOrEditRemit && (
                        <button
                          type="button"
                          onClick={() => {
                            setRemitTargetRow({
                              orderNumber: row.orderNumber,
                              shopName: row.shopName,
                              collectedAmountEGP: row.collectedAmountEGP,
                              shopDueEGP: row.shopDueEGP,
                            });
                            setRemMode(rem?.mode ?? 'full_to_shop');
                            setRemShopChannel(rem?.shopTransferChannel ?? 'cash');
                            setRemInstapayRef(rem?.instapayReference ?? '');
                            setRemNote(rem?.note ?? '');
                          }}
                          className="mt-1 inline-block text-[11px] font-semibold text-teal-800 hover:underline"
                        >
                          {rem ? 'تعديل طريقة التوريد' : 'تسجيل توريد الفلوس للمحل / إنستاباي'}
                        </button>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {row.ratingScore ? (
                        <div>
                          <span className="inline-flex items-center gap-1 font-mono font-bold text-amber-700 tabular-nums">
                            <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-500" />
                            <span>{row.ratingScore}/5</span>
                          </span>
                          {row.ratingComment && (
                            <p className="mt-0.5 max-w-[180px] truncate text-[11px] text-slate-600">
                              "{row.ratingComment}"
                            </p>
                          )}
                        </div>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td
                      className={`px-4 py-2.5 font-medium ${
                        SETTLEMENT_STATUS_META[row.settlementStatus].textClass
                      }`}
                    >
                      {SETTLEMENT_STATUS_META[row.settlementStatus].label}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* Cash Collection & Remittance Modal */}
      {deliveringOrder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-900/40 p-4">
          <form
            onSubmit={handleConfirmDelivery}
            className="w-full max-w-lg space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-xl"
          >
            <div>
              <h3 className="font-display text-base font-bold text-slate-900">
                تأكيد التسليم والتحصيل ومسار التوريد ({deliveringOrder.orderNumber})
              </h3>
              <p className="mt-1 text-xs text-slate-600">
                الإجمالي المطلوب من العميل:{' '}
                <span className="font-mono font-bold text-slate-900">
                  {formatEGP(deliveringOrder.financials.customerExpectedTotalEGP)}
                </span>{' '}
                · مستحق المحل:{' '}
                <span className="font-mono font-semibold text-slate-900">
                  {formatEGP(deliveringOrder.financials.shopDueEGP)}
                </span>
              </p>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-700">
                1. المبلغ المحصل فعليًا من العميل (ج.م)
              </label>
              <input
                type="number"
                step="0.5"
                min="0"
                required
                value={collectedCash}
                onChange={(e) => setCollectedCash(e.target.value)}
                className="min-h-[42px] w-full rounded-lg border border-slate-200 px-3 font-mono text-sm focus:border-teal-700 focus:outline-none"
              />
            </div>

            {Math.abs(
              Number(collectedCash) - deliveringOrder.financials.customerExpectedTotalEGP,
            ) > 0.01 && (
              <div>
                <label className="mb-1 block text-xs font-semibold text-rose-800">
                  سبب اختلاف مبلغ التحصيل (إلزامي عند وجود فرق)
                </label>
                <input
                  type="text"
                  required
                  value={discrepancyNote}
                  onChange={(e) => setDiscrepancyNote(e.target.value)}
                  placeholder="مثال: العميل دفع نقدًا مع عجز فكة 5 جنيه"
                  className="min-h-[42px] w-full rounded-lg border border-rose-300 bg-rose-50/40 px-3 text-xs focus:outline-none"
                />
              </div>
            )}

            {/* Remittance Mode Selector */}
            <div className="space-y-2.5 rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 text-xs">
              <p className="font-bold text-slate-900">2. كيف ستورّد المبلغ المحصل؟</p>
              {(() => {
                const collectedNum = Math.max(0, Number(collectedCash) || 0);
                const shopDueNum = deliveringOrder.financials.shopDueEGP;
                const shopPortion = Math.min(collectedNum, shopDueNum);
                const ourPortion = Math.max(0, Math.round((collectedNum - shopDueNum) * 100) / 100);
                return (
                  <div className="space-y-2">
                    <label
                      className={`flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 ${
                        remMode === 'full_to_shop'
                          ? 'border-teal-700 bg-white'
                          : 'border-slate-200 bg-white/70'
                      }`}
                    >
                      <input
                        type="radio"
                        name="remMode"
                        checked={remMode === 'full_to_shop'}
                        onChange={() => setRemMode('full_to_shop')}
                        className="mt-0.5"
                      />
                      <div>
                        <p className="font-bold text-slate-900">
                          تسليم المبلغ كاملًا للسوبر ماركت ({formatEGP(collectedNum)})
                        </p>
                        <p className="text-[11px] text-slate-600 tabular-nums">
                          عند تأكيد المحل للاستلام تتقفل عهدتك النقدية (0 ج.م) وتتقفل تسوية المحل،
                          ويبقى نصيبنا ({formatEGP(ourPortion)}) عند السوبر ماركت.
                        </p>
                      </div>
                    </label>

                    <label
                      className={`flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 ${
                        remMode === 'split_shop_and_courier'
                          ? 'border-teal-700 bg-white'
                          : 'border-slate-200 bg-white/70'
                      }`}
                    >
                      <input
                        type="radio"
                        name="remMode"
                        checked={remMode === 'split_shop_and_courier'}
                        onChange={() => setRemMode('split_shop_and_courier')}
                        className="mt-0.5"
                      />
                      <div>
                        <p className="font-bold text-slate-900">
                          توريد حصة المحل فقط ({formatEGP(shopPortion)}) والباقي معي ({formatEGP(ourPortion)})
                        </p>
                        <p className="text-[11px] text-slate-600 tabular-nums">
                          المحل يؤكد استلام حصته وتتقفل تسويته، ويبقى جزء المنصة ({formatEGP(ourPortion)}) معك لتوريده لاحقًا.
                        </p>
                      </div>
                    </label>

                    <label
                      className={`flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 ${
                        remMode === 'full_to_platform_instapay'
                          ? 'border-teal-700 bg-white'
                          : 'border-slate-200 bg-white/70'
                      }`}
                    >
                      <input
                        type="radio"
                        name="remMode"
                        checked={remMode === 'full_to_platform_instapay'}
                        onChange={() => setRemMode('full_to_platform_instapay')}
                        className="mt-0.5"
                      />
                      <div>
                        <p className="font-bold text-slate-900">
                          تحويل المبلغ كاملًا إنستاباي للإدارة ({formatEGP(collectedNum)})
                        </p>
                        <p className="text-[11px] text-slate-600">
                          الإدارة تؤكد التحويل وتقوم بتسوية السوبر ماركت ({formatEGP(shopDueNum)}) وحصتك.
                        </p>
                      </div>
                    </label>
                  </div>
                );
              })()}

              {remMode !== 'full_to_platform_instapay' && (
                <div className="pt-1">
                  <p className="mb-1 text-[11px] font-semibold text-slate-700">
                    طريقة السداد للمحل:
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setRemShopChannel('cash')}
                      className={`min-h-[36px] rounded-lg border text-xs font-semibold ${
                        remShopChannel === 'cash'
                          ? 'border-teal-700 bg-teal-700 text-white'
                          : 'border-slate-200 bg-white text-slate-700'
                      }`}
                    >
                      نقدي في إيد المحل
                    </button>
                    <button
                      type="button"
                      onClick={() => setRemShopChannel('instapay')}
                      className={`min-h-[36px] rounded-lg border text-xs font-semibold ${
                        remShopChannel === 'instapay'
                          ? 'border-indigo-700 bg-indigo-700 text-white'
                          : 'border-slate-200 bg-white text-slate-700'
                      }`}
                    >
                      تحويل إنستاباي للمحل
                    </button>
                  </div>
                </div>
              )}

              {(remShopChannel === 'instapay' || remMode === 'full_to_platform_instapay') && (
                <div>
                  <label className="mb-1 block text-[11px] text-slate-700">
                    مرجع تحويل إنستاباي / رقم الحساب (اختياري)
                  </label>
                  <input
                    type="text"
                    value={remInstapayRef}
                    onChange={(e) => setRemInstapayRef(e.target.value)}
                    placeholder="مثال: InstaPay #4821 أو رقم المحفظة"
                    className="min-h-[36px] w-full rounded-lg border border-slate-200 bg-white px-3 text-xs"
                  />
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setDeliveringOrder(null)}
                className="min-h-[40px] rounded-lg border border-slate-200 px-4 text-xs text-slate-700"
              >
                إلغاء
              </button>
              <button
                type="submit"
                className="min-h-[40px] rounded-lg bg-emerald-700 px-4 text-xs font-semibold text-white hover:bg-emerald-800"
              >
                تأكيد التسليم وتسجيل التوريد
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Post-delivery Remittance Modal */}
      {remitTargetRow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-900/40 p-4">
          <form
            onSubmit={handleSubmitStandaloneRemittance}
            className="w-full max-w-md space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-xl"
          >
            <div>
              <h3 className="font-display text-base font-bold text-slate-900">
                توريد تحصيل الطلب {remitTargetRow.orderNumber}
              </h3>
              <p className="mt-1 text-xs text-slate-600 tabular-nums">
                {remitTargetRow.shopName} · المحصل: {formatEGP(remitTargetRow.collectedAmountEGP)} ·
                حصة المحل: {formatEGP(remitTargetRow.shopDueEGP)}
              </p>
            </div>

            <div className="space-y-2 text-xs">
              {(
                [
                  {
                    value: 'full_to_shop',
                    title: `توريد المبلغ كاملًا للمحل (${formatEGP(remitTargetRow.collectedAmountEGP)})`,
                    desc: `تتقفل عهدتك فور تأكيد المحل، ويبقى نصيبنا (${formatEGP(
                      Math.max(0, remitTargetRow.collectedAmountEGP - remitTargetRow.shopDueEGP),
                    )}) عند السوبر ماركت.`,
                  },
                  {
                    value: 'split_shop_and_courier',
                    title: `توريد حصة المحل فقط (${formatEGP(
                      Math.min(remitTargetRow.collectedAmountEGP, remitTargetRow.shopDueEGP),
                    )}) والباقي معي`,
                    desc: `المحل يتقفّل حسابه، ويبقى الجزء بتاعنا (${formatEGP(
                      Math.max(0, remitTargetRow.collectedAmountEGP - remitTargetRow.shopDueEGP),
                    )}) معك.`,
                  },
                  {
                    value: 'full_to_platform_instapay',
                    title: 'تحويل كامل المبلغ إنستاباي للإدارة مباشرة',
                    desc: 'يتطلب تأكيد الإدارة لاستلام التحويل على حساب المنصة.',
                  },
                ] as const
              ).map((opt) => (
                <label
                  key={opt.value}
                  className={`flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 ${
                    remMode === opt.value
                      ? 'border-teal-700 bg-teal-50/40'
                      : 'border-slate-200 bg-white'
                  }`}
                >
                  <input
                    type="radio"
                    name="standaloneRemMode"
                    checked={remMode === opt.value}
                    onChange={() => setRemMode(opt.value)}
                    className="mt-0.5"
                  />
                  <div>
                    <p className="font-bold text-slate-900">{opt.title}</p>
                    <p className="text-[11px] text-slate-600">{opt.desc}</p>
                  </div>
                </label>
              ))}
            </div>

            {remMode !== 'full_to_platform_instapay' && (
              <div className="grid grid-cols-2 gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => setRemShopChannel('cash')}
                  className={`min-h-[36px] rounded-lg border font-semibold ${
                    remShopChannel === 'cash'
                      ? 'border-teal-700 bg-teal-700 text-white'
                      : 'border-slate-200 text-slate-700'
                  }`}
                >
                  نقدي للمحل
                </button>
                <button
                  type="button"
                  onClick={() => setRemShopChannel('instapay')}
                  className={`min-h-[36px] rounded-lg border font-semibold ${
                    remShopChannel === 'instapay'
                      ? 'border-indigo-700 bg-indigo-700 text-white'
                      : 'border-slate-200 text-slate-700'
                  }`}
                >
                  إنستاباي للمحل
                </button>
              </div>
            )}

            {(remShopChannel === 'instapay' || remMode === 'full_to_platform_instapay') && (
              <input
                type="text"
                value={remInstapayRef}
                onChange={(e) => setRemInstapayRef(e.target.value)}
                placeholder="مرجع إنستاباي (اختياري)"
                className="min-h-[38px] w-full rounded-lg border border-slate-200 px-3 text-xs"
              />
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRemitTargetRow(null)}
                className="min-h-[38px] rounded-lg border border-slate-200 px-4 text-xs text-slate-700"
              >
                إلغاء
              </button>
              <button
                type="submit"
                className="min-h-[38px] rounded-lg bg-teal-700 px-4 text-xs font-semibold text-white hover:bg-teal-800"
              >
                حفظ وإرسال للمحل
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
