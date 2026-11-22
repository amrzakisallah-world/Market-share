import type {
  CashRemittanceMode,
  DeliveryStatus,
  InventoryMovementType,
  OrderStatus,
  ProductCategory,
  RemittanceChannel,
  RemittanceStatus,
  SettlementStatus,
  ShopDailyEntryType,
} from '../types/commerce';

export const PRODUCT_CATEGORIES: ProductCategory[] = [
  'الأرز والسكر والزيوت',
  'المكرونة والدقيق والبقوليات',
  'الشاي والقهوة',
  'اللبن والجبن والزبادي',
  'البيض والمعلبات',
  'المياه والعصائر والمشروبات',
  'سناكس وحلويات وبسكويت',
  'مخبوزات ومعجنات',
  'مجمدات ولحوم ودواجن',
  'المنظفات',
  'الصابون والشامبو',
  'المناديل والورقيات',
  'دخان وتبغ',
  'أدوات منزلية ومكتبية',
  'أخرى / منتجات عامة',
];

export function formatEGP(amount: number): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  return `${safe.toLocaleString('en-US', {
    minimumFractionDigits: Number.isInteger(safe) ? 0 : 2,
    maximumFractionDigits: 2,
  })} ج.م`;
}

export function formatDateTimeAr(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('ar-EG', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export const ORDER_STATUS_META: Record<
  OrderStatus,
  { label: string; textClass: string; surfaceClass: string }
> = {
  new: {
    label: 'طلب جديد',
    textClass: 'text-amber-800',
    surfaceClass: 'bg-amber-50 border-amber-200',
  },
  confirmed: {
    label: 'مؤكد من المحل',
    textClass: 'text-sky-800',
    surfaceClass: 'bg-sky-50 border-sky-200',
  },
  preparing: {
    label: 'جاري التجهيز',
    textClass: 'text-indigo-800',
    surfaceClass: 'bg-indigo-50 border-indigo-200',
  },
  ready: {
    label: 'جاهز للاستلام',
    textClass: 'text-teal-800',
    surfaceClass: 'bg-teal-50 border-teal-200',
  },
  completed: {
    label: 'مكتمل',
    textClass: 'text-emerald-800',
    surfaceClass: 'bg-emerald-50 border-emerald-200',
  },
  cancelled: {
    label: 'ملغى',
    textClass: 'text-rose-800',
    surfaceClass: 'bg-rose-50 border-rose-200',
  },
};

export const DELIVERY_STATUS_META: Record<
  DeliveryStatus,
  { label: string; textClass: string }
> = {
  unassigned: { label: 'لم يتم الإسناد', textClass: 'text-slate-600' },
  assigned: { label: 'تم الإسناد', textClass: 'text-sky-700' },
  heading_to_shop: { label: 'في الطريق إلى المحل', textClass: 'text-indigo-700' },
  picked_up: { label: 'تم استلام الطلب', textClass: 'text-amber-700' },
  heading_to_customer: { label: 'في الطريق إلى العميل', textClass: 'text-teal-700' },
  delivered: { label: 'تم التسليم', textClass: 'text-emerald-700' },
  delivery_failed: { label: 'فشل التسليم', textClass: 'text-rose-700' },
};

export const SETTLEMENT_STATUS_META: Record<
  SettlementStatus,
  { label: string; textClass: string }
> = {
  uncollected: { label: 'لم يتم التحصيل', textClass: 'text-slate-600' },
  collected: { label: 'تم التحصيل', textClass: 'text-sky-700' },
  shop_unsettled: { label: 'لم تتم تسوية مستحقات المحل', textClass: 'text-amber-700' },
  shop_settled: { label: 'تمت تسوية المحل', textClass: 'text-indigo-700' },
  volunteer_settled: { label: 'تمت تسوية المتطوع', textClass: 'text-teal-700' },
  fully_settled: { label: 'تمت التسوية بالكامل', textClass: 'text-emerald-700' },
};

export const INVENTORY_MOVEMENT_LABELS: Record<InventoryMovementType, string> = {
  initial_seed: 'رصيد افتتاحي',
  reserve: 'حجز لطلب',
  release_reservation: 'فك حجز',
  deduct_on_fulfill: 'خصم عند التجهيز',
  return_to_stock: 'إرجاع للمخزون',
  manual_add: 'إضافة يدوية',
  manual_deduct: 'خصم يدوي',
  purchase_restock: 'توريد مشتريات',
  pos_offline_sale: 'بيع كاشير داخل المحل',
};

export const DAILY_ENTRY_LABELS: Record<ShopDailyEntryType, string> = {
  expense: 'مصروف تشغيل',
  purchase: 'فاتورة مشتريات',
  offline_sale: 'مبيعات داخل المحل (خارج المنصة)',
};

export const REMITTANCE_MODE_LABELS: Record<CashRemittanceMode, string> = {
  full_to_shop: 'توريد المبلغ كاملًا للمحل (فلوسنا عند السوبر ماركت)',
  split_shop_and_courier: 'توريد حصة المحل فقط (الجزء بتاعنا مع المندوب)',
  full_to_platform_instapay: 'تحويل كامل المبلغ إنستاباي للإدارة مباشرة',
};

export const REMITTANCE_CHANNEL_LABELS: Record<RemittanceChannel, string> = {
  cash: 'نقدي في اليد',
  instapay: 'تحويل إنستاباي (InstaPay)',
};

export const REMITTANCE_STATUS_META: Record<
  RemittanceStatus,
  { label: string; textClass: string }
> = {
  pending_shop_confirmation: {
    label: 'بانتظار تأكيد استلام المحل',
    textClass: 'text-amber-700',
  },
  pending_platform_confirmation: {
    label: 'المحل استلم — بانتظار توريد نصيب الإدارة',
    textClass: 'text-indigo-700',
  },
  settled: {
    label: 'تم التوريد وتقفيل العهدة بالكامل',
    textClass: 'text-emerald-700',
  },
};

