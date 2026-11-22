import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Clock,
  Coffee,
  Droplets,
  Egg,
  Heart,
  LocateFixed,
  MapPin,
  Milk,
  Minus,
  Package,
  Phone,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Star,
  Store,
  Trash2,
  Truck,
  Utensils,
  Wheat,
  X,
} from 'lucide-react';
import { storeApi, type PublicCatalogItem } from '../api/client';
import type { CustomerProfile, Order, ProductCategory, Shop } from '../types/commerce';
import {
  DELIVERY_STATUS_META,
  ORDER_STATUS_META,
  PRODUCT_CATEGORIES,
  formatDateTimeAr,
  formatEGP,
} from '../utils/arabicLabels';
import type { OpsDestination } from './OpsPortal';

const TRACKED_ORDERS_KEY = 'local_commerce_tracked_orders_v1';
const CUSTOMER_SETTINGS_KEY = 'local_commerce_customer_settings_v1';

const RATING_MOOD_LABELS: Record<number, string> = {
  1: 'نعتذر جدًا — شاركينا السبب لنصلحه فورًا',
  2: 'مقبول — نحب نعرف إيه اللي نقدر نحسنه',
  3: 'كويس — شكرًا لمشاركتك رأيك',
  4: 'حلو جدًا ومرضي — سعدنا بخدمتك',
  5: 'ممتاز ويفرح القلب! شكرًا لذوقك',
};

const COMPLIMENT_OPTIONS = [
  'الطلب كامل ومظبوط',
  'تغليف نظيف ومرتب',
  'وصل في وقته',
  'مندوب ذوق ومحترم',
  'منتجات طازجة',
  'أسعار مناسبة',
];

function getFirstNameAr(fullName?: string): string {
  const clean = (fullName ?? '').trim();
  if (!clean) return 'يا فندم';
  return clean.split(/\s+/)[0];
}

interface CartEntry {
  product: PublicCatalogItem;
  quantity: number;
}

interface SavedAddress {
  id: string;
  label: string;
  address: string;
  lat?: number;
  lng?: number;
}

interface CustomerSettings {
  name: string;
  phone: string;
  defaultAddressId?: string;
  addresses: SavedAddress[];
}

function loadSavedSettings(): CustomerSettings {
  try {
    const raw = localStorage.getItem(CUSTOMER_SETTINGS_KEY);
    if (!raw) return { name: '', phone: '', addresses: [] };
    const parsed = JSON.parse(raw) as CustomerSettings;
    return {
      name: parsed.name ?? '',
      phone: parsed.phone ?? '',
      defaultAddressId: parsed.defaultAddressId,
      addresses: Array.isArray(parsed.addresses) ? parsed.addresses : [],
    };
  } catch {
    return { name: '', phone: '', addresses: [] };
  }
}

