import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  KeyRound,
  Printer,
  QrCode,
  RefreshCw,
  ShieldCheck,
  UserPlus,
  XCircle,
} from 'lucide-react';
import { shopApi, type ShopDashboardData } from '../api/client';
import type { PublicShopStaffView, ShopStaffPermissions, ShopStaffRole } from '../types/commerce';
import { formatDateTimeAr, formatEGP } from '../utils/arabicLabels';

interface ShopShiftsAndQrManagerProps {
  shopId: string;
  shopName: string;
  posManagement: NonNullable<ShopDashboardData['posManagement']>;
  onRefresh: () => Promise<void>;
  onOpenPosPreview: (posPath: string) => void;
}

const DEFAULT_STAFF_PERMS: Record<ShopStaffRole, ShopStaffPermissions> = {
  cashier_staff: {
    canPosSell: true,
    canManageOnlineOrders: true,
    canModifyOrCancelOrders: false,
    canAddProducts: true,
    canAdjustPricesOrStock: false,
    canForceCloseShifts: false,
  },
  shift_supervisor: {
    canPosSell: true,
    canManageOnlineOrders: true,
    canModifyOrCancelOrders: true,
    canAddProducts: true,
    canAdjustPricesOrStock: true,
    canForceCloseShifts: true,
  },
};

const PERMISSION_LABELS: Array<{ key: keyof ShopStaffPermissions; label: string }> = [
  { key: 'canPosSell', label: 'البيع السريع بالكاشير والباركود' },
  { key: 'canManageOnlineOrders', label: 'موافقة وتحضير الطلبات وتسليم المتطوع' },
  { key: 'canModifyOrCancelOrders', label: 'تعديل الأصناف/البدائل أو رفض الطلبات' },
  { key: 'canAddProducts', label: 'إضافة منتجات جديدة للكتالوج' },
  { key: 'canAdjustPricesOrStock', label: 'تعديل الأسعار والمخزون' },
  { key: 'canForceCloseShifts', label: 'إغلاق/إدارة ورديات الزملاء (مسؤول أعلى)' },
];

