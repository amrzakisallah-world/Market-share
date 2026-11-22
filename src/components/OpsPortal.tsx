import React, { useCallback, useEffect, useState } from 'react';
import {
  BarChart3,
  Lock,
  LogOut,
  ShieldCheck,
  ShoppingBag,
  Store,
  Truck,
  UserCheck,
} from 'lucide-react';
import { opsAuthApi, setOpsToken, type OpsSessionInfo } from '../api/client';
import { AdminDashboard } from './AdminDashboard';
import { CustomerStorefront } from './CustomerStorefront';
import { ShopOwnerDashboard } from './ShopOwnerDashboard';
import { VolunteerDashboard } from './VolunteerDashboard';

export type OpsDestination =
  | 'customer'
  | 'shop_a'
  | 'shop_b'
  | 'vol_1'
  | 'vol_2'
  | 'admin_overview'
  | 'admin_analytics';

export const OPS_NAV_DESTINATIONS: Array<{
  id: OpsDestination;
  impersonateTarget: 'customer' | 'shop_a' | 'shop_b' | 'vol_1' | 'vol_2' | 'super_admin';
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'customer', impersonateTarget: 'customer', label: 'واجهة العميل', Icon: ShoppingBag },
  { id: 'shop_a', impersonateTarget: 'shop_a', label: 'ماركت النور (1)', Icon: Store },
  { id: 'shop_b', impersonateTarget: 'shop_b', label: 'ماركت الأمانة (2)', Icon: Store },
  { id: 'vol_1', impersonateTarget: 'vol_1', label: 'المتطوع الأول: أحمد', Icon: Truck },
  { id: 'vol_2', impersonateTarget: 'vol_2', label: 'المتطوع الثاني: كريم', Icon: Truck },
  {
    id: 'admin_overview',
    impersonateTarget: 'super_admin',
    label: 'لوحة الإدارة',
    Icon: ShieldCheck,
  },
  {
    id: 'admin_analytics',
    impersonateTarget: 'super_admin',
    label: 'التقارير المالية والتشغيلية',
    Icon: BarChart3,
  },
];

interface OpsPortalProps {
  initialDestination?: OpsDestination;
}