function persistSavedSettings(settings: CustomerSettings) {
  try {
    localStorage.setItem(CUSTOMER_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // ignore quota errors
  }
}

function getCategoryVisual(category: ProductCategory) {
  switch (category) {
    case 'الأرز والسكر والزيوت':
      return { Icon: Wheat, bg: 'bg-amber-50 text-amber-700' };
    case 'المكرونة والدقيق والبقوليات':
      return { Icon: Utensils, bg: 'bg-orange-50 text-orange-700' };
    case 'الشاي والقهوة':
      return { Icon: Coffee, bg: 'bg-stone-100 text-stone-700' };
    case 'اللبن والجبن والزبادي':
      return { Icon: Milk, bg: 'bg-sky-50 text-sky-700' };
    case 'البيض والمعلبات':
      return { Icon: Egg, bg: 'bg-yellow-50 text-yellow-700' };
    case 'المياه والعصائر والمشروبات':
      return { Icon: Droplets, bg: 'bg-cyan-50 text-cyan-700' };
    case 'المنظفات':
      return { Icon: Sparkles, bg: 'bg-indigo-50 text-indigo-700' };
    case 'الصابون والشامبو':
      return { Icon: Droplets, bg: 'bg-teal-50 text-teal-700' };
    case 'المناديل والورقيات':
    default:
      return { Icon: Package, bg: 'bg-slate-100 text-slate-700' };
  }
}

async function resolveCurrentGpsLocation(): Promise<{
  lat: number;
  lng: number;
  resolvedAddress: string;
}> {
  if (!('geolocation' in navigator)) {
    throw new Error('المتصفح لا يدعم خدمة تحديد الموقع GPS');
  }

  const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 60000,
    });
  }).catch((err: GeolocationPositionError) => {
    if (err.code === err.PERMISSION_DENIED) {
      throw new Error('تم رفض إذن الموقع. يرجى السماح بالوصول للموقع من إعدادات المتصفح.');
    }
    throw new Error('تعذر تحديد الموقع حاليًا، يرجى التأكد من تفعيل GPS أو إدخال العنوان يدويًا.');
  });

  const lat = Number(pos.coords.latitude.toFixed(6));
  const lng = Number(pos.coords.longitude.toFixed(6));

  let resolvedAddress = `الموقع المحدد بالخريطة (${lat}, ${lng})`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&accept-language=ar`,
      { signal: controller.signal },
    );
    clearTimeout(timer);
    if (res.ok) {
      const json = (await res.json()) as {
        display_name?: string;
        address?: {
          road?: string;
          neighbourhood?: string;
          suburb?: string;
          city?: string;
          state?: string;
        };
      };
      const parts = [
        json.address?.road,
        json.address?.neighbourhood || json.address?.suburb,
        json.address?.city || json.address?.state,
      ].filter(Boolean);
      if (parts.length > 0) {
        resolvedAddress = `${parts.join('، ')} (${lat}, ${lng})`;
      } else if (json.display_name) {
        resolvedAddress = json.display_name;
      }
    }
  } catch {
    // Graceful fallback to coordinates string
  }

  return { lat, lng, resolvedAddress };
}

export interface CustomerStorefrontProps {
  embeddedInOps?: boolean;
  onSwitchRole?: (dest: OpsDestination) => void;
}

export const CustomerStorefront: React.FC<CustomerStorefrontProps> = ({
  embeddedInOps = false,
  onSwitchRole,
}) => {
  const [shops, setShops] = useState<Shop[]>([]);
  const [selectedShopId, setSelectedShopId] = useState<string>('shop_a');
  const [catalog, setCatalog] = useState<PublicCatalogItem[]>([]);
  const [demoCustomers, setDemoCustomers] = useState<CustomerProfile[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<'shop' | 'track' | 'settings'>('shop');
  const [selectedCategory, setSelectedCategory] = useState<string>('الكل');
  const [searchQuery, setSearchQuery] = useState<string>('');

  const [cart, setCart] = useState<CartEntry[]>([]);
  const [cartOpen, setCartOpen] = useState<boolean>(false);

  // Saved customer settings & addresses
  const [savedSettings, setSavedSettings] = useState<CustomerSettings>(loadSavedSettings);
  const defaultSavedAddr = useMemo(
    () =>
      savedSettings.addresses.find((a) => a.id === savedSettings.defaultAddressId) ??
      savedSettings.addresses[0],
    [savedSettings],
  );

  // Checkout fields (initialized from saved settings)
  const [customerName, setCustomerName] = useState<string>(() => loadSavedSettings().name);
  const [customerPhone, setCustomerPhone] = useState<string>(() => loadSavedSettings().phone);
  const [deliveryAddress, setDeliveryAddress] = useState<string>(() => {
    const s = loadSavedSettings();
    const def = s.addresses.find((a) => a.id === s.defaultAddressId) ?? s.addresses[0];
    return def?.address ?? '';
  });
  const [deliveryLocation, setDeliveryLocation] = useState<{ lat: number; lng: number } | undefined>(
    () => {
      const s = loadSavedSettings();
      const def = s.addresses.find((a) => a.id === s.defaultAddressId) ?? s.addresses[0];
      return def?.lat !== undefined && def?.lng !== undefined
        ? { lat: def.lat, lng: def.lng }
        : undefined;
    },
  );
  const [deliveryNotes, setDeliveryNotes] = useState<string>('');
  const [saveToSettings, setSaveToSettings] = useState<boolean>(true);
  const [newAddressLabel, setNewAddressLabel] = useState<string>('المنزل');
  const [locatingGps, setLocatingGps] = useState<boolean>(false);
  const [gpsNotice, setGpsNotice] = useState<string | null>(null);
  const [submittingOrder, setSubmittingOrder] = useState<boolean>(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  // Settings Tab Form State
  const [settingsName, setSettingsName] = useState<string>(() => loadSavedSettings().name);
  const [settingsPhone, setSettingsPhone] = useState<string>(() => loadSavedSettings().phone);
  const [addrLabelInput, setAddrLabelInput] = useState<string>('المنزل');
  const [addrTextInput, setAddrTextInput] = useState<string>('');
  const [addrGpsInput, setAddrGpsInput] = useState<{ lat: number; lng: number } | undefined>();
  const [settingsMsg, setSettingsMsg] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  // Tracking state
  const [trackedNumbers, setTrackedNumbers] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(TRACKED_ORDERS_KEY);
      return saved ? (JSON.parse(saved) as string[]) : [];
    } catch {
      return [];
    }
  });
  const [lookupInput, setLookupInput] = useState<string>('');
  const [trackedOrder, setTrackedOrder] = useState<Order | null>(null);
  const [trackingError, setTrackingError] = useState<string | null>(null);
  const [trackingLoading, setTrackingLoading] = useState<boolean>(false);
  const [cancelReason, setCancelReason] = useState<string>('');
  const [showCancelForm, setShowCancelForm] = useState<boolean>(false);

  // Post-delivery gentle rating state
  const [ratingOverall, setRatingOverall] = useState<number>(0);
  const [ratingShop, setRatingShop] = useState<number>(0);
  const [ratingDelivery, setRatingDelivery] = useState<number>(0);
  const [ratingTags, setRatingTags] = useState<string[]>([]);
  const [ratingComment, setRatingComment] = useState<string>('');
  const [ratingSubmitting, setRatingSubmitting] = useState<boolean>(false);
  const [ratingError, setRatingError] = useState<string | null>(null);
  const [ratingTuckedOrders, setRatingTuckedOrders] = useState<string[]>([]);
  const [pendingRateBannerOrder, setPendingRateBannerOrder] = useState<Order | null>(null);
  const [dismissedBannerOrderNumber, setDismissedBannerOrderNumber] = useState<string | null>(null);

  const loadShopsAndCustomers = useCallback(async () => {
    try {
      const [shopsRes, custRes] = await Promise.all([
        storeApi.getShops(),
        storeApi.getDemoCustomers(),
      ]);
      setShops(shopsRes.shops);
      setDemoCustomers(custRes.customers);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل بيانات المحلات');
    }
  }, []);

  const loadCatalog = useCallback(async (shopId: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await storeApi.getCatalog(shopId);
      setCatalog(res.catalog);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل المنتجات');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadShopsAndCustomers();
  }, [loadShopsAndCustomers]);

  useEffect(() => {
    loadCatalog(selectedShopId);
  }, [selectedShopId, loadCatalog]);

  const fetchTrackedOrder = useCallback(async (orderNumber: string, silent = false) => {
    if (!orderNumber.trim()) return;
    if (!silent) setTrackingLoading(true);
    setTrackingError(null);
    try {
      const res = await storeApi.getOrder(orderNumber.trim());
      setTrackedOrder((prev) => {
        if (prev?.orderNumber !== res.order.orderNumber) {
          setRatingOverall(0);
          setRatingShop(0);
          setRatingDelivery(0);
          setRatingTags([]);
          setRatingComment('');
          setRatingError(null);
        }
        return res.order;
      });
      setLookupInput(res.order.orderNumber);
      if (
        res.order.status === 'completed' &&
        res.order.deliveryStatus === 'delivered' &&
        !res.order.rating
      ) {
        setPendingRateBannerOrder(res.order);
      } else if (res.order.rating) {
        setPendingRateBannerOrder((prev) =>
          prev?.orderNumber === res.order.orderNumber ? null : prev,
        );
      }
    } catch (err) {
      if (!silent) {
        setTrackingError(err instanceof Error ? err.message : 'لم يتم العثور على الطلب');
        setTrackedOrder(null);
      }
    } finally {
      if (!silent) setTrackingLoading(false);
    }
  }, []);

  useEffect(() => {
    if (trackedNumbers.length > 0 && !trackedOrder) {
      fetchTrackedOrder(trackedNumbers[0], activeTab !== 'track');
    }
  }, [trackedNumbers, trackedOrder, activeTab, fetchTrackedOrder]);

  // Smoothly auto-refresh active tracked order so delivery completion & rating invitation appear automatically
  useEffect(() => {
    if (
      activeTab !== 'track' ||
      !trackedOrder ||
      trackedOrder.status === 'completed' ||
      trackedOrder.status === 'cancelled'
    ) {
      return;
    }
    const timer = setInterval(() => {
      fetchTrackedOrder(trackedOrder.orderNumber, true);
    }, 10000);
    return () => clearInterval(timer);
  }, [activeTab, trackedOrder, fetchTrackedOrder]);

  // Lock background page scroll and allow Escape to close when Cart drawer is open
  useEffect(() => {
    if (!cartOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCartOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [cartOpen]);

  const activeShop = useMemo(
    () => shops.find((s) => s.id === selectedShopId) ?? null,
    [shops, selectedShopId],
  );

  const handleSelectShop = (shopId: string) => {
    if (shopId === selectedShopId) return;
    if (cart.length > 0) {
      setCart([]);
    }
    setSelectedShopId(shopId);
    setSelectedCategory('الكل');
    setActiveTab('shop');
  };

  const filteredCatalog = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return catalog.filter((item) => {
      if (selectedCategory !== 'الكل' && item.category !== selectedCategory) return false;
      if (!q) return true;
      return (
        item.name.toLowerCase().includes(q) ||
        item.brand.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q)
      );
    });
  }, [catalog, selectedCategory, searchQuery]);

  const getCartQty = (productId: string) =>
    cart.find((c) => c.product.productId === productId)?.quantity ?? 0;

  const updateCartQty = (item: PublicCatalogItem, nextQty: number) => {
    if (!item.isAvailable || item.availableQuantity <= 0) return;
    const clamped = Math.min(Math.max(0, nextQty), item.availableQuantity);
    setCart((prev) => {
      if (clamped === 0) {
        return prev.filter((c) => c.product.productId !== item.productId);
      }
      const existing = prev.find((c) => c.product.productId === item.productId);
      if (existing) {
        return prev.map((c) =>
          c.product.productId === item.productId ? { ...c, quantity: clamped } : c,
        );
      }
      return [...prev, { product: item, quantity: clamped }];
    });
  };

  const cartCount = useMemo(() => cart.reduce((acc, c) => acc + c.quantity, 0), [cart]);
  const itemsSubtotal = useMemo(
    () => cart.reduce((acc, c) => acc + c.product.priceEGP * c.quantity, 0),
    [cart],
  );
  const deliveryFee = activeShop?.defaultDeliveryFeeEGP ?? 20;
  const orderGrandTotal = itemsSubtotal + (cart.length > 0 ? deliveryFee : 0);

  const applyDemoCustomer = (cust: CustomerProfile) => {
    setCustomerName(cust.name);
    setCustomerPhone(cust.phone);
    setDeliveryAddress(cust.address);
    setDeliveryLocation(undefined);
    setGpsNotice(null);
    setCheckoutError(null);
  };

  const applySavedAddress = (addr: SavedAddress) => {
    setDeliveryAddress(addr.address);
    setDeliveryLocation(
      addr.lat !== undefined && addr.lng !== undefined
        ? { lat: addr.lat, lng: addr.lng }
        : undefined,
    );
    setGpsNotice(
      addr.lat !== undefined && addr.lng !== undefined
        ? `موقع محفوظ (${addr.lat}, ${addr.lng})`
        : null,
    );
    setCheckoutError(null);
  };

  const handleCheckoutUseGps = async () => {
    setLocatingGps(true);
    setCheckoutError(null);
    setGpsNotice(null);
    try {
      const loc = await resolveCurrentGpsLocation();
      setDeliveryAddress(loc.resolvedAddress);
      setDeliveryLocation({ lat: loc.lat, lng: loc.lng });
      setGpsNotice(`تم التقاط موقعك بنجاح (${loc.lat}, ${loc.lng})`);
    } catch (err) {
      setCheckoutError(err instanceof Error ? err.message : 'تعذر تحديد الموقع');
    } finally {
      setLocatingGps(false);
    }
  };

  const handleSettingsUseGps = async () => {
    setLocatingGps(true);
    setSettingsError(null);
    try {
      const loc = await resolveCurrentGpsLocation();
      setAddrTextInput(loc.resolvedAddress);
      setAddrGpsInput({ lat: loc.lat, lng: loc.lng });
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : 'تعذر تحديد الموقع');
    } finally {
      setLocatingGps(false);
    }
  };

  const saveCustomerProfileAndAddress = (
    name: string,
    phone: string,
    address: string,
    label: string,
    coords?: { lat: number; lng: number },
  ) => {
    const trimmedAddr = address.trim();
    const existing = savedSettings.addresses.find((a) => a.address === trimmedAddr);
    let nextAddresses = [...savedSettings.addresses];
    let defaultId = savedSettings.defaultAddressId;

    if (trimmedAddr) {
      if (existing) {
        nextAddresses = nextAddresses.map((a) =>
          a.id === existing.id
            ? {
                ...a,
                label: label.trim() || a.label,
                lat: coords?.lat ?? a.lat,
                lng: coords?.lng ?? a.lng,
              }
            : a,
        );
        defaultId = existing.id;
      } else {
        const newAddr: SavedAddress = {
          id: `addr_${Date.now()}`,
          label: label.trim() || 'العنوان المحفوظ',
          address: trimmedAddr,
          lat: coords?.lat,
          lng: coords?.lng,
        };
        nextAddresses = [newAddr, ...nextAddresses];
        defaultId = newAddr.id;
      }
    }

    const updated: CustomerSettings = {
      name: name.trim(),
      phone: phone.trim(),
      defaultAddressId: defaultId,
      addresses: nextAddresses,
    };
    setSavedSettings(updated);
    setSettingsName(updated.name);
    setSettingsPhone(updated.phone);
    persistSavedSettings(updated);
  };

  const handleSaveProfileOnly = (e: React.FormEvent) => {
    e.preventDefault();
    setSettingsError(null);
    const updated: CustomerSettings = {
      ...savedSettings,
      name: settingsName.trim(),
      phone: settingsPhone.trim(),
    };
    setSavedSettings(updated);
    persistSavedSettings(updated);
    if (updated.name) setCustomerName(updated.name);
    if (updated.phone) setCustomerPhone(updated.phone);
    setSettingsMsg('تم حفظ بياناتك الشخصية في إعداداتك بنجاح');
  };

  const handleAddSavedAddress = (e: React.FormEvent) => {
    e.preventDefault();
    setSettingsError(null);
    if (!addrTextInput.trim()) {
      setSettingsError('يرجى إدخال العنوان أو الضغط على تحديد الموقع GPS');
      return;
    }
    saveCustomerProfileAndAddress(
      settingsName || customerName,
      settingsPhone || customerPhone,
      addrTextInput,
      addrLabelInput,
      addrGpsInput,
    );
    setDeliveryAddress(addrTextInput.trim());
    setDeliveryLocation(addrGpsInput);
    setAddrTextInput('');
    setAddrGpsInput(undefined);
    setSettingsMsg('تم حفظ العنوان في إعداداتك وتعيينه كعنوان افتراضي');
  };

  const handleSetDefaultAddress = (addr: SavedAddress) => {
    const updated: CustomerSettings = {
      ...savedSettings,
      defaultAddressId: addr.id,
    };
    setSavedSettings(updated);
    persistSavedSettings(updated);
    applySavedAddress(addr);
    setSettingsMsg(`تم تعيين "${addr.label}" كعنوان التوصيل الافتراضي`);
  };

  const handleDeleteSavedAddress = (id: string) => {
    const remaining = savedSettings.addresses.filter((a) => a.id !== id);
    const updated: CustomerSettings = {
      ...savedSettings,
      addresses: remaining,
      defaultAddressId:
        savedSettings.defaultAddressId === id ? remaining[0]?.id : savedSettings.defaultAddressId,
    };
    setSavedSettings(updated);
    persistSavedSettings(updated);
  };

  const handlePlaceOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    setCheckoutError(null);
    if (cart.length === 0) {
      setCheckoutError('السلة فارغة');
      return;
    }
    setSubmittingOrder(true);
    try {
      const res = await storeApi.createOrder({
        shopId: selectedShopId,
        customerName,
        customerPhone,
        deliveryAddress,
        deliveryLocation,
        deliveryNotes,
        items: cart.map((c) => ({
          productId: c.product.productId,
          quantity: c.quantity,
        })),
      });

      if (saveToSettings) {
        saveCustomerProfileAndAddress(
          customerName,
          customerPhone,
          deliveryAddress,
          newAddressLabel,
          deliveryLocation,
        );
      }

      const newNum = res.order.orderNumber;
      const updatedNums = [newNum, ...trackedNumbers.filter((n) => n !== newNum)].slice(0, 10);
      setTrackedNumbers(updatedNums);
      try {
        localStorage.setItem(TRACKED_ORDERS_KEY, JSON.stringify(updatedNums));
      } catch {
        // ignore storage quota
      }
      setCart([]);
      setCartOpen(false);
      setDeliveryNotes('');
      setTrackedOrder(res.order);
      setLookupInput(newNum);
      setActiveTab('track');
      await loadCatalog(selectedShopId);
    } catch (err) {
      setCheckoutError(err instanceof Error ? err.message : 'تعذر إرسال الطلب');
    } finally {
      setSubmittingOrder(false);
    }
  };

  const handleCustomerModResponse = async (decision: 'approved' | 'rejected') => {
    if (!trackedOrder) return;
    setTrackingLoading(true);
    setTrackingError(null);
    try {
      const res = await storeApi.respondToModification(
        trackedOrder.orderNumber,
        decision,
        trackedOrder.customerName,
      );
      setTrackedOrder(res.order);
    } catch (err) {
      setTrackingError(err instanceof Error ? err.message : 'تعذر تسجيل الرد');
    } finally {
      setTrackingLoading(false);
    }
  };

  const handleCustomerCancel = async () => {
    if (!trackedOrder) return;
    setTrackingLoading(true);
    setTrackingError(null);
    try {
      const res = await storeApi.cancelOrder(
        trackedOrder.orderNumber,
        cancelReason.trim() || 'إلغاء من العميل قبل التوصيل',
      );
      setTrackedOrder(res.order);
      setShowCancelForm(false);
      setCancelReason('');
      await loadCatalog(selectedShopId);
    } catch (err) {
      setTrackingError(err instanceof Error ? err.message : 'تعذر إلغاء الطلب');
    } finally {
      setTrackingLoading(false);
    }
  };

  const handleToggleCompliment = (tag: string) => {
    setRatingTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : prev.length < 6 ? [...prev, tag] : prev,
    );
  };

  const handleSubmitOrderRating = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!trackedOrder) return;
    if (ratingOverall < 1) {
      setRatingError('اختاري عدد النجوم الأول عشان نعرف رأيك اللطيف');
      return;
    }
    setRatingSubmitting(true);
    setRatingError(null);
    try {
      const res = await storeApi.submitRating(trackedOrder.orderNumber, {
        overallRating: ratingOverall,
        shopRating: ratingShop > 0 ? ratingShop : undefined,
        deliveryRating: ratingDelivery > 0 ? ratingDelivery : undefined,
        complimentTags: ratingTags,
        comment: ratingComment.trim() || undefined,
      });
      setTrackedOrder(res.order);
      setPendingRateBannerOrder(null);
    } catch (err) {
      setRatingError(err instanceof Error ? err.message : 'تعذر إرسال التقييم حاليًا');
    } finally {
      setRatingSubmitting(false);
    }
  };

  const ROLE_SWITCH_BUTTONS: Array<{
    id: OpsDestination;
    label: string;
    Icon: React.ComponentType<{ className?: string }>;
  }> = [
    { id: 'customer', label: 'واجهة العميل', Icon: ShoppingBag },
    { id: 'shop_a', label: 'ماركت النور (1)', Icon: Store },
    { id: 'shop_b', label: 'ماركت الأمانة (2)', Icon: Store },
    { id: 'vol_1', label: 'المتطوع الأول: أحمد', Icon: Truck },
    { id: 'vol_2', label: 'المتطوع الثاني: كريم', Icon: Truck },
    { id: 'admin_overview', label: 'لوحة الإدارة', Icon: ShieldCheck },
    { id: 'admin_analytics', label: 'التقارير المالية والتشغيلية', Icon: BarChart3 },
  ];

  return (
    <div className="flex min-h-dvh w-full max-w-full flex-col overflow-x-clip bg-slate-50 text-slate-900">
      {/* Mobile-Fitted 3-Zone Top Bar */}
      <header className="sticky top-0 z-30 w-full border-b border-slate-200 bg-white/95 backdrop-blur-sm">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-1.5 px-2.5 py-2 sm:gap-8 sm:px-6 sm:py-2.5">
          {/* Zone 1: Brand Wordmark */}
          <button
            type="button"
            onClick={() => setActiveTab('shop')}
            className="font-display flex min-h-[38px] shrink-0 items-center whitespace-nowrap text-sm font-bold tracking-tight text-slate-900 sm:text-lg"
          >
            سوق الحي
          </button>

          {/* Zone 2: Compact Mobile / Desktop Nav Links */}
          <nav className="flex min-w-0 items-center gap-2 text-[11px] font-medium text-slate-600 sm:gap-7 sm:text-sm">
            <button
              type="button"
              onClick={() => setActiveTab('shop')}
              className={`min-h-[38px] shrink-0 whitespace-nowrap py-1 transition-colors ${
                activeTab === 'shop'
                  ? 'border-b-2 border-teal-700 font-semibold text-teal-800'
                  : 'hover:text-slate-900'
              }`}
            >
              <span className="sm:hidden">المتجر</span>
              <span className="hidden sm:inline">تصفح البقالة</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('track')}
              className={`min-h-[38px] shrink-0 whitespace-nowrap py-1 transition-colors ${
                activeTab === 'track'
                  ? 'border-b-2 border-teal-700 font-semibold text-teal-800'
                  : 'hover:text-slate-900'
              }`}
            >
              <span className="sm:hidden">طلباتي</span>
              <span className="hidden sm:inline">متابعة الطلب</span>
              {trackedNumbers.length > 0 && (
                <span className="mr-0.5 font-mono text-[10px] text-slate-500 tabular-nums sm:mr-1 sm:text-[11px]">
                  ({trackedNumbers.length})
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('settings')}
              className={`min-h-[38px] shrink-0 whitespace-nowrap py-1 transition-colors ${
                activeTab === 'settings'
                  ? 'border-b-2 border-teal-700 font-semibold text-teal-800'
                  : 'hover:text-slate-900'
              }`}
            >
              إعداداتي
            </button>
          </nav>

          {/* Zone 3: Cart Action */}
          <button
            type="button"
            onClick={() => setCartOpen(true)}
            className="flex min-h-[40px] shrink-0 items-center gap-1 whitespace-nowrap rounded-lg bg-teal-700 px-2.5 py-1.5 text-[11px] font-semibold text-white transition-colors hover:bg-teal-800 sm:min-h-[42px] sm:gap-1.5 sm:px-4 sm:py-2 sm:text-sm"
          >
            <ShoppingBag className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
            <span>السلة</span>
            <span className="font-mono tabular-nums">({cartCount})</span>
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl min-w-0 flex-1 px-3 py-4 sm:px-6 sm:py-8">
        {activeTab === 'shop' && (
          <div className="min-w-0 space-y-6 sm:space-y-8">
            {/* Gentle post-delivery rating banner on storefront if latest order was delivered & unrated */}
            {pendingRateBannerOrder &&
              pendingRateBannerOrder.status === 'completed' &&
              !pendingRateBannerOrder.rating &&
              dismissedBannerOrderNumber !== pendingRateBannerOrder.orderNumber && (
                <div className="flex flex-col justify-between gap-3 rounded-xl border border-teal-200 bg-teal-50/70 p-4 sm:flex-row sm:items-center">
                  <div className="flex items-start gap-3">
                    <Heart className="mt-0.5 h-5 w-5 shrink-0 text-teal-700" />
                    <div className="text-xs sm:text-sm">
                      <p className="font-bold text-slate-900">
                        حمد لله على سلامة وصول طلبك{' '}
                        <span className="font-mono">{pendingRateBannerOrder.orderNumber}</span> يا{' '}
                        {getFirstNameAr(pendingRateBannerOrder.customerName)}
                      </p>
                      <p className="mt-0.5 text-slate-600">
                        يسعدنا جدًا تقييمك السريع لتجربتك مع {pendingRateBannerOrder.shopName}.
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setActiveTab('track');
                        fetchTrackedOrder(pendingRateBannerOrder.orderNumber);
                      }}
                      className="min-h-[38px] whitespace-nowrap rounded-lg bg-teal-700 px-4 py-1.5 text-xs font-semibold text-white hover:bg-teal-800"
                    >
                      تقييم سريع
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setDismissedBannerOrderNumber(pendingRateBannerOrder.orderNumber)
                      }
                      className="min-h-[38px] whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-800"
                    >
                      لاحقًا
                    </button>
                  </div>
                </div>
              )}

            {/* Hero Split Banner */}
            <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
              <div className="grid items-stretch lg:grid-cols-12">
                <div className="flex min-w-0 flex-col justify-center space-y-3 p-5 sm:space-y-4 sm:p-8 lg:col-span-7">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span>توصيل الحي السريع</span>
                    <span aria-hidden="true">·</span>
                    <span>الدفع نقدي عند الاستلام فقط</span>
                    <span aria-hidden="true">·</span>
                    <span>أسعار تجريبية استرشادية</span>
                  </div>
                  <h1 className="font-display text-xl font-bold leading-snug text-slate-900 sm:text-3xl">
                    مقاضي بيتك من سوبر ماركت منطقتك حتى باب البيت
                  </h1>
                  <p className="max-w-xl text-xs leading-relaxed text-slate-600 sm:text-base">
                    اختر المحل الأقرب إليك، أضف احتياجاتك اليومية للسلة، وحدد موقعك أو اختر من
                    عناوينك المحفوظة وتابع طلبك لحظة بلحظة.
                  </p>
                  {defaultSavedAddr && (
                    <div className="flex min-w-0 items-start gap-2 pt-1 text-xs text-teal-800">
                      <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span className="min-w-0 break-words">
                        التوصيل الافتراضي: <strong>{defaultSavedAddr.label}</strong> —{' '}
                        {defaultSavedAddr.address}
                      </span>
                    </div>
                  )}
                </div>
                <div className="relative h-44 bg-slate-100 sm:h-56 lg:col-span-5 lg:h-auto lg:min-h-[220px]">
                  <img
                    src="/src/assets/images/hero_grocery_storefront_1795335151385.jpg"
                    alt="مستلزمات البقالة الطازجة والأساسية"
                    referrerPolicy="no-referrer"
                    className="h-full w-full object-cover"
                    onError={(e) => {
                      e.currentTarget.style.display = 'none';
                    }}
                  />
                </div>
              </div>
            </section>

            {/* Step 1: Select Shop */}
            <section className="min-w-0 space-y-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="font-display text-base font-bold text-slate-900 sm:text-lg">
                  1. اختر المحل
                </h2>
                <span className="text-xs text-slate-500">
                  تختلف الأسعار وتوافر المخزون بين كل محل بشكل مستقل
                </span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 sm:gap-4">
                {shops.map((shop) => {
                  const isSelected = shop.id === selectedShopId;
                  return (
                    <button
                      key={shop.id}
                      type="button"
                      onClick={() => handleSelectShop(shop.id)}
                      className={`group flex min-w-0 items-stretch overflow-hidden rounded-xl border text-right transition-colors ${
                        isSelected
                          ? 'border-teal-700 bg-teal-50/40 ring-1 ring-teal-700'
                          : 'border-slate-200 bg-white hover:border-slate-300'
                      }`}
                    >
                      <div className="h-28 w-24 shrink-0 bg-slate-100 sm:h-32 sm:w-36">
                        <img
                          src={shop.imageUrl}
                          alt={shop.name}
                          referrerPolicy="no-referrer"
                          className="h-full w-full object-cover"
                          onError={(e) => {
                            e.currentTarget.style.display = 'none';
                          }}
                        />
                      </div>
                      <div className="flex min-w-0 flex-1 flex-col justify-between p-3 sm:p-4">
                        <div className="min-w-0 space-y-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-display truncate text-sm font-bold text-slate-900 sm:text-base">
                              {shop.name}
                            </span>
                            {isSelected && (
                              <span className="shrink-0 text-[11px] font-semibold text-teal-800 sm:text-xs">
                                المحل المختار
                              </span>
                            )}
                          </div>
                          <p className="flex min-w-0 items-start gap-1 text-xs text-slate-600">
                            <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
                            <span className="line-clamp-2 min-w-0 break-words">
                              {shop.area} — {shop.address}
                            </span>
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 pt-2 text-[11px] text-slate-600 tabular-nums sm:text-xs">
                          <span>رسوم التوصيل: {formatEGP(shop.defaultDeliveryFeeEGP)}</span>
                          <span aria-hidden="true">·</span>
                          <span>نقدي عند الاستلام</span>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>

            {/* Step 2: Search & Category Filters */}
            <section className="min-w-0 space-y-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <h2 className="font-display min-w-0 break-words text-base font-bold text-slate-900 sm:text-lg">
                  2. منتجات {activeShop?.name ?? 'المتجر'}
                </h2>
                <div className="relative w-full min-w-0 sm:w-80">
                  <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="ابحث باسم المنتج أو العلامة التجارية..."
                    className="min-h-[44px] w-full rounded-lg border border-slate-200 bg-white py-2 pr-10 pl-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-700 focus:outline-none"
                  />
                </div>
              </div>

              {/* Category Filter Buttons (Contained inside min-w-0 so mobile never overflows) */}
              <div className="flex w-full max-w-full min-w-0 items-center gap-1.5 overflow-x-auto pb-1">
                {Array.from(
                  new Set(['الكل', ...PRODUCT_CATEGORIES, ...catalog.map((c) => c.category)]),
                ).map((cat) => {
                  const active = selectedCategory === cat;
                  return (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setSelectedCategory(cat)}
                      className={`min-h-[42px] shrink-0 whitespace-nowrap rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                        active
                          ? 'border-teal-700 bg-teal-700 text-white'
                          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      {cat}
                    </button>
                  );
                })}
              </div>

              {error && (
                <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
                  {error}
                </div>
              )}

              {loading ? (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {Array.from({ length: 6 }).map((_, idx) => (
                    <div
                      key={idx}
                      className="h-44 animate-pulse rounded-xl border border-slate-200 bg-white p-4"
                    />
                  ))}
                </div>
              ) : filteredCatalog.length === 0 ? (
                <div className="rounded-xl border border-slate-200 bg-white p-10 text-center">
                  <p className="text-sm font-medium text-slate-700">
                    لا توجد منتجات مطابقة لبحثك في هذا التصنيف.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedCategory('الكل');
                      setSearchQuery('');
                    }}
                    className="mt-3 rounded-lg border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    عرض كل المنتجات
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
                  {filteredCatalog.map((item) => {
                    const qtyInCart = getCartQty(item.productId);
                    const { Icon, bg } = getCategoryVisual(item.category);
                    return (
                      <article
                        key={item.listingId}
                        className="flex min-w-0 flex-col justify-between rounded-xl border border-slate-200 bg-white p-4 transition-colors hover:border-slate-300"
                      >
                        <div className="space-y-3">
                          <div className="flex items-start gap-3">
                            <div
                              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg ${bg}`}
                            >
                              <Icon className="h-5 w-5" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-xs text-slate-500">
                                {item.brand} · {item.packSize} · {item.unit}
                              </p>
                              <h3 className="mt-0.5 text-sm font-bold leading-snug text-slate-900">
                                {item.name}
                              </h3>
                            </div>
                          </div>
                          <p className="text-xs leading-relaxed text-slate-600">
                            {item.description}
                          </p>
                        </div>

                        <div className="mt-4 flex flex-wrap items-center justify-between gap-2.5 border-t border-slate-100 pt-3">
                          <div className="min-w-0">
                            <div className="font-mono text-base font-bold text-slate-900 tabular-nums">
                              {formatEGP(item.priceEGP)}
                            </div>
                            <div className="text-[11px] text-slate-500 tabular-nums">
                              {item.isAvailable && item.availableQuantity > 0
                                ? `متاح (${item.availableQuantity} ${item.unit})`
                                : 'غير متوفر حاليًا'}
                            </div>
                          </div>

                          {!item.isAvailable || item.availableQuantity <= 0 ? (
                            <span className="shrink-0 text-xs font-medium text-rose-700">
                              نفد المخزون
                            </span>
                          ) : qtyInCart === 0 ? (
                            <button
                              type="button"
                              onClick={() => updateCartQty(item, 1)}
                              className="flex min-h-[44px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white transition-colors hover:bg-teal-700"
                            >
                              <Plus className="h-3.5 w-3.5" />
                              <span>أضف للسلة</span>
                            </button>
                          ) : (
                            <div className="flex shrink-0 items-center gap-1 rounded-lg border border-teal-700 bg-teal-50 p-1">
                              <button
                                type="button"
                                aria-label="زيادة الكمية"
                                onClick={() => updateCartQty(item, qtyInCart + 1)}
                                disabled={qtyInCart >= item.availableQuantity}
                                className="flex h-9 w-9 items-center justify-center rounded-md bg-white text-teal-800 hover:bg-teal-100 disabled:opacity-40"
                              >
                                <Plus className="h-3.5 w-3.5" />
                              </button>
                              <span className="min-w-[24px] text-center font-mono text-sm font-bold text-teal-900 tabular-nums">
                                {qtyInCart}
                              </span>
                              <button
                                type="button"
                                aria-label="تقليل الكمية"
                                onClick={() => updateCartQty(item, qtyInCart - 1)}
                                className="flex h-9 w-9 items-center justify-center rounded-md bg-white text-teal-800 hover:bg-teal-100"
                              >
                                <Minus className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        )}

        {activeTab === 'track' && (
          /* Order Tracking View */
          <section className="mx-auto max-w-3xl space-y-5">
            <div className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
              <h1 className="font-display text-xl font-bold text-slate-900">متابعة حالة الطلب</h1>
              <p className="mt-1 text-sm text-slate-600">
                أدخل رقم الطلب الفريد لمتابعة التجهيز والتوصيل أو الرد على تعديلات المحل.
              </p>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  fetchTrackedOrder(lookupInput);
                }}
                className="mt-4 flex flex-col gap-2 sm:flex-row"
              >
                <input
                  type="text"
                  value={lookupInput}
                  onChange={(e) => setLookupInput(e.target.value)}
                  placeholder="مثال: ORD-1001"
                  dir="ltr"
                  className="min-h-[44px] flex-1 rounded-lg border border-slate-200 px-3 py-2 text-right font-mono text-sm focus:border-teal-700 focus:outline-none"
                />
                <button
                  type="submit"
                  className="min-h-[44px] shrink-0 whitespace-nowrap rounded-lg bg-teal-700 px-5 py-2 text-sm font-semibold text-white hover:bg-teal-800"
                >
                  بحث عن الطلب
                </button>
              </form>

              {trackedNumbers.length > 0 && (
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <span className="text-xs text-slate-500">طلباتك الأخيرة:</span>
                  {trackedNumbers.map((num) => (
                    <button
                      key={num}
                      type="button"
                      onClick={() => fetchTrackedOrder(num)}
                      className={`rounded-md border px-2.5 py-1 font-mono text-xs transition-colors ${
                        trackedOrder?.orderNumber === num
                          ? 'border-teal-700 bg-teal-50 font-semibold text-teal-800'
                          : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      {num}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {trackingError && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
                {trackingError}
              </div>
            )}

            {trackingLoading && (
              <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
                جاري تحديث بيانات الطلب...
              </div>
            )}

            {trackedOrder && !trackingLoading && (
              <div className="space-y-5">
                {/* Gentle Post-Delivery Rating Card */}
                {trackedOrder.status === 'completed' &&
                  trackedOrder.deliveryStatus === 'delivered' && (
                    <>
                      {trackedOrder.rating ? (
                        <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 p-5 sm:p-6">
                          <div className="flex items-start gap-3">
                            <Heart className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700" />
                            <div className="flex-1 space-y-2">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <h2 className="font-display text-base font-bold text-emerald-950">
                                  شكرًا لذوقك يا {getFirstNameAr(trackedOrder.customerName)} — وصل
                                  تقييمك بنجاح
                                </h2>
                                <div className="flex items-center gap-1" aria-label="التقييم المرسل">
                                  {[1, 2, 3, 4, 5].map((star) => (
                                    <Star
                                      key={star}
                                      className={`h-4 w-4 ${
                                        star <= trackedOrder.rating!.overallRating
                                          ? 'fill-amber-400 text-amber-500'
                                          : 'text-slate-300'
                                      }`}
                                    />
                                  ))}
                                  <span className="mr-1 font-mono text-xs font-bold text-emerald-900 tabular-nums">
                                    {trackedOrder.rating.overallRating}/5
                                  </span>
                                </div>
                              </div>
                              {(trackedOrder.rating.shopRating ||
                                trackedOrder.rating.deliveryRating) && (
                                <p className="text-xs text-emerald-900">
                                  {trackedOrder.rating.shopRating
                                    ? `${trackedOrder.shopName}: ${trackedOrder.rating.shopRating}/5 ★`
                                    : ''}
                                  {trackedOrder.rating.shopRating &&
                                  trackedOrder.rating.deliveryRating
                                    ? ' · '
                                    : ''}
                                  {trackedOrder.rating.deliveryRating
                                    ? `التوصيل (${trackedOrder.volunteerName ?? 'المندوب'}): ${trackedOrder.rating.deliveryRating}/5 ★`
                                    : ''}
                                </p>
                              )}
                              {trackedOrder.rating.complimentTags.length > 0 && (
                                <p className="text-xs text-emerald-800">
                                  نقاط الإعجاب: {trackedOrder.rating.complimentTags.join(' · ')}
                                </p>
                              )}
                              {trackedOrder.rating.comment && (
                                <p className="rounded-lg bg-white/80 p-3 text-xs text-slate-700">
                                  "{trackedOrder.rating.comment}"
                                </p>
                              )}
                            </div>
                          </div>
                        </div>
                      ) : ratingTuckedOrders.includes(trackedOrder.orderNumber) ? (
                        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs">
                          <span className="text-slate-600">
                            رأيك يهمنا دائمًا — يمكنك تقييم هذا الطلب في أي وقت.
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              setRatingTuckedOrders((prev) =>
                                prev.filter((n) => n !== trackedOrder.orderNumber),
                              )
                            }
                            className="font-semibold text-teal-800 hover:underline"
                          >
                            فتح التقييم اللطيف
                          </button>
                        </div>
                      ) : (
                        <form
                          onSubmit={handleSubmitOrderRating}
                          className="rounded-xl border border-teal-200 bg-white p-5 space-y-5 sm:p-6"
                        >
                          <div className="flex items-start gap-3">
                            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-700">
                              <Heart className="h-5 w-5" />
                            </div>
                            <div className="space-y-1">
                              <h2 className="font-display text-base font-bold text-slate-900 sm:text-lg">
                                حمد لله على سلامة وصول طلبك يا{' '}
                                {getFirstNameAr(trackedOrder.customerName)}
                              </h2>
                              <p className="text-xs leading-relaxed text-slate-600 sm:text-sm">
                                نتمنى تكون طلباتك وصلت طازة ومظبوطة من {trackedOrder.shopName}
                                {trackedOrder.volunteerName
                                  ? ` بمساعدة ${trackedOrder.volunteerName}`
                                  : ''}
                                . تقييمك في ثواني بيفرحنا ويساعدنا نقدم خدمة أحسن كل مرة.
                              </p>
                            </div>
                          </div>

                          {/* 1-Tap Overall Stars */}
                          <div className="space-y-2 rounded-lg bg-slate-50 p-4 text-center">
                            <p className="text-xs font-semibold text-slate-700">
                              كيف كانت تجربتك اليوم بشكل عام؟
                            </p>
                            <div
                              className="flex items-center justify-center gap-2 pt-1"
                              role="radiogroup"
                              aria-label="التقييم العام للطلب"
                            >
                              {[1, 2, 3, 4, 5].map((star) => {
                                const active = star <= ratingOverall;
                                return (
                                  <button
                                    key={star}
                                    type="button"
                                    onClick={() => {
                                      setRatingOverall(star);
                                      setRatingError(null);
                                    }}
                                    aria-label={`${star} من 5 نجوم`}
                                    className="flex h-11 w-11 items-center justify-center rounded-lg transition-transform hover:scale-105 focus-visible:outline-2 focus-visible:outline-teal-700"
                                  >
                                    <Star
                                      className={`h-7 w-7 transition-colors ${
                                        active
                                          ? 'fill-amber-400 text-amber-500'
                                          : 'text-slate-300 hover:text-amber-400'
                                      }`}
                                    />
                                  </button>
                                );
                              })}
                            </div>
                            <p className="min-h-[20px] text-xs font-medium text-teal-800">
                              {ratingOverall > 0
                                ? RATING_MOOD_LABELS[ratingOverall]
                                : 'اضغطي على النجوم لاختيار تقييمك'}
                            </p>
                          </div>

                          {/* Progressive Disclosure once overall star chosen */}
                          {ratingOverall > 0 && (
                            <div className="space-y-4 border-t border-slate-100 pt-4">
                              <div className="grid gap-3 sm:grid-cols-2">
                                <div className="rounded-lg border border-slate-200 p-3">
                                  <p className="text-xs font-medium text-slate-700">
                                    جودة وتجهيز {trackedOrder.shopName} (اختياري)
                                  </p>
                                  <div className="mt-2 flex items-center gap-1">
                                    {[1, 2, 3, 4, 5].map((s) => (
                                      <button
                                        key={s}
                                        type="button"
                                        onClick={() => setRatingShop(s)}
                                        aria-label={`تقييم المحل ${s} من 5`}
                                        className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-slate-50"
                                      >
                                        <Star
                                          className={`h-5 w-5 ${
                                            s <= ratingShop
                                              ? 'fill-amber-400 text-amber-500'
                                              : 'text-slate-300'
                                          }`}
                                        />
                                      </button>
                                    ))}
                                  </div>
                                </div>
                                <div className="rounded-lg border border-slate-200 p-3">
                                  <p className="text-xs font-medium text-slate-700">
                                    لطف وسرعة {trackedOrder.volunteerName ?? 'المتطوع'} (اختياري)
                                  </p>
                                  <div className="mt-2 flex items-center gap-1">
                                    {[1, 2, 3, 4, 5].map((s) => (
                                      <button
                                        key={s}
                                        type="button"
                                        onClick={() => setRatingDelivery(s)}
                                        aria-label={`تقييم المتطوع ${s} من 5`}
                                        className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-slate-50"
                                      >
                                        <Star
                                          className={`h-5 w-5 ${
                                            s <= ratingDelivery
                                              ? 'fill-amber-400 text-amber-500'
                                              : 'text-slate-300'
                                          }`}
                                        />
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              </div>

                              <div>
                                <p className="mb-2 text-xs font-medium text-slate-700">
                                  إيه أكتر حاجة عجبتك؟ (اختاري اللي تحبيه)
                                </p>
                                <div className="flex flex-wrap gap-2">
                                  {COMPLIMENT_OPTIONS.map((tag) => {
                                    const selected = ratingTags.includes(tag);
                                    return (
                                      <button
                                        key={tag}
                                        type="button"
                                        onClick={() => handleToggleCompliment(tag)}
                                        className={`min-h-[38px] rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                                          selected
                                            ? 'border-teal-700 bg-teal-700 text-white'
                                            : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                                        }`}
                                      >
                                        {tag}
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>

                              <div>
                                <label className="mb-1 block text-xs font-medium text-slate-700">
                                  كلمة لطيفة للمحل أو المندوب (اختياري)
                                </label>
                                <textarea
                                  rows={2}
                                  maxLength={400}
                                  value={ratingComment}
                                  onChange={(e) => setRatingComment(e.target.value)}
                                  placeholder="مثال: الطلب وصل كامل والطعم ممتاز، ربنا يبارك لكم..."
                                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-900 focus:border-teal-700 focus:outline-none sm:text-sm"
                                />
                              </div>
                            </div>
                          )}

                          {ratingError && (
                            <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
                              {ratingError}
                            </div>
                          )}

                          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                            <button
                              type="submit"
                              disabled={ratingSubmitting || ratingOverall < 1}
                              className="min-h-[42px] rounded-lg bg-teal-700 px-5 py-2 text-xs font-semibold text-white transition-colors hover:bg-teal-800 disabled:opacity-40 sm:text-sm"
                            >
                              {ratingSubmitting ? 'جاري إرسال تقييمك...' : 'إرسال تقييمك اللطيف'}
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                setRatingTuckedOrders((prev) => [...prev, trackedOrder.orderNumber])
                              }
                              className="min-h-[38px] px-2 text-xs font-medium text-slate-500 hover:text-slate-800"
                            >
                              ربما لاحقًا
                            </button>
                          </div>
                        </form>
                      )}
                    </>
                  )}

                {trackedOrder.pendingModification && (
                  <div className="rounded-xl border border-amber-300 bg-amber-50 p-5">
                    <div className="flex items-start gap-3">
                      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
                      <div className="flex-1 space-y-2">
                        <h2 className="font-display text-base font-bold text-amber-950">
                          طلب موافقة على تعديل من {trackedOrder.shopName}
                        </h2>
                        <p className="text-sm text-amber-900">
                          المنتج الأصلي:{' '}
                          <span className="font-semibold">
                            {trackedOrder.pendingModification.targetProductName}
                          </span>
                        </p>
                        {trackedOrder.pendingModification.proposedProductName && (
                          <p className="text-sm text-amber-900">
                            البديل المقترح:{' '}
                            <span className="font-semibold">
                              {trackedOrder.pendingModification.proposedProductName} (
                              {trackedOrder.pendingModification.proposedPackSize}) — بسعر{' '}
                              {formatEGP(trackedOrder.pendingModification.proposedUnitPriceEGP ?? 0)}
                            </span>
                          </p>
                        )}
                        {trackedOrder.pendingModification.type === 'adjust_quantity' && (
                          <p className="text-sm text-amber-900">
                            الكمية المقترحة:{' '}
                            <span className="font-mono font-bold">
                              {trackedOrder.pendingModification.proposedQuantity}
                            </span>
                          </p>
                        )}
                        {trackedOrder.pendingModification.type === 'price_adjustment' && (
                          <p className="text-sm text-amber-900">
                            السعر الجديد المقترح للوحدة:{' '}
                            <span className="font-mono font-bold">
                              {formatEGP(trackedOrder.pendingModification.proposedUnitPriceEGP ?? 0)}
                            </span>
                          </p>
                        )}
                        <p className="text-xs text-amber-800">
                          السبب: {trackedOrder.pendingModification.reason}
                        </p>
                        <div className="flex flex-wrap gap-2 pt-2">
                          <button
                            type="button"
                            onClick={() => handleCustomerModResponse('approved')}
                            className="min-h-[40px] rounded-lg bg-teal-700 px-4 py-2 text-xs font-semibold text-white hover:bg-teal-800"
                          >
                            موافقة على التعديل
                          </button>
                          <button
                            type="button"
                            onClick={() => handleCustomerModResponse('rejected')}
                            className="min-h-[40px] rounded-lg border border-rose-300 bg-white px-4 py-2 text-xs font-semibold text-rose-800 hover:bg-rose-50"
                          >
                            رفض البديل/التعديل
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                <div className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
                  <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 pb-4">
                    <div>
                      <div className="flex items-center gap-2 text-xs text-slate-500">
                        <span>{trackedOrder.shopName}</span>
                        <span aria-hidden="true">·</span>
                        <span>{formatDateTimeAr(trackedOrder.createdAt)}</span>
                      </div>
                      <h2 className="mt-1 font-mono text-xl font-bold text-slate-900 tabular-nums">
                        {trackedOrder.orderNumber}
                      </h2>
                    </div>

                    <div className="flex w-full flex-row flex-wrap items-center justify-between gap-1.5 sm:w-auto sm:flex-col sm:items-end">
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => fetchTrackedOrder(trackedOrder.orderNumber)}
                          className="flex min-h-[36px] items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
                        >
                          <RefreshCw className="h-3 w-3" />
                          <span>تحديث الحالة</span>
                        </button>
                        <span
                          className={`rounded-md border px-3 py-1 text-xs font-semibold ${
                            ORDER_STATUS_META[trackedOrder.status].surfaceClass
                          } ${ORDER_STATUS_META[trackedOrder.status].textClass}`}
                        >
                          {ORDER_STATUS_META[trackedOrder.status].label}
                        </span>
                      </div>
                      <span
                        className={`text-xs font-medium ${
                          DELIVERY_STATUS_META[trackedOrder.deliveryStatus].textClass
                        }`}
                      >
                        التوصيل: {DELIVERY_STATUS_META[trackedOrder.deliveryStatus].label}
                      </span>
                    </div>
                  </div>

                  <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                    <div className="min-w-0 space-y-1">
                      <p className="text-xs text-slate-500">بيانات العميل</p>
                      <p className="font-semibold text-slate-900 break-words">
                        {trackedOrder.customerName}
                      </p>
                      <p className="font-mono text-xs text-slate-600">
                        {trackedOrder.customerPhone}
                      </p>
                    </div>
                    <div className="min-w-0 space-y-1">
                      <p className="text-xs text-slate-500">عنوان التوصيل</p>
                      <p className="text-slate-800 break-words">{trackedOrder.deliveryAddress}</p>
                      {trackedOrder.deliveryLocation && (
                        <p className="font-mono text-[11px] text-teal-700 break-all">
                          GPS: {trackedOrder.deliveryLocation.lat},{' '}
                          {trackedOrder.deliveryLocation.lng}
                        </p>
                      )}
                      {trackedOrder.volunteerName && (
                        <p className="flex items-center gap-1.5 text-xs font-medium text-teal-800">
                          <Truck className="h-3.5 w-3.5 shrink-0" />
                          <span>المتطوع المسؤول: {trackedOrder.volunteerName}</span>
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="mt-5 border-t border-slate-100 pt-4">
                    <h3 className="text-xs font-semibold text-slate-500">تفاصيل الأصناف</h3>
                    <div className="mt-2 divide-y divide-slate-100">
                      {trackedOrder.items.map((item) => (
                        <div
                          key={item.id}
                          className={`flex items-start justify-between gap-3 py-2.5 text-sm ${
                            item.status === 'unavailable_removed'
                              ? 'text-slate-400 line-through'
                              : 'text-slate-800'
                          }`}
                        >
                          <div className="min-w-0 flex-1">
                            <span className="font-medium break-words">{item.productName}</span>
                            <span className="mr-2 text-xs text-slate-500">
                              ({item.packSize}) × {item.quantity}
                            </span>
                            {item.status === 'substituted' && item.originalProductName && (
                              <p className="text-xs text-teal-700">
                                بديل عن: {item.originalProductName}
                              </p>
                            )}
                          </div>
                          <span className="shrink-0 font-mono font-semibold tabular-nums">
                            {formatEGP(item.lineTotalEGP)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="mt-4 space-y-1.5 rounded-lg bg-slate-50 p-4 text-sm">
                    <div className="flex justify-between text-slate-600">
                      <span>قيمة المنتجات</span>
                      <span className="font-mono tabular-nums">
                        {formatEGP(trackedOrder.financials.itemsTotalEGP)}
                      </span>
                    </div>
                    <div className="flex justify-between text-slate-600">
                      <span>رسوم التوصيل</span>
                      <span className="font-mono tabular-nums">
                        {formatEGP(trackedOrder.financials.deliveryFeeEGP)}
                      </span>
                    </div>
                    <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-bold text-slate-900">
                      <span>الإجمالي (نقدي عند الاستلام)</span>
                      <span className="font-mono tabular-nums">
                        {formatEGP(trackedOrder.financials.customerExpectedTotalEGP)}
                      </span>
                    </div>
                  </div>

                  {trackedOrder.status !== 'completed' &&
                    trackedOrder.status !== 'cancelled' &&
                    trackedOrder.deliveryStatus !== 'picked_up' &&
                    trackedOrder.deliveryStatus !== 'heading_to_customer' && (
                      <div className="mt-4 border-t border-slate-100 pt-4">
                        {!showCancelForm ? (
                          <button
                            type="button"
                            onClick={() => setShowCancelForm(true)}
                            className="text-xs font-semibold text-rose-700 hover:underline"
                          >
                            إلغاء الطلب قبل التوصيل
                          </button>
                        ) : (
                          <div className="space-y-2 rounded-lg border border-rose-200 bg-rose-50/50 p-3">
                            <input
                              type="text"
                              value={cancelReason}
                              onChange={(e) => setCancelReason(e.target.value)}
                              placeholder="سبب الإلغاء (اختياري)"
                              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs"
                            />
                            <div className="flex gap-2">
                              <button
                                type="button"
                                onClick={handleCustomerCancel}
                                className="rounded-lg bg-rose-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-800"
                              >
                                تأكيد الإلغاء
                              </button>
                              <button
                                type="button"
                                onClick={() => setShowCancelForm(false)}
                                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700"
                              >
                                تراجع
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                </div>

                <div className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
                  <h3 className="font-display text-base font-bold text-slate-900">
                    السجل الزمني للطلب
                  </h3>
                  <ol className="mt-4 space-y-4">
                    {trackedOrder.timeline.map((ev) => (
                      <li key={ev.id} className="flex items-start gap-3">
                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-teal-700" />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-sm font-semibold text-slate-900">{ev.title}</span>
                            <span className="flex items-center gap-1 text-xs text-slate-500">
                              <Clock className="h-3 w-3 shrink-0" />
                              {formatDateTimeAr(ev.timestamp)}
                            </span>
                          </div>
                          {ev.details && (
                            <p className="mt-0.5 text-xs text-slate-600 break-words">{ev.details}</p>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                </div>
              </div>
            )}
          </section>
        )}

        {activeTab === 'settings' && (
          /* Saved Customer Settings & Addresses Tab */
          <section className="mx-auto max-w-3xl space-y-6">
            <div className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
              <div className="flex items-center gap-2">
                <Settings className="h-5 w-5 text-teal-700" />
                <h1 className="font-display text-xl font-bold text-slate-900">
                  إعداداتي وعناوين التوصيل
                </h1>
              </div>
              <p className="mt-1 text-sm text-slate-600">
                احفظ اسمك ورقم هاتفك وعناوينك (أو حدد موقعك بـ GPS) لتعبئة بياناتك تلقائيًا عند كل
                طلب.
              </p>

              {settingsMsg && (
                <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs font-medium text-emerald-800">
                  {settingsMsg}
                </div>
              )}
              {settingsError && (
                <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs font-medium text-rose-800">
                  {settingsError}
                </div>
              )}

              <form
                onSubmit={handleSaveProfileOnly}
                className="mt-5 grid gap-3 border-b border-slate-100 pb-6 sm:grid-cols-3"
              >
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-700">
                    الاسم الافتراضي
                  </label>
                  <input
                    type="text"
                    value={settingsName}
                    onChange={(e) => setSettingsName(e.target.value)}
                    placeholder="الاسم بالكامل"
                    className="min-h-[42px] w-full rounded-lg border border-slate-200 px-3 text-sm focus:border-teal-700 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-700">
                    رقم الهاتف الافتراضي
                  </label>
                  <input
                    type="tel"
                    dir="ltr"
                    value={settingsPhone}
                    onChange={(e) => setSettingsPhone(e.target.value)}
                    placeholder="010xxxxxxxx"
                    className="min-h-[42px] w-full rounded-lg border border-slate-200 px-3 text-right font-mono text-sm focus:border-teal-700 focus:outline-none"
                  />
                </div>
                <div className="flex items-end">
                  <button
                    type="submit"
                    className="min-h-[42px] w-full rounded-lg bg-slate-900 px-4 text-xs font-semibold text-white hover:bg-teal-700"
                  >
                    حفظ الاسم والهاتف
                  </button>
                </div>
              </form>

              {/* Add Address Form with GPS */}
              <form onSubmit={handleAddSavedAddress} className="mt-5 space-y-3">
                <h2 className="font-display text-sm font-bold text-slate-900">
                  إضافة عنوان جديد لإعداداتي
                </h2>
                <div className="grid gap-3 sm:grid-cols-3">
                  <input
                    type="text"
                    value={addrLabelInput}
                    onChange={(e) => setAddrLabelInput(e.target.value)}
                    placeholder="اسم العنوان (مثال: المنزل، العمل)"
                    className="min-h-[42px] rounded-lg border border-slate-200 px-3 text-sm focus:border-teal-700 focus:outline-none"
                  />
                  <div className="min-w-0 sm:col-span-2">
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <input
                        type="text"
                        value={addrTextInput}
                        onChange={(e) => setAddrTextInput(e.target.value)}
                        placeholder="العنوان بالتفصيل أو اضغط تحديد الموقع"
                        className="min-h-[44px] w-full min-w-0 flex-1 rounded-lg border border-slate-200 px-3 text-sm focus:border-teal-700 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={handleSettingsUseGps}
                        disabled={locatingGps}
                        className="flex min-h-[44px] shrink-0 items-center justify-center gap-1.5 rounded-lg border border-teal-700 bg-teal-50 px-3 text-xs font-semibold text-teal-800 hover:bg-teal-100 disabled:opacity-50"
                      >
                        <LocateFixed className="h-4 w-4" />
                        <span>{locatingGps ? 'جاري التحديد...' : 'موقعي GPS'}</span>
                      </button>
                    </div>
                  </div>
                </div>
                {addrGpsInput && (
                  <p className="font-mono text-xs text-teal-700 break-all">
                    إحداثيات GPS الملتقطة: {addrGpsInput.lat}, {addrGpsInput.lng}
                  </p>
                )}
                <button
                  type="submit"
                  className="min-h-[44px] w-full rounded-lg bg-teal-700 px-5 text-xs font-semibold text-white hover:bg-teal-800 sm:w-auto"
                >
                  حفظ العنوان في إعداداتي
                </button>
              </form>
            </div>

            {/* Saved Addresses List */}
            <div className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
              <h2 className="font-display text-base font-bold text-slate-900">
                العناوين المحفوظة ({savedSettings.addresses.length})
              </h2>
              {savedSettings.addresses.length === 0 ? (
                <p className="mt-3 text-xs text-slate-500">
                  لا توجد عناوين محفوظة بعد. يمكنك إضافة عنوان أعلاه أو حفظه مباشرة أثناء إتمام أي
                  طلب.
                </p>
              ) : (
                <div className="mt-4 space-y-3">
                  {savedSettings.addresses.map((addr) => {
                    const isDefault = savedSettings.defaultAddressId === addr.id;
                    return (
                      <div
                        key={addr.id}
                        className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3.5 ${
                          isDefault ? 'border-teal-600 bg-teal-50/40' : 'border-slate-200'
                        }`}
                      >
                        <div className="min-w-0 flex-1 space-y-0.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-bold text-slate-900">{addr.label}</span>
                            {isDefault && (
                              <span className="text-xs font-semibold text-teal-800">
                                (الافتراضي)
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-slate-700 break-words">{addr.address}</p>
                          {addr.lat !== undefined && addr.lng !== undefined && (
                            <p className="font-mono text-[11px] text-slate-500 break-all">
                              GPS: {addr.lat}, {addr.lng}
                            </p>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {!isDefault && (
                            <button
                              type="button"
                              onClick={() => handleSetDefaultAddress(addr)}
                              className="min-h-[40px] rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                            >
                              تعيين كافتراضي
                            </button>
                          )}
                          <button
                            type="button"
                            aria-label="حذف العنوان"
                            onClick={() => handleDeleteSavedAddress(addr.id)}
                            className="flex h-10 w-10 items-center justify-center rounded-lg text-rose-600 hover:bg-rose-50"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        )}
      </main>

      {/* Bottom Role Switcher Footer for Quick Testing */}
      {!embeddedInOps && onSwitchRole && (
        <footer className="mt-8 border-t border-slate-200 bg-white">
          <div className="mx-auto max-w-6xl px-3 py-5 sm:px-6">
            <p className="mb-3 text-xs font-semibold text-slate-600">
              تبديل سريع بين الواجهات والأدوار (للتجربة الآن):
            </p>
            <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
              {ROLE_SWITCH_BUTTONS.map(({ id, label, Icon }) => {
                const isCustomer = id === 'customer';
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => {
                      if (isCustomer) {
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                      } else {
                        onSwitchRole(id);
                      }
                    }}
                    className={`flex min-h-[44px] min-w-0 items-center gap-1.5 rounded-lg border px-3 py-2 text-right text-xs font-semibold transition-colors ${
                      isCustomer
                        ? 'border-teal-700 bg-teal-700 text-white'
                        : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </footer>
      )}

      {/* Mobile Sticky Bottom Cart Bar when items > 0 and drawer closed */}
      {cartCount > 0 && !cartOpen && activeTab === 'shop' && (
        <div className="sticky bottom-0 z-20 border-t border-slate-200 bg-white/95 px-3 py-2 backdrop-blur-md pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:hidden">
          <button
            type="button"
            onClick={() => setCartOpen(true)}
            className="flex min-h-[44px] w-full items-center justify-between gap-2 rounded-lg bg-teal-700 px-4 py-2 text-sm font-semibold text-white active:scale-[0.99]"
          >
            <span className="truncate">عرض السلة وإتمام الطلب ({cartCount})</span>
            <span className="shrink-0 font-mono tabular-nums">{formatEGP(orderGrandTotal)}</span>
          </button>
        </div>
      )}

      {/* Full-Viewport Responsive Slide-Over Cart & COD Checkout Drawer */}
      {cartOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="سلة المشتريات"
          onClick={() => setCartOpen(false)}
          className="fixed inset-0 z-50 flex items-stretch justify-end bg-slate-900/50 backdrop-blur-[2px]"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="flex h-[100dvh] max-h-[100dvh] min-h-0 w-full max-w-full flex-col overflow-hidden bg-white shadow-2xl sm:max-w-md sm:border-r sm:border-slate-200"
          >
            {/* Compact Sticky Drawer Header */}
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 px-3.5 py-2.5 sm:px-5 sm:py-3.5">
              <div className="min-w-0 flex-1">
                <h2 className="font-display truncate text-base font-bold text-slate-900 sm:text-lg">
                  سلة المشتريات
                  {cartCount > 0 && (
                    <span className="mr-1.5 font-mono text-xs font-semibold text-teal-800 tabular-nums">
                      ({cartCount})
                    </span>
                  )}
                </h2>
                <p className="truncate text-xs text-slate-500">{activeShop?.name}</p>
              </div>
              <button
                type="button"
                aria-label="إغلاق السلة"
                onClick={() => setCartOpen(false)}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Scrollable Cart Items + Checkout Form Body */}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3.5 py-4 sm:p-5">
              {cart.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <Store className="h-10 w-10 text-slate-300" />
                  <p className="mt-3 text-sm font-medium text-slate-600">سلة المشتريات فارغة</p>
                  <p className="mt-1 text-xs text-slate-500">
                    أضف منتجات من {activeShop?.name} للبدء
                  </p>
                  <button
                    type="button"
                    onClick={() => setCartOpen(false)}
                    className="mt-5 min-h-[44px] rounded-lg bg-teal-700 px-5 py-2 text-xs font-semibold text-white hover:bg-teal-800"
                  >
                    تصفح المنتجات
                  </button>
                </div>
              ) : (
                <div className="min-w-0 space-y-5 pb-2">
                  {/* Cart Items */}
                  <div className="divide-y divide-slate-100">
                    {cart.map(({ product, quantity }) => (
                      <div
                        key={product.productId}
                        className="flex flex-col gap-2.5 py-3 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="break-words text-sm font-semibold leading-snug text-slate-900">
                            {product.name}
                          </p>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500">
                            <span>{product.packSize}</span>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono tabular-nums">
                              {formatEGP(product.priceEGP)}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono font-semibold text-slate-700 tabular-nums">
                              {formatEGP(product.priceEGP * quantity)}
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center justify-between gap-2 sm:shrink-0 sm:justify-end">
                          <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 p-0.5">
                            <button
                              type="button"
                              aria-label="زيادة الكمية"
                              onClick={() => updateCartQty(product, quantity + 1)}
                              disabled={quantity >= product.availableQuantity}
                              className="flex h-10 w-10 items-center justify-center rounded-md bg-white text-slate-700 hover:bg-slate-100 disabled:opacity-40 sm:h-9 sm:w-9"
                            >
                              <Plus className="h-3.5 w-3.5" />
                            </button>
                            <span className="min-w-[26px] text-center font-mono text-sm font-semibold tabular-nums">
                              {quantity}
                            </span>
                            <button
                              type="button"
                              aria-label="تقليل الكمية"
                              onClick={() => updateCartQty(product, quantity - 1)}
                              className="flex h-10 w-10 items-center justify-center rounded-md bg-white text-slate-700 hover:bg-slate-100 sm:h-9 sm:w-9"
                            >
                              <Minus className="h-3.5 w-3.5" />
                            </button>
                          </div>
                          <button
                            type="button"
                            aria-label="حذف المنتج"
                            onClick={() => updateCartQty(product, 0)}
                            className="flex h-10 w-10 items-center justify-center rounded-lg border border-rose-100 bg-rose-50/60 text-rose-600 hover:bg-rose-50 sm:h-9 sm:w-9"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Saved Addresses Quick Pick */}
                  {savedSettings.addresses.length > 0 && (
                    <div className="min-w-0 rounded-lg border border-teal-200 bg-teal-50/50 p-3">
                      <p className="text-xs font-semibold text-teal-900">
                        عناوينك المحفوظة في إعداداتك:
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {savedSettings.addresses.map((addr) => (
                          <button
                            key={addr.id}
                            type="button"
                            onClick={() => applySavedAddress(addr)}
                            className={`min-h-[38px] max-w-full break-words rounded-md border px-2.5 py-1 text-right text-xs font-medium ${
                              deliveryAddress === addr.address
                                ? 'border-teal-700 bg-teal-700 text-white'
                                : 'border-teal-200 bg-white text-teal-900 hover:bg-teal-50'
                            }`}
                          >
                            {addr.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Quick-fill demo customer profiles */}
                  {demoCustomers.length > 0 && (
                    <div className="min-w-0 rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <p className="text-xs font-semibold text-slate-700">
                        أو تعبئة سريعة بعميل تجريبي:
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {demoCustomers.slice(0, 6).map((cust) => (
                          <button
                            key={cust.id}
                            type="button"
                            onClick={() => applyDemoCustomer(cust)}
                            className="min-h-[38px] rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-700 hover:border-teal-600 hover:text-teal-800"
                          >
                            {cust.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Checkout Form */}
                  <form id="cod-checkout-form" onSubmit={handlePlaceOrder} className="min-w-0 space-y-3">
                    <h3 className="font-display text-sm font-bold text-slate-900">
                      بيانات التوصيل والدفع
                    </h3>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-700">
                        الاسم بالكامل
                      </label>
                      <input
                        type="text"
                        required
                        value={customerName}
                        onChange={(e) => setCustomerName(e.target.value)}
                        placeholder="مثال: سارة عبد الرحمن"
                        className="min-h-[44px] w-full min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-teal-700 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-700">
                        رقم الهاتف
                      </label>
                      <div className="relative">
                        <Phone className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                        <input
                          type="tel"
                          required
                          dir="ltr"
                          value={customerPhone}
                          onChange={(e) => setCustomerPhone(e.target.value)}
                          placeholder="010xxxxxxxx"
                          className="min-h-[44px] w-full min-w-0 rounded-lg border border-slate-200 py-2 pr-10 pl-3 text-right font-mono text-sm focus:border-teal-700 focus:outline-none"
                        />
                      </div>
                    </div>
                    <div>
                      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                        <label className="text-xs font-medium text-slate-700">
                          العنوان بالتفصيل
                        </label>
                        <button
                          type="button"
                          onClick={handleCheckoutUseGps}
                          disabled={locatingGps}
                          className="flex min-h-[36px] items-center gap-1 rounded-md border border-teal-700 bg-teal-50 px-2.5 py-1 text-[11px] font-semibold text-teal-800 hover:bg-teal-100 disabled:opacity-50"
                        >
                          <LocateFixed className="h-3.5 w-3.5 shrink-0" />
                          <span>{locatingGps ? 'جاري التحديد...' : 'تحديد موقعي GPS'}</span>
                        </button>
                      </div>
                      <input
                        type="text"
                        required
                        value={deliveryAddress}
                        onChange={(e) => {
                          setDeliveryAddress(e.target.value);
                          setDeliveryLocation(undefined);
                        }}
                        placeholder="الشارع، رقم العمارة، الدور، الشقة"
                        className="min-h-[44px] w-full min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-teal-700 focus:outline-none"
                      />
                      {gpsNotice && (
                        <p className="mt-1 break-all font-mono text-[11px] text-teal-700">
                          {gpsNotice}
                        </p>
                      )}
                    </div>

                    {/* Save in Settings Toggle */}
                    <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <label className="flex min-h-[32px] cursor-pointer items-center gap-2 text-xs font-medium text-slate-800">
                        <input
                          type="checkbox"
                          checked={saveToSettings}
                          onChange={(e) => setSaveToSettings(e.target.checked)}
                          className="h-4 w-4 shrink-0 accent-teal-700"
                        />
                        <span>حفظ اسمي وهاتفي وهذا العنوان في إعداداتي تلقائيًا</span>
                      </label>
                      {saveToSettings && (
                        <input
                          type="text"
                          value={newAddressLabel}
                          onChange={(e) => setNewAddressLabel(e.target.value)}
                          placeholder="تسمية العنوان (مثال: المنزل، العمل)"
                          className="min-h-[40px] w-full min-w-0 rounded border border-slate-200 bg-white px-2.5 text-xs focus:border-teal-700 focus:outline-none"
                        />
                      )}
                    </div>

                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-700">
                        ملاحظات التوصيل (اختياري)
                      </label>
                      <textarea
                        rows={2}
                        value={deliveryNotes}
                        onChange={(e) => setDeliveryNotes(e.target.value)}
                        placeholder="مثال: الجرس لا يعمل، الاتصال عند الوصول"
                        className="w-full min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-teal-700 focus:outline-none"
                      />
                    </div>

                    {/* Itemized Summary inside scrollable flow so footer stays compact on small screens */}
                    <div className="space-y-1.5 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs sm:text-sm">
                      <div className="flex justify-between text-slate-600">
                        <span>قيمة المنتجات</span>
                        <span className="font-mono tabular-nums">{formatEGP(itemsSubtotal)}</span>
                      </div>
                      <div className="flex justify-between text-slate-600">
                        <span>رسوم التوصيل</span>
                        <span className="font-mono tabular-nums">{formatEGP(deliveryFee)}</span>
                      </div>
                      <div className="flex justify-between border-t border-slate-200 pt-1.5 text-xs text-slate-700">
                        <span>طريقة الدفع المعتمدة</span>
                        <span className="font-bold">نقدي عند الاستلام فقط</span>
                      </div>
                    </div>

                    {checkoutError && (
                      <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
                        {checkoutError}
                      </div>
                    )}
                  </form>
                </div>
              )}
            </div>

            {/* Compact Sticky Checkout Footer */}
            {cart.length > 0 && (
              <div className="shrink-0 border-t border-slate-200 bg-white px-3.5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-4px_12px_rgba(15,23,42,0.05)] sm:px-5 sm:py-4">
                <div className="mb-2.5 flex items-center justify-between gap-2 text-sm font-bold text-slate-900 sm:text-base">
                  <span>الإجمالي عند الاستلام</span>
                  <span className="font-mono text-base text-teal-800 tabular-nums sm:text-lg">
                    {formatEGP(orderGrandTotal)}
                  </span>
                </div>
                <button
                  type="submit"
                  form="cod-checkout-form"
                  disabled={submittingOrder}
                  className="min-h-[46px] w-full rounded-lg bg-teal-700 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-teal-800 active:scale-[0.99] disabled:opacity-50"
                >
                  {submittingOrder ? 'جاري تأكيد الطلب...' : 'تأكيد الطلب (نقدي عند الاستلام)'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