export const ShopShiftsAndQrManager: React.FC<ShopShiftsAndQrManagerProps> = ({
  shopId,
  shopName,
  posManagement,
  onRefresh,
  onOpenPosPreview,
}) => {
  const { posConfig, staffAccounts, shifts } = posManagement;
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const [busyMsg, setBusyMsg] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  // PIN change inline state per staff
  const [pinTargetId, setPinTargetId] = useState<string | null>(null);
  const [newPinValue, setNewPinValue] = useState('');

  // Create / Edit staff modal state
  const [editingStaff, setEditingStaff] = useState<Partial<PublicShopStaffView> | null>(null);
  const [formName, setFormName] = useState('');
  const [formShiftLabel, setFormShiftLabel] = useState('');
  const [formDeviceLabel, setFormDeviceLabel] = useState('');
  const [formRoleTier, setFormRoleTier] = useState<ShopStaffRole>('cashier_staff');
  const [formPerms, setFormPerms] = useState<ShopStaffPermissions>(DEFAULT_STAFF_PERMS.cashier_staff);
  const [formActive, setFormActive] = useState(true);

  const posRelativePath = `/pos/${shopId}?k=${posConfig.qrAccessKey}`;
  const fullPosUrl =
    typeof window !== 'undefined' ? `${window.location.origin}${posRelativePath}` : posRelativePath;

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(fullPosUrl, {
      width: 320,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#0f172a', light: '#ffffff' },
    })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl('');
      });
    return () => {
      cancelled = true;
    };
  }, [fullPosUrl]);

  const openStaff = shifts.filter((sh) => sh.status === 'open');
  const closedShifts = shifts.filter((sh) => sh.status !== 'open');

  const handleCopyUrl = async () => {
    try {
      await navigator.clipboard.writeText(fullPosUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setErrMsg('تعذر نسخ الرابط تلقائيًا');
    }
  };

  const handleRegenerateQr = async () => {
    setErrMsg(null);
    setBusyMsg(null);
    try {
      await shopApi.regenerateQr(shopId);
      setBusyMsg('تم إصدار كود QR جديد وإبطال الكود المطبوع القديم فورًا');
      await onRefresh();
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : 'تعذر تجديد الكود');
    }
  };

  const handleConcurrencyChange = async (nextCap: number) => {
    setErrMsg(null);
    setBusyMsg(null);
    try {
      await shopApi.updateQrConcurrency(shopId, nextCap);
      setBusyMsg(`تم ضبط الحد الأقصى للجلسات المتزامنة على ${nextCap} جلسة في نفس الوقت`);
      await onRefresh();
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : 'تعذر تعديل عدد الجلسات');
    }
  };

  const handleSavePin = async (staffId: string) => {
    setErrMsg(null);
    setBusyMsg(null);
    try {
      await shopApi.setStaffPasscode(shopId, staffId, newPinValue);
      setPinTargetId(null);
      setNewPinValue('');
      setBusyMsg('تم تحديث الباسوورد وإغلاق أي جلسة قديمة لهذا الموظف تلقائيًا');
      await onRefresh();
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : 'تعذر حفظ الباسوورد');
    }
  };

  const handleForceCloseShift = async (shiftId: string, staffName: string) => {
    setErrMsg(null);
    setBusyMsg(null);
    try {
      await shopApi.forceCloseShift(shopId, shiftId, {
        closingNote: `إغلاق إجباري من صاحب المحل (${shopName})`,
      });
      setBusyMsg(`تم إغلاق وردية "${staffName}" إجباريًا وطرد الجلسة من الموبايل فورًا`);
      await onRefresh();
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : 'تعذر الإغلاق الإجباري');
    }
  };

  const openEditStaffModal = (staff?: PublicShopStaffView) => {
    if (staff) {
      setEditingStaff(staff);
      setFormName(staff.name);
      setFormShiftLabel(staff.shiftLabel);
      setFormDeviceLabel(staff.deviceLabel);
      setFormRoleTier(staff.roleTier);
      setFormPerms(staff.permissions);
      setFormActive(staff.isActive);
    } else {
      setEditingStaff({});
      setFormName('');
      setFormShiftLabel('وردية إضافية');
      setFormDeviceLabel('موبايل كاشير إضافي');
      setFormRoleTier('cashier_staff');
      setFormPerms(DEFAULT_STAFF_PERMS.cashier_staff);
      setFormActive(true);
    }
  };

  const handleSaveStaffModal = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrMsg(null);
    setBusyMsg(null);
    try {
      await shopApi.upsertStaff(shopId, {
        staffId: editingStaff?.id,
        name: formName,
        shiftLabel: formShiftLabel,
        deviceLabel: formDeviceLabel,
        roleTier: formRoleTier,
        permissions: formPerms,
        isActive: formActive,
      });
      setEditingStaff(null);
      setBusyMsg('تم حفظ بيانات وصلاحيات الموظف بنجاح');
      await onRefresh();
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : 'تعذر حفظ بيانات الموظف');
    }
  };

  return (
    <div className="space-y-6">
      {errMsg && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-3.5 text-xs font-medium text-rose-800">
          {errMsg}
        </div>
      )}
      {busyMsg && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3.5 text-xs font-medium text-emerald-800">
          {busyMsg}
        </div>
      )}

      {/* 1. Printable Shop QR Card + Concurrency Settings */}
      <div className="grid gap-6 lg:grid-cols-12">
        <div className="rounded-xl border border-slate-200 bg-white p-5 lg:col-span-5">
          <div className="flex items-center gap-2 border-b border-slate-100 pb-3">
            <QrCode className="h-4 w-4 text-teal-700" />
            <h2 className="font-display text-sm font-bold text-slate-900">
              كود الـ QR المطبوع للكاشير (ملصق المحل الموحد)
            </h2>
          </div>

          <div className="mt-4 flex flex-col items-center rounded-xl border border-dashed border-slate-300 bg-slate-50 p-5 text-center">
            <p className="font-display text-base font-bold text-slate-900">{shopName}</p>
            <p className="mt-0.5 text-xs text-slate-600">
              امسح الكود بكاميرا الموبايل لفتح شاشة البيع والطلبات — الدخول برقم الوردية والباسوورد
            </p>
            {qrDataUrl ? (
              <img
                src={qrDataUrl}
                alt={`كود QR دخول كاشير ${shopName}`}
                className="my-4 h-48 w-48 rounded-lg border border-slate-200 bg-white p-2"
              />
            ) : (
              <div className="my-4 flex h-48 w-48 items-center justify-center rounded-lg border border-slate-200 bg-white text-xs text-slate-400">
                جاري توليد QR...
              </div>
            )}
            <p className="max-w-full break-all font-mono text-[10px] text-slate-400" dir="ltr">
              {fullPosUrl}
            </p>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onOpenPosPreview(posRelativePath)}
              className="flex min-h-[38px] flex-1 items-center justify-center gap-1.5 rounded-lg bg-teal-700 px-3 py-2 text-xs font-semibold text-white hover:bg-teal-800"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              <span>فتح شاشة الكاشير الآن (تجربة)</span>
            </button>
            {qrDataUrl && (
              <a
                href={qrDataUrl}
                download={`qr-${shopId}.png`}
                className="flex min-h-[38px] items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                <Download className="h-3.5 w-3.5" />
                <span>تنزيل للطباعة</span>
              </a>
            )}
            <button
              type="button"
              onClick={() => window.print()}
              className="flex min-h-[38px] items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              <Printer className="h-3.5 w-3.5" />
              <span>طباعة</span>
            </button>
            <button
              type="button"
              onClick={handleCopyUrl}
              className="flex min-h-[38px] items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
              <span>{copied ? 'تم النسخ' : 'نسخ الرابط'}</span>
            </button>
            <button
              type="button"
              onClick={handleRegenerateQr}
              className="flex min-h-[38px] items-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-800 hover:bg-rose-100"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span>إلغاء الكود القديم وتوليد جديد</span>
            </button>
          </div>
        </div>

        {/* 2. Live Open Concurrent Shifts + Concurrency Limit */}
        <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 lg:col-span-7">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
            <div>
              <h2 className="font-display text-sm font-bold text-slate-900">
                الورديات والجلسات المفتوحة الآن ({openStaff.length} / {posConfig.maxConcurrentSessions})
              </h2>
              <p className="text-xs text-slate-500">
                يمكن فتح حتى {posConfig.maxConcurrentSessions} جهاز في نفس الوقت إذا كان يعمل بالمحل
                أكثر من موظف.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-slate-600">الحد الأقصى المتزامن:</label>
              <select
                value={posConfig.maxConcurrentSessions}
                onChange={(e) => handleConcurrencyChange(Number(e.target.value))}
                className="min-h-[36px] rounded-lg border border-slate-200 bg-slate-50 px-2.5 font-mono text-xs"
              >
                <option value={1}>1 جلسة فقط</option>
                <option value={2}>2 جلسة في نفس الوقت (افتراضي)</option>
                <option value={3}>3 جلسات في نفس الوقت</option>
              </select>
            </div>
          </div>

          {openStaff.length === 0 ? (
            <div className="rounded-lg border border-slate-100 bg-slate-50 p-6 text-center text-xs text-slate-500">
              لا توجد ورديات مفتوحة حاليًا عبر بوابة الـ QR. عند دخول موظف بالباسوورد ستظهر جلسته
              هنا لحظيًا.
            </div>
          ) : (
            <div className="space-y-3">
              {openStaff.map((sh) => (
                <div
                  key={sh.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50/40 p-4"
                >
                  <div>
                    <div className="flex items-center gap-2 text-xs">
                      <span className="font-bold text-slate-900">{sh.staffName}</span>
                      <span className="text-slate-400">·</span>
                      <span className="font-semibold text-teal-800">
                        {sh.roleTier === 'shift_supervisor' ? 'مسؤول أعلى' : 'موظف كاشير'}
                      </span>
                      <span className="text-slate-400">·</span>
                      <span className="text-slate-600">{sh.deviceLabel}</span>
                    </div>
                    <p className="mt-1 text-[11px] text-slate-600">
                      {sh.shiftLabel} · فُتحت: {formatDateTimeAr(sh.openedAt)}
                    </p>
                    <p className="mt-1 font-mono text-xs text-slate-800 tabular-nums">
                      فكة افتتاحية: {formatEGP(sh.openingCashEGP)} · مبيعات الدرج ({sh.posSalesCount}{' '}
                      فاتورة): {formatEGP(sh.posSalesTotalEGP)} · الإجمالي المتوقع بالدرج:{' '}
                      <strong>{formatEGP(sh.expectedCashEGP)}</strong>
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => handleForceCloseShift(sh.id, sh.staffName)}
                    className="flex min-h-[38px] items-center gap-1.5 rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-50"
                  >
                    <XCircle className="h-3.5 w-3.5" />
                    <span>إغلاق إجباري وطرد الجهاز</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 3. Staff & Shift Accounts with Granular Permissions & Password Control */}
      <div className="rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="font-display text-sm font-bold text-slate-900">
              حسابات الورديات والموبايلات والصلاحيات ({staffAccounts.length})
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              عيّن أو غيّر باسوورد كل وردية، وحدد صلاحيات كل موظف ومن هو المسؤول الأعلى.
            </p>
          </div>
          <button
            type="button"
            onClick={() => openEditStaffModal()}
            className="flex min-h-[38px] items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-1.5 text-xs font-semibold text-white hover:bg-teal-700"
          >
            <UserPlus className="h-4 w-4" />
            <span>إضافة موظف / وردية</span>
          </button>
        </div>

        <div className="divide-y divide-slate-100">
          {staffAccounts.map((st) => {
            const activePerms = PERMISSION_LABELS.filter((p) => st.permissions[p.key]).map(
              (p) => p.label,
            );
            const isEditingPin = pinTargetId === st.id;
            return (
              <div key={st.id} className="space-y-3 p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="text-sm font-bold text-slate-900">{st.name}</span>
                      <span className="text-slate-300">·</span>
                      <span
                        className={`font-semibold ${
                          st.roleTier === 'shift_supervisor' ? 'text-teal-800' : 'text-slate-600'
                        }`}
                      >
                        {st.roleTier === 'shift_supervisor' && (
                          <ShieldCheck className="ml-1 inline h-3.5 w-3.5 text-teal-700" />
                        )}
                        {st.roleTier === 'shift_supervisor' ? 'مسؤول أعلى للوردية' : 'موظف كاشير وتجهيز'}
                      </span>
                      <span className="text-slate-300">·</span>
                      <span className={st.isActive ? 'text-emerald-700' : 'text-rose-700'}>
                        {st.isActive ? 'نشط' : 'موقوف'}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-slate-600">
                      {st.shiftLabel} · الجهاز: {st.deviceLabel} · حالة الباسوورد:{' '}
                      <strong className={st.hasPasscode ? 'text-emerald-700' : 'text-amber-700'}>
                        {st.hasPasscode ? 'مُعيّن ومحمي' : 'لم يُعيّن بعد (مطلوب تعيين باسوورد)'}
                      </strong>
                    </p>
                    <p className="mt-1 text-[11px] text-slate-500">
                      الصلاحيات: {activePerms.length > 0 ? activePerms.join('، ') : 'لا توجد صلاحيات'}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        if (isEditingPin) {
                          setPinTargetId(null);
                          setNewPinValue('');
                        } else {
                          setPinTargetId(st.id);
                          setNewPinValue('');
                        }
                      }}
                      className={`flex min-h-[36px] items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold ${
                        !st.hasPasscode
                          ? 'border-amber-400 bg-amber-50 text-amber-900 hover:bg-amber-100'
                          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <KeyRound className="h-3.5 w-3.5" />
                      <span>{st.hasPasscode ? 'تغيير الباسوورد' : 'تعيين الباسوورد الآن'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => openEditStaffModal(st)}
                      className="min-h-[36px] rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-teal-800 hover:bg-slate-50"
                    >
                      تعديل الصلاحيات والحالة
                    </button>
                  </div>
                </div>

                {isEditingPin && (
                  <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <input
                      type="password"
                      dir="ltr"
                      value={newPinValue}
                      onChange={(e) => setNewPinValue(e.target.value)}
                      placeholder="اكتب رمز PIN / باسوورد (4 أرقام أو أحرف على الأقل)..."
                      className="min-h-[38px] flex-1 rounded-lg border border-slate-300 bg-white px-3 text-right font-mono text-xs"
                    />
                    <button
                      type="button"
                      onClick={() => handleSavePin(st.id)}
                      className="min-h-[38px] rounded-lg bg-teal-700 px-4 text-xs font-semibold text-white hover:bg-teal-800"
                    >
                      حفظ الباسوورد الجديد
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setPinTargetId(null);
                        setNewPinValue('');
                      }}
                      className="min-h-[38px] rounded-lg border border-slate-200 bg-white px-3 text-xs text-slate-600"
                    >
                      إلغاء
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* 4. Shift Closure & Cash Variance Log */}
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-5 py-3">
          <h2 className="font-display text-sm font-bold text-slate-900">
            سجل الورديات المغلقة وتسليم عهدة الدرج
          </h2>
        </div>
        {closedShifts.length === 0 ? (
          <p className="p-6 text-center text-xs text-slate-500">لا توجد ورديات مغلقة مسجلة بعد.</p>
        ) : (
          <table className="w-full text-right text-xs">
            <thead className="border-b border-slate-100 bg-slate-50 text-slate-600">
              <tr>
                <th className="px-4 py-2.5 font-semibold">الموظف والوردية</th>
                <th className="px-4 py-2.5 font-semibold">الفتح / الإغلاق</th>
                <th className="px-4 py-2.5 font-semibold">فواتير الدرج</th>
                <th className="px-4 py-2.5 font-semibold">المتوقع بالدرج</th>
                <th className="px-4 py-2.5 font-semibold">الفعلي المُسلَّم</th>
                <th className="px-4 py-2.5 font-semibold">الفرق</th>
                <th className="px-4 py-2.5 font-semibold">طريقة الإغلاق</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {closedShifts.map((sh) => (
                <tr key={sh.id}>
                  <td className="px-4 py-2.5">
                    <p className="font-semibold text-slate-900">{sh.staffName}</p>
                    <p className="text-[11px] text-slate-500">{sh.shiftLabel}</p>
                  </td>
                  <td className="px-4 py-2.5 text-[11px] text-slate-600">
                    <div>{formatDateTimeAr(sh.openedAt)}</div>
                    <div>{formatDateTimeAr(sh.closedAt)}</div>
                  </td>
                  <td className="px-4 py-2.5 font-mono tabular-nums">
                    {sh.posSalesCount} ({formatEGP(sh.posSalesTotalEGP)})
                  </td>
                  <td className="px-4 py-2.5 font-mono tabular-nums">
                    {formatEGP(sh.expectedCashEGP)}
                  </td>
                  <td className="px-4 py-2.5 font-mono tabular-nums">
                    {sh.declaredClosingCashEGP !== undefined
                      ? formatEGP(sh.declaredClosingCashEGP)
                      : '—'}
                  </td>
                  <td className="px-4 py-2.5 font-mono font-semibold tabular-nums">
                    {sh.cashVarianceEGP !== undefined ? (
                      <span
                        className={
                          sh.cashVarianceEGP < 0
                            ? 'text-rose-700'
                            : sh.cashVarianceEGP > 0
                              ? 'text-sky-700'
                              : 'text-emerald-700'
                        }
                      >
                        {sh.cashVarianceEGP > 0
                          ? `+${formatEGP(sh.cashVarianceEGP)}`
                          : formatEGP(sh.cashVarianceEGP)}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-[11px] text-slate-600">
                    {sh.status === 'force_closed' ? 'إغلاق إجباري' : 'تقفيل طبيعي'} — {sh.closedBy}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Add / Edit Staff & Permissions Modal */}
      {editingStaff && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <form
            onSubmit={handleSaveStaffModal}
            className="max-h-[90vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-xl border border-slate-200 bg-white p-5 shadow-xl"
          >
            <h3 className="font-display text-base font-bold text-slate-900">
              {editingStaff.id ? 'تعديل صلاحيات وحساب الوردية' : 'إضافة موظف / وردية جديدة'}
            </h3>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-700">الاسم / الوصف</label>
                <input
                  type="text"
                  required
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  className="min-h-[38px] w-full rounded-lg border border-slate-200 px-3 text-xs"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-700">اسم الوردية</label>
                <input
                  type="text"
                  required
                  value={formShiftLabel}
                  onChange={(e) => setFormShiftLabel(e.target.value)}
                  className="min-h-[38px] w-full rounded-lg border border-slate-200 px-3 text-xs"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-700">تسمية الموبايل / الجهاز</label>
                <input
                  type="text"
                  required
                  value={formDeviceLabel}
                  onChange={(e) => setFormDeviceLabel(e.target.value)}
                  className="min-h-[38px] w-full rounded-lg border border-slate-200 px-3 text-xs"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-700">المستوى الوظيفي</label>
                <select
                  value={formRoleTier}
                  onChange={(e) => {
                    const nextTier = e.target.value as ShopStaffRole;
                    setFormRoleTier(nextTier);
                    setFormPerms(DEFAULT_STAFF_PERMS[nextTier]);
                  }}
                  className="min-h-[38px] w-full rounded-lg border border-slate-200 px-2.5 text-xs"
                >
                  <option value="cashier_staff">موظف كاشير وتجهيز</option>
                  <option value="shift_supervisor">مسؤول أعلى للوردية (صلاحيات إشرافية)</option>
                </select>
              </div>
            </div>

            <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs font-bold text-slate-800">صلاحيات هذه الجلسة:</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {PERMISSION_LABELS.map(({ key, label }) => {
                  const disabled = key === 'canForceCloseShifts' && formRoleTier !== 'shift_supervisor';
                  return (
                    <label
                      key={key}
                      className={`flex items-center gap-2 text-xs ${
                        disabled ? 'text-slate-400' : 'text-slate-700'
                      }`}
                    >
                      <input
                        type="checkbox"
                        disabled={disabled}
                        checked={formPerms[key]}
                        onChange={(e) =>
                          setFormPerms((prev) => ({ ...prev, [key]: e.target.checked }))
                        }
                      />
                      <span>{label}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            <label className="flex items-center gap-2 text-xs font-semibold text-slate-800">
              <input
                type="checkbox"
                checked={formActive}
                onChange={(e) => setFormActive(e.target.checked)}
              />
              <span>الحساب نشط ومسموح له بالدخول من الـ QR</span>
            </label>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setEditingStaff(null)}
                className="min-h-[40px] rounded-lg border border-slate-200 px-4 text-xs text-slate-700"
              >
                إلغاء
              </button>
              <button
                type="submit"
                className="min-h-[40px] rounded-lg bg-teal-700 px-5 text-xs font-semibold text-white hover:bg-teal-800"
              >
                حفظ التغييرات
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