export const OpsPortal: React.FC<OpsPortalProps> = ({ initialDestination }) => {
  const [checking, setChecking] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [session, setSession] = useState<OpsSessionInfo | null>(null);
  const [passcode, setPasscode] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [activeDest, setActiveDest] = useState<OpsDestination>(
    initialDestination || 'admin_overview',
  );
  const [switchingRole, setSwitchingRole] = useState(false);

  const applyDestination = useCallback(async (destId: OpsDestination) => {
    const dest = OPS_NAV_DESTINATIONS.find((d) => d.id === destId);
    if (!dest) return;
    setSwitchingRole(true);
    setAuthError(null);
    try {
      const res = await opsAuthApi.impersonate(dest.impersonateTarget);
      setOpsToken(res.token);
      setSession(res.session);
      setActiveDest(dest.id);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'تعذر تبديل الدور');
    } finally {
      setSwitchingRole(false);
    }
  }, []);

  const checkStatus = useCallback(async () => {
    setChecking(true);
    try {
      const status = await opsAuthApi.getStatus();
      setNeedsSetup(status.needsSetup);
      if (status.authenticated && status.session) {
        setSession(status.session);
        if (initialDestination && initialDestination !== 'admin_overview') {
          await applyDestination(initialDestination);
        }
      } else {
        setSession(null);
      }
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'تعذر التحقق من حالة الجلسة');
    } finally {
      setChecking(false);
    }
  }, [initialDestination, applyDestination]);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setSubmitting(true);
    try {
      const res = needsSetup
        ? await opsAuthApi.claimAdmin(passcode)
        : await opsAuthApi.login(passcode);
      setOpsToken(res.token);
      setSession(res.session);
      setNeedsSetup(false);
      setPasscode('');

      const targetDest = initialDestination || 'admin_overview';
      if (targetDest !== 'admin_overview') {
        await applyDestination(targetDest);
      } else {
        setActiveDest('admin_overview');
      }
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'فشل التحقق من رمز المرور');
    } finally {
      setSubmitting(false);
    }
  };

  const handleLogout = () => {
    setOpsToken(null);
    setSession(null);
  };

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-600">
        جاري التحقق من جلسة الإدارة...
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
        <form
          onSubmit={handleAuthSubmit}
          className="w-full max-w-md space-y-5 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8"
        >
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-white">
              <Lock className="h-5 w-5" />
            </div>
            <div>
              <h1 className="font-display text-lg font-bold text-slate-900">
                {needsSetup ? 'تعيين رمز دخول الإدارة لأول مرة' : 'بوابة الإدارة والتشغيل المركزي'}
              </h1>
              <p className="text-xs text-slate-500">Local Commerce Operating System</p>
            </div>
          </div>

          <p className="text-xs leading-relaxed text-slate-600">
            {needsSetup
              ? 'اختر رمز مرور للإدارة المركزية لحماية لوحات المحلات والمتطوعين والتقارير. بعد الدخول يمكنك التبديل بين كل الأدوار من أسفل أو أعلى الصفحة.'
              : 'أدخل رمز مرور الإدارة المركزية للدخول إلى لوحة التحكم ومحاكاة أدوار التشغيل.'}
          </p>

          <div>
            <label className="mb-1.5 block text-xs font-semibold text-slate-700">
              رمز مرور الإدارة
            </label>
            <input
              type="password"
              required
              minLength={4}
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
              placeholder={needsSetup ? 'أدخل رمزًا من 4 أحرف/أرقام على الأقل' : 'أدخل رمز المرور'}
              className="min-h-[44px] w-full rounded-lg border border-slate-300 px-3 text-sm focus:border-teal-700 focus:outline-none"
            />
          </div>

          {authError && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
              {authError}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="min-h-[44px] w-full rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white transition-colors hover:bg-teal-700 disabled:opacity-50"
          >
            {submitting
              ? 'جاري التحقق...'
              : needsSetup
                ? 'حفظ الرمز والدخول للإدارة'
                : 'دخول لبوابة الإدارة'}
          </button>

          <div className="border-t border-slate-100 pt-3 text-center">
            <a href="/" className="text-xs font-medium text-teal-800 hover:underline">
              العودة لواجهة متجر العميل
            </a>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-dvh w-full max-w-full overflow-x-clip bg-slate-50 text-slate-900">
      {/* Role Simulation Indicator Header (Responsive, Zero Overflow) */}
      <div className="sticky top-0 z-40 border-b border-slate-800 bg-slate-900 text-white">
        <div className="mx-auto max-w-7xl px-3 py-2.5 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <UserCheck className="h-4 w-4 shrink-0 text-teal-400" />
              <span className="font-semibold text-teal-300">محاكاة الأدوار:</span>
              <span className="truncate font-bold text-white">{session.effectiveLabel}</span>
            </div>
            <button
              type="button"
              onClick={handleLogout}
              className="flex shrink-0 items-center gap-1 text-slate-300 hover:text-white"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span>قفل الجلسة</span>
            </button>
          </div>
        </div>
      </div>

      {authError && (
        <div className="mx-auto mt-4 max-w-7xl px-4 sm:px-6">
          <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
            {authError}
          </div>
        </div>
      )}

      {/* Active Workspace Viewport */}
      {activeDest === 'customer' ? (
        <CustomerStorefront embeddedInOps />
      ) : (
        <main className="mx-auto w-full max-w-7xl min-w-0 px-3 py-5 sm:px-6 sm:py-6">
          {activeDest === 'shop_a' && <ShopOwnerDashboard shopId="shop_a" />}
          {activeDest === 'shop_b' && <ShopOwnerDashboard shopId="shop_b" />}
          {activeDest === 'vol_1' && <VolunteerDashboard volunteerId="vol_1" />}
          {activeDest === 'vol_2' && <VolunteerDashboard volunteerId="vol_2" />}
          {activeDest === 'admin_overview' && <AdminDashboard initialSection="overview" />}
          {activeDest === 'admin_analytics' && <AdminDashboard initialSection="analytics" />}
        </main>
      )}

      {/* Bottom Role Switcher Footer */}
      <footer className="mt-8 border-t border-slate-200 bg-white">
        <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6">
          <p className="mb-3 text-xs font-semibold text-slate-600">
            تبديل الواجهة والدور النشط (وضع محاكاة التشغيل):
          </p>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
            {OPS_NAV_DESTINATIONS.map((dest) => {
              const Icon = dest.Icon;
              const isActive = activeDest === dest.id;
              return (
                <button
                  key={dest.id}
                  type="button"
                  disabled={switchingRole}
                  onClick={() => {
                    applyDestination(dest.id);
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                  className={`flex min-h-[44px] min-w-0 items-center gap-1.5 rounded-lg border px-3 py-2 text-right text-xs font-semibold transition-colors ${
                    isActive
                      ? 'border-teal-700 bg-teal-700 text-white'
                      : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{dest.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </footer>
    </div>
  );
};
