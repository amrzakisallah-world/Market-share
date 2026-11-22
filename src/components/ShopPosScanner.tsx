import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IScannerControls } from '@zxing/browser';
import {
  AlertTriangle,
  Camera,
  CameraOff,
  CheckCircle2,
  Flashlight,
  ImagePlus,
  Keyboard,
  Minus,
  PackagePlus,
  Plus,
  Receipt,
  Scale,
  ScanLine,
  Search,
  Trash2,
} from 'lucide-react';
import { livePosApi, shopApi, type ShopDashboardData } from '../api/client';
import type { ProductCategory } from '../types/commerce';
import { PRODUCT_CATEGORIES, formatEGP } from '../utils/arabicLabels';
import { decodeShopBarcode, type ScaleDecodeMode } from '../utils/barcodeParser';
import {
  createHighAccuracyZxingReader,
  createNativeBarcodeDetector,
  decodeBarcodeFromImageFile,
  decodeBarcodeFromVisualSource,
  hasNativeBarcodeDetector,
  setupCameraTrackControls,
} from '../utils/cameraBarcodeDecoder';

interface PosCartLine {
  lineId: string;
  productId: string;
  name: string;
  isWeighted: boolean;
  unit: string;
  unitPriceEGP: number;
  quantity: number; // units or kg
  weightKg?: number;
  lineTotalEGP: number;
  scannedBarcode?: string;
  entryMethod: 'camera_scan' | 'scale_barcode' | 'manual_entry';
  note: string;
}

interface ShopPosScannerProps {
  shopId: string;
  shopName: string;
  catalog: ShopDashboardData['catalog'];
  onSaleRecorded: () => Promise<void>;
  mode?: 'shop_owner' | 'live_pos';
  canAddProducts?: boolean;
}

const CUSTOM_CATEGORY_VALUE = '__custom__';

function playTone(kind: 'success' | 'alert') {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = kind === 'success' ? 1040 : 520;
    gain.gain.value = 0.08;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    if (kind === 'alert') {
      osc.frequency.setValueAtTime(520, ctx.currentTime);
      osc.frequency.setValueAtTime(380, ctx.currentTime + 0.08);
      osc.stop(ctx.currentTime + 0.18);
    } else {
      osc.stop(ctx.currentTime + 0.09);
    }
  } catch {
    // Ignore audio errors
  }
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    try {
      navigator.vibrate(kind === 'success' ? 70 : [80, 50, 80]);
    } catch {
      // Ignore vibrate errors
    }
  }
}

export const ShopPosScanner: React.FC<ShopPosScannerProps> = ({
  shopId,
  shopName,
  catalog,
  onSaleRecorded,
  mode = 'shop_owner',
  canAddProducts = true,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const detectorLoopRef = useRef<number | null>(null);
  const torchSetterRef = useRef<((enabled: boolean) => Promise<void>) | null>(null);
  const lastScanRef = useRef<{ code: string; at: number }>({ code: '', at: 0 });
  const zxingReaderRef = useRef(createHighAccuracyZxingReader());
  const nativeDetectorRef = useRef(createNativeBarcodeDetector());

  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraElapsedSec, setCameraElapsedSec] = useState(0);
  const [hasTorch, setHasTorch] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [analyzingSnapshot, setAnalyzingSnapshot] = useState(false);

  const [scaleMode, setScaleMode] = useState<ScaleDecodeMode>('auto');
  const [manualBarcode, setManualBarcode] = useState('');
  const [manualSearch, setManualSearch] = useState('');
  const [scanFeedback, setScanFeedback] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [unregisteredBarcode, setUnregisteredBarcode] = useState<string | null>(null);

  // Quick-add modal for newly scanned unknown barcode
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [qaBarcode, setQaBarcode] = useState('');
  const [qaName, setQaName] = useState('');
  const [qaBrand, setQaBrand] = useState('');
  const [qaCategory, setQaCategory] = useState<string>(PRODUCT_CATEGORIES[0]);
  const [qaCustomCategory, setQaCustomCategory] = useState('');
  const [qaPackSize, setQaPackSize] = useState('عبوة قياسية');
  const [qaUnit, setQaUnit] = useState('قطعة');
  const [qaPrice, setQaPrice] = useState('');
  const [qaStock, setQaStock] = useState('20');
  const [qaSubmitting, setQaSubmitting] = useState(false);

  // Manual Deli Calculator modal
  const [weightedPickerItem, setWeightedPickerItem] = useState<
    ShopDashboardData['catalog'][number] | null
  >(null);
  const [manualGrams, setManualGrams] = useState('250');
  const [manualDeliPrice, setManualDeliPrice] = useState('');

  // Receipt Cart
  const [lines, setLines] = useState<PosCartLine[]>([]);
  const [deductInventory, setDeductInventory] = useState(true);
  const [saleNote, setSaleNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [lastReceipt, setLastReceipt] = useState<{ receiptNumber: string; total: number } | null>(
    null,
  );

  const stopCamera = useCallback(() => {
    if (detectorLoopRef.current !== null) {
      window.clearInterval(detectorLoopRef.current);
      detectorLoopRef.current = null;
    }
    if (controlsRef.current) {
      controlsRef.current.stop();
      controlsRef.current = null;
    }
    if (videoRef.current?.srcObject instanceof MediaStream) {
      videoRef.current.srcObject.getTracks().forEach((t) => t.stop());
      videoRef.current.srcObject = null;
    }
    torchSetterRef.current = null;
    setTorchOn(false);
    setHasTorch(false);
    setCameraActive(false);
    setCameraElapsedSec(0);
  }, []);

  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, [stopCamera]);

  useEffect(() => {
    if (!cameraActive) return;
    const timer = window.setInterval(() => {
      setCameraElapsedSec((s) => s + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [cameraActive]);

  const handleBarcodeDecoded = useCallback(
    (rawCode: string, source: 'camera' | 'manual' | 'photo') => {
      setScanError(null);
      setScanFeedback(null);
      setUnregisteredBarcode(null);

      const decoded = decodeShopBarcode(rawCode, catalog, scaleMode);
      if ('error' in decoded) {
        playTone('alert');
        setScanError(decoded.error);
        if (decoded.notFoundBarcode) {
          setUnregisteredBarcode(decoded.notFoundBarcode);
        }
        return;
      }

      playTone('success');

      setLines((prev) => {
        if (decoded.kind === 'packaged') {
          const existing = prev.find(
            (l) => l.productId === decoded.item.productId && !l.isWeighted,
          );
          if (existing) {
            return prev.map((l) =>
              l.lineId === existing.lineId
                ? {
                    ...l,
                    quantity: l.quantity + 1,
                    lineTotalEGP: Math.round((l.quantity + 1) * l.unitPriceEGP * 100) / 100,
                  }
                : l,
            );
          }
        }
        return [
          {
            lineId: `line_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            productId: decoded.item.productId,
            name: decoded.item.name,
            isWeighted: decoded.kind !== 'packaged',
            unit: decoded.item.unit,
            unitPriceEGP: decoded.unitPriceEGP,
            quantity: decoded.quantity,
            weightKg: decoded.weightKg,
            lineTotalEGP: decoded.lineTotalEGP,
            scannedBarcode: decoded.rawBarcode,
            entryMethod:
              decoded.kind === 'packaged'
                ? source === 'manual'
                  ? 'manual_entry'
                  : 'camera_scan'
                : 'scale_barcode',
            note: decoded.note,
          },
          ...prev,
        ];
      });

      setCameraElapsedSec(0);
      setScanFeedback(`تمت القراءة والإضافة: ${decoded.item.name} — ${formatEGP(decoded.lineTotalEGP)}`);
    },
    [catalog, scaleMode],
  );

  const acceptDetectedCode = useCallback(
    (code: string, source: 'camera' | 'photo') => {
      const clean = code.trim();
      if (!clean) return;
      const now = Date.now();
      if (
        source === 'camera' &&
        lastScanRef.current.code === clean &&
        now - lastScanRef.current.at < 1800
      ) {
        return;
      }
      lastScanRef.current = { code: clean, at: now };
      handleBarcodeDecoded(clean, source);
    },
    [handleBarcodeDecoded],
  );

  const startCamera = async () => {
    setCameraError(null);
    setScanError(null);
    setUnregisteredBarcode(null);
    setCameraElapsedSec(0);

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraError(
        'المتصفح الحالي لا يدعم البث المباشر للكاميرا. استخدم زر «تصوير بكاميرا الهاتف» أو الإدخال اليدوي بالأسفل.',
      );
      return;
    }

    setCameraActive(true);

    setTimeout(async () => {
      const videoEl = videoRef.current;
      if (!videoEl) return;

      try {
        // Start ZXing continuous reader with high-resolution rear camera constraints
        const controls = await zxingReaderRef.current.decodeFromConstraints(
          {
            audio: false,
            video: {
              facingMode: { ideal: 'environment' },
              width: { ideal: 1280 },
              height: { ideal: 720 },
            },
          },
          videoEl,
          (result) => {
            if (result) {
              acceptDetectedCode(result.getText(), 'camera');
            }
          },
        );
        controlsRef.current = controls;

        // Enable continuous autofocus & check torch availability
        const trackControls = await setupCameraTrackControls(videoEl);
        setHasTorch(trackControls.hasTorch);
        torchSetterRef.current = trackControls.setTorch;

        // Run native hardware BarcodeDetector alongside ZXing when supported (Chrome Android)
        const detector = nativeDetectorRef.current;
        if (detector) {
          let busy = false;
          detectorLoopRef.current = window.setInterval(async () => {
            if (busy || !videoRef.current || videoRef.current.readyState < 2) return;
            busy = true;
            try {
              const found = await detector.detect(videoRef.current);
              const first = found.find((f) => f.rawValue && f.rawValue.trim().length >= 4);
              if (first) {
                acceptDetectedCode(first.rawValue, 'camera');
              }
            } catch {
              // Ignore single-frame detection error
            } finally {
              busy = false;
            }
          }, 180);
        }
      } catch (err) {
        stopCamera();
        setCameraError(
          err instanceof Error && err.name === 'NotAllowedError'
            ? 'تم رفض إذن الكاميرا. اسمح للكاميرا من إعدادات المتصفح أو استخدم زر «تصوير بكاميرا الهاتف» بالأسفل.'
            : 'تعذر تشغيل بث الكاميرا المباشر هنا. يمكنك استخدام زر «تصوير بكاميرا الهاتف» أو إدخال رقم الباركود يدويًا.',
        );
      }
    }, 90);
  };

  const handleToggleTorch = async () => {
    if (!torchSetterRef.current) return;
    const next = !torchOn;
    await torchSetterRef.current(next);
    setTorchOn(next);
  };

  const handleCaptureSnapshotNow = async () => {
    const videoEl = videoRef.current;
    if (!videoEl || videoEl.readyState < 2) {
      setScanError('انتظر لحظة حتى تجهز صورة الكاميرا ثم أعد المحاولة.');
      return;
    }
    setAnalyzingSnapshot(true);
    setScanError(null);
    try {
      const code = await decodeBarcodeFromVisualSource(
        videoEl,
        nativeDetectorRef.current,
        zxingReaderRef.current,
      );
      if (code) {
        acceptDetectedCode(code, 'photo');
      } else {
        playTone('alert');
        setScanError(
          'لم يلتقط الفحص الفوري باركود واضح في هذه اللقطة. قرّب الباركود داخل الإطار مع إضاءة جيدة أو استخدم «تصوير بكاميرا الهاتف» لصورة عالية الدقة أو اكتب الأرقام يدويًا.',
        );
      }
    } finally {
      setAnalyzingSnapshot(false);
    }
  };

  const handlePhotoFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setAnalyzingSnapshot(true);
    setScanError(null);
    setScanFeedback(null);
    setUnregisteredBarcode(null);

    try {
      const code = await decodeBarcodeFromImageFile(
        file,
        nativeDetectorRef.current,
        zxingReaderRef.current,
      );
      if (code) {
        acceptDetectedCode(code, 'photo');
      } else {
        playTone('alert');
        setScanError(
          'تعذر قراءة الباركود من الصورة (قد يكون الإنعكاس الضوئي أو التمويه قويًا على الغلاف). اكتب الأرقام الظاهرة أسفل خطوط الباركود في خانة الإدخال اليدوي.',
        );
      }
    } catch {
      playTone('alert');
      setScanError('تعذر تحليل الصورة المرفوعة. جرّب صورة أوضح أو أدخل الرقم يدويًا.');
    } finally {
      setAnalyzingSnapshot(false);
    }
  };

  const openQuickAddModal = (barcodePrefill: string) => {
    setQaBarcode(barcodePrefill);
    setQaName('');
    setQaBrand('');
    setQaCategory('أخرى / منتجات عامة');
    setQaCustomCategory('');
    setQaPackSize('عبوة قياسية');
    setQaUnit('قطعة');
    setQaPrice('');
    setQaStock('20');
    setQuickAddOpen(true);
  };

  const handleQuickAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const resolvedCategory = (
      qaCategory === CUSTOM_CATEGORY_VALUE ? qaCustomCategory.trim() : qaCategory
    ) as ProductCategory;
    if (!resolvedCategory) {
      setScanError('يرجى اختيار التصنيف أو كتابته يدويًا');
      return;
    }

    setQaSubmitting(true);
    setScanError(null);
    try {
      const api = mode === 'live_pos' ? livePosApi : shopApi;
      const { item: created } = await api.addProduct(shopId, {
        name: qaName.trim(),
        brand: qaBrand.trim() || 'عام',
        category: resolvedCategory,
        packSize: qaPackSize.trim() || 'قطعة',
        unit: qaUnit.trim() || 'قطعة',
        priceEGP: Number(qaPrice),
        initialStock: Number(qaStock),
        barcode: qaBarcode.trim() || undefined,
      });

      setQuickAddOpen(false);
      setUnregisteredBarcode(null);
      await onSaleRecorded();

      // Add newly created item straight to current POS receipt
      setLines((prev) => [
        {
          lineId: `line_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          productId: created.productId,
          name: created.name,
          isWeighted: false,
          unit: created.unit,
          unitPriceEGP: created.priceEGP,
          quantity: 1,
          lineTotalEGP: created.priceEGP,
          scannedBarcode: created.barcode,
          entryMethod: 'camera_scan',
          note: `تمت إضافته للكتالوج والفاتورة (${created.barcode ?? 'بدون باركود'})`,
        },
        ...prev,
      ]);
      playTone('success');
      setScanFeedback(`تم تسجيل "${created.name}" في المحل وإضافته للفاتورة بسعر ${formatEGP(created.priceEGP)}`);
    } catch (err) {
      setScanError(err instanceof Error ? err.message : 'تعذر تسجيل المنتج الجديد');
    } finally {
      setQaSubmitting(false);
    }
  };

  const handleManualBarcodeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualBarcode.trim()) return;
    handleBarcodeDecoded(manualBarcode, 'manual');
    setManualBarcode('');
  };

  const handleAddManualProduct = (item: ShopDashboardData['catalog'][number]) => {
    if (item.isWeighted) {
      setWeightedPickerItem(item);
      setManualGrams('250');
      setManualDeliPrice(String(Math.round(item.priceEGP * 0.25 * 100) / 100));
      return;
    }

    setLines((prev) => {
      const existing = prev.find((l) => l.productId === item.productId && !l.isWeighted);
      if (existing) {
        return prev.map((l) =>
          l.lineId === existing.lineId
            ? {
                ...l,
                quantity: l.quantity + 1,
                lineTotalEGP: Math.round((l.quantity + 1) * l.unitPriceEGP * 100) / 100,
              }
            : l,
        );
      }
      return [
        {
          lineId: `line_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          productId: item.productId,
          name: item.name,
          isWeighted: false,
          unit: item.unit,
          unitPriceEGP: item.priceEGP,
          quantity: 1,
          lineTotalEGP: item.priceEGP,
          entryMethod: 'manual_entry',
          note: 'إدخال يدوي',
        },
        ...prev,
      ];
    });
    setUnregisteredBarcode(null);
    setScanError(null);
    setScanFeedback(`تمت إضافة ${item.name} يدويًا`);
  };

  const handleConfirmWeightedManual = (e: React.FormEvent) => {
    e.preventDefault();
    if (!weightedPickerItem) return;
    const grams = Number(manualGrams);
    const price = Number(manualDeliPrice);
    if (!Number.isFinite(grams) || grams <= 0 || !Number.isFinite(price) || price <= 0) {
      setScanError('يرجى إدخال الوزن بالجرام والسعر بشكل صحيح');
      return;
    }
    const weightKg = Math.round((grams / 1000) * 1000) / 1000;
    setLines((prev) => [
      {
        lineId: `line_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        productId: weightedPickerItem.productId,
        name: weightedPickerItem.name,
        isWeighted: true,
        unit: 'كجم',
        unitPriceEGP: weightedPickerItem.priceEGP,
        quantity: weightKg,
        weightKg,
        lineTotalEGP: Math.round(price * 100) / 100,
        entryMethod: 'manual_entry',
        note: `إدخال يدوي للوزن (${Math.round(grams)} جم)`,
      },
      ...prev,
    ]);
    setWeightedPickerItem(null);
    setScanFeedback(`تمت إضافة ${weightedPickerItem.name} (${Math.round(grams)} جم)`);
  };

  const updateLineQty = (lineId: string, delta: number) => {
    setLines((prev) =>
      prev
        .map((l) => {
          if (l.lineId !== lineId || l.isWeighted) return l;
          const next = l.quantity + delta;
          if (next <= 0) return null;
          return {
            ...l,
            quantity: next,
            lineTotalEGP: Math.round(next * l.unitPriceEGP * 100) / 100,
          };
        })
        .filter(Boolean) as PosCartLine[],
    );
  };

  const removeLine = (lineId: string) => {
    setLines((prev) => prev.filter((l) => l.lineId !== lineId));
  };

  const receiptTotal = useMemo(
    () => Math.round(lines.reduce((s, l) => s + l.lineTotalEGP, 0) * 100) / 100,
    [lines],
  );

  const filteredQuickProducts = useMemo(() => {
    const q = manualSearch.trim().toLowerCase();
    const list = q
      ? catalog.filter(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            c.brand.toLowerCase().includes(q) ||
            c.category.toLowerCase().includes(q) ||
            (c.barcode && c.barcode.includes(q)) ||
            (c.scalePlu && c.scalePlu.includes(q)),
        )
      : catalog.filter((c) => c.isWeighted).concat(catalog.filter((c) => !c.isWeighted));
    return list.slice(0, 12);
  }, [catalog, manualSearch]);

  const handleCheckoutPos = async () => {
    if (lines.length === 0) return;
    setSubmitting(true);
    setScanError(null);
    try {
      const api = mode === 'live_pos' ? livePosApi : shopApi;
      const res = await api.recordPosSale(shopId, {
        items: lines.map((l) => ({
          productId: l.productId,
          quantity: l.quantity,
          lineTotalEGP: l.lineTotalEGP,
          weightKg: l.weightKg,
          scannedBarcode: l.scannedBarcode,
          entryMethod: l.entryMethod,
        })),
        deductInventory,
        note: saleNote.trim() || undefined,
      });
      setLastReceipt({ receiptNumber: res.receiptNumber, total: receiptTotal });
      setLines([]);
      setSaleNote('');
      await onSaleRecorded();
    } catch (err) {
      setScanError(err instanceof Error ? err.message : 'تعذر تسجيل عملية البيع');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Info Banner separating In-Store POS from Platform Orders */}
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-base font-bold text-slate-900">
              توثيق بيع الكاشير السريع بكاميرا الموبايل — {shopName}
            </h2>
            <p className="mt-0.5 text-xs text-slate-600">
              امسح باركود المنتجات أو ملصق الميزان (جبن، لانشون، بسطرمة...) بكاميرا هاتفك أو من
              صورة، أو استخدم الإدخال اليدوي في الطوارئ.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-[11px] font-medium text-slate-600">نمط باركود الميزان:</label>
            <select
              value={scaleMode}
              onChange={(e) => setScaleMode(e.target.value as ScaleDecodeMode)}
              className="min-h-[36px] rounded-lg border border-slate-200 bg-slate-50 px-2.5 text-xs"
            >
              <option value="auto">تلقائي (20-21 وزن / 22-23 سعر)</option>
              <option value="weight_embedded">الميزان يطبع الوزن (جرام)</option>
              <option value="price_embedded">الميزان يطبع السعر (جنيه)</option>
            </select>
          </div>
        </div>
      </div>

      {lastReceipt && (
        <div className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
          <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-700" />
          <div>
            <p className="font-bold">
              تم توثيق فاتورة الكاشير {lastReceipt.receiptNumber} بنجاح بقيمة{' '}
              {formatEGP(lastReceipt.total)}
            </p>
            <p className="text-xs text-emerald-800">
              أُضيفت إلى سجل المبيعات الداخلية (خارج المنصة)
              {deductInventory ? ' وتم خصمها من المخزون' : ''}.
            </p>
          </div>
        </div>
      )}

      {/* Prominent Immediate Scan Result / Alert Banner (Visible Right Under Header) */}
      {scanFeedback && (
        <div className="flex items-center gap-2.5 rounded-xl border border-emerald-300 bg-emerald-50 p-3.5 text-xs font-semibold text-emerald-900">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-700" />
          <span>{scanFeedback}</span>
        </div>
      )}

      {scanError && (
        <div className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3.5 text-xs text-amber-950">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
            <p className="font-semibold">{scanError}</p>
          </div>
          {unregisteredBarcode && canAddProducts && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => openQuickAddModal(unregisteredBarcode)}
                className="flex min-h-[36px] items-center gap-1.5 rounded-lg bg-teal-700 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-teal-800"
              >
                <PackagePlus className="h-3.5 w-3.5" />
                <span>إضافة الباركود ({unregisteredBarcode}) كمنتج جديد وإدراجه للفاتورة</span>
              </button>
            </div>
          )}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-12">
        {/* Left/Main Column: Camera Scanner + Emergency Manual Entry */}
        <div className="space-y-5 lg:col-span-7">
          {/* Camera Barcode Scanner */}
          <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="flex items-center gap-2">
                  <Camera className="h-4 w-4 text-teal-700" />
                  <h3 className="font-display text-sm font-bold text-slate-900">
                    1. مسح الباركود بكاميرا الموبايل
                  </h3>
                </div>
                <p className="mt-0.5 text-[11px] text-slate-500">
                  المحرك: {hasNativeBarcodeDetector() ? 'قراءة سريعة مزدوجة (BarcodeDetector + ZXing)' : 'محرك ZXing عالي الدقة (EAN-13 / UPC-A)'}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {!cameraActive ? (
                  <button
                    type="button"
                    onClick={startCamera}
                    className="flex min-h-[40px] items-center gap-1.5 rounded-lg bg-teal-700 px-4 py-2 text-xs font-semibold text-white hover:bg-teal-800"
                  >
                    <Camera className="h-4 w-4" />
                    <span>تشغيل الكاميرا للمسح</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={stopCamera}
                    className="flex min-h-[40px] items-center gap-1.5 rounded-lg border border-rose-300 bg-rose-50 px-3.5 py-2 text-xs font-semibold text-rose-800 hover:bg-rose-100"
                  >
                    <CameraOff className="h-4 w-4" />
                    <span>إيقاف الكاميرا</span>
                  </button>
                )}

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={handlePhotoFileChange}
                  className="hidden"
                />
                <button
                  type="button"
                  disabled={analyzingSnapshot}
                  onClick={() => fileInputRef.current?.click()}
                  className="flex min-h-[40px] items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50"
                >
                  <ImagePlus className="h-4 w-4 text-teal-700" />
                  <span>{analyzingSnapshot ? 'جاري التحليل...' : 'تصوير بكاميرا الهاتف / صورة'}</span>
                </button>
              </div>
            </div>

            {cameraActive && (
              <div className="space-y-2">
                <div className="relative overflow-hidden rounded-xl border border-slate-300 bg-slate-950">
                  <video
                    ref={videoRef}
                    playsInline
                    muted
                    autoPlay
                    className="h-60 w-full object-cover sm:h-72"
                  />
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <div className="h-24 w-64 rounded-lg border-2 border-teal-400/90 bg-transparent shadow-[0_0_0_9999px_rgba(0,0,0,0.32)]" />
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-900/90 px-3 py-2 text-[11px] text-white">
                    <span>
                      العدسة مفتوحة ({cameraElapsedSec} ث) — ضع خطوط الباركود أفقيًا داخل المربع
                    </span>
                    <div className="flex items-center gap-2">
                      {hasTorch && (
                        <button
                          type="button"
                          onClick={handleToggleTorch}
                          className={`flex items-center gap-1 rounded px-2 py-1 text-[11px] font-semibold ${
                            torchOn ? 'bg-amber-400 text-slate-950' : 'bg-slate-700 text-white'
                          }`}
                        >
                          <Flashlight className="h-3.5 w-3.5" />
                          <span>{torchOn ? 'إطفاء الفلاش' : 'فلاش'}</span>
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={analyzingSnapshot}
                        onClick={handleCaptureSnapshotNow}
                        className="flex items-center gap-1 rounded bg-teal-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-teal-500 disabled:opacity-50"
                      >
                        <ScanLine className="h-3.5 w-3.5" />
                        <span>{analyzingSnapshot ? 'جاري الفحص...' : 'التقاط وفحص فوري'}</span>
                      </button>
                    </div>
                  </div>
                </div>

                {cameraElapsedSec >= 4 && (
                  <div className="rounded-lg border border-sky-200 bg-sky-50 p-2.5 text-[11px] text-sky-900">
                    لم يتم التقاط باركود تلقائيًا بعد. قرّب الهاتف مسافة 12–18 سم بعيدًا عن انعكاس
                    الإضاءة، أو اضغط <strong>«التقاط وفحص فوري»</strong>، أو استخدم{' '}
                    <strong>«تصوير بكاميرا الهاتف»</strong> لالتقاط لقطة تركيز ماكرو واضحة.
                  </div>
                )}
              </div>
            )}

            {cameraError && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                {cameraError}
              </div>
            )}

            {/* Quick Scale & Barcode Test Samples */}
            <div className="rounded-lg border border-slate-100 bg-slate-50 p-3">
              <p className="text-[11px] font-semibold text-slate-600">
                تجربة فورية لباركود الميزان والمنتجات (بدون ملصق ورقي):
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => handleBarcodeDecoded('2100101003509', 'manual')}
                  className="rounded border border-slate-200 bg-white px-2.5 py-1 text-[11px] text-slate-700 hover:border-teal-600 hover:text-teal-800"
                >
                  <Scale className="ml-1 inline h-3 w-3 text-teal-700" />
                  جبنة رومي 350 جم (وزن)
                </button>
                <button
                  type="button"
                  onClick={() => handleBarcodeDecoded('2200102045501', 'manual')}
                  className="rounded border border-slate-200 bg-white px-2.5 py-1 text-[11px] text-slate-700 hover:border-teal-600 hover:text-teal-800"
                >
                  <Scale className="ml-1 inline h-3 w-3 text-teal-700" />
                  لانشون بقري 45.50 ج.م (سعر)
                </button>
                <button
                  type="button"
                  onClick={() =>
                    handleBarcodeDecoded(catalog[0]?.barcode ?? '6221000000010', 'manual')
                  }
                  className="rounded border border-slate-200 bg-white px-2.5 py-1 text-[11px] text-slate-700 hover:border-teal-600 hover:text-teal-800"
                >
                  {catalog[0]?.name ?? 'أرز الضحى'} (باركود عادي)
                </button>
              </div>
            </div>
          </div>

          {/* Emergency Manual Entry */}
          <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Keyboard className="h-4 w-4 text-slate-700" />
                <h3 className="font-display text-sm font-bold text-slate-900">
                  2. الإدخال اليدوي في الطوارئ (رقم باركود أو اختيار مباشر)
                </h3>
              </div>
              {canAddProducts && (
                <button
                  type="button"
                  onClick={() => openQuickAddModal('')}
                  className="flex items-center gap-1 rounded-lg border border-teal-200 bg-teal-50 px-2.5 py-1 text-[11px] font-semibold text-teal-800 hover:bg-teal-100"
                >
                  <PackagePlus className="h-3.5 w-3.5" />
                  <span>تسجيل منتج جديد سريعًا</span>
                </button>
              )}
            </div>

            <form onSubmit={handleManualBarcodeSubmit} className="flex gap-2">
              <input
                type="text"
                dir="ltr"
                value={manualBarcode}
                onChange={(e) => setManualBarcode(e.target.value)}
                placeholder="اكتب رقم الباركود (مثال: 071737998984)..."
                className="min-h-[42px] flex-1 rounded-lg border border-slate-200 px-3 text-right font-mono text-xs focus:border-teal-700 focus:outline-none"
              />
              <button
                type="submit"
                className="min-h-[42px] shrink-0 rounded-lg bg-slate-900 px-4 text-xs font-semibold text-white hover:bg-teal-700"
              >
                إضافة بالكود
              </button>
            </form>

            {/* Quick Manual Product Picker */}
            <div className="space-y-2 border-t border-slate-100 pt-3">
              <div className="relative">
                <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  type="search"
                  value={manualSearch}
                  onChange={(e) => setManualSearch(e.target.value)}
                  placeholder="ابحث بالاسم أو التصنيف أو كود الميزان PLU لإضافة يدوية سريعة..."
                  className="min-h-[40px] w-full rounded-lg border border-slate-200 py-2 pr-9 pl-3 text-xs focus:border-teal-700 focus:outline-none"
                />
              </div>

              <div className="grid max-h-64 gap-2 overflow-y-auto sm:grid-cols-2">
                {filteredQuickProducts.map((item) => (
                  <button
                    key={item.productId}
                    type="button"
                    onClick={() => handleAddManualProduct(item)}
                    className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 p-2.5 text-right text-xs transition-colors hover:border-teal-600 hover:bg-teal-50/40"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold text-slate-900">{item.name}</p>
                      <p className="truncate text-[11px] text-slate-500">
                        {item.isWeighted
                          ? `ميزان PLU: ${item.scalePlu} · ${formatEGP(item.priceEGP)}/كجم`
                          : `${item.packSize} · ${formatEGP(item.priceEGP)}`}
                      </p>
                    </div>
                    <span className="shrink-0 rounded bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-700">
                      + إضافة
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: POS Receipt & Record Sale */}
        <div className="lg:col-span-5">
          <div className="sticky top-20 space-y-4 rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <Receipt className="h-4 w-4 text-teal-700" />
                <h3 className="font-display text-sm font-bold text-slate-900">
                  فاتورة الكاشير الحالية
                </h3>
              </div>
              <span className="font-mono text-xs text-slate-500 tabular-nums">
                {lines.length} بند
              </span>
            </div>

            {lines.length === 0 ? (
              <div className="py-10 text-center text-xs text-slate-500">
                امسح منتجًا بالكاميرا أو اختر صنفًا يدويًا لبدء الفاتورة.
              </div>
            ) : (
              <div className="max-h-72 divide-y divide-slate-100 overflow-y-auto">
                {lines.map((line) => (
                  <div key={line.lineId} className="flex items-center justify-between gap-2 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-semibold text-slate-900">{line.name}</p>
                      <p className="text-[11px] text-slate-500">{line.note}</p>
                    </div>

                    <div className="flex shrink-0 items-center gap-1.5">
                      {!line.isWeighted ? (
                        <>
                          <button
                            type="button"
                            onClick={() => updateLineQty(line.lineId, 1)}
                            className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 text-slate-700 hover:bg-slate-50"
                          >
                            <Plus className="h-3 w-3" />
                          </button>
                          <span className="w-5 text-center font-mono text-xs font-bold tabular-nums">
                            {line.quantity}
                          </span>
                          <button
                            type="button"
                            onClick={() => updateLineQty(line.lineId, -1)}
                            className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 text-slate-700 hover:bg-slate-50"
                          >
                            <Minus className="h-3 w-3" />
                          </button>
                        </>
                      ) : (
                        <span className="font-mono text-[11px] text-slate-600 tabular-nums">
                          {Math.round((line.weightKg ?? line.quantity) * 1000)} جم
                        </span>
                      )}

                      <span className="min-w-[60px] text-left font-mono text-xs font-bold text-slate-900 tabular-nums">
                        {formatEGP(line.lineTotalEGP)}
                      </span>

                      <button
                        type="button"
                        aria-label="حذف"
                        onClick={() => removeLine(line.lineId)}
                        className="flex h-7 w-7 items-center justify-center rounded text-rose-600 hover:bg-rose-50"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="space-y-3 border-t border-slate-200 pt-3">
              <label className="flex items-center gap-2 text-xs text-slate-700">
                <input
                  type="checkbox"
                  checked={deductInventory}
                  onChange={(e) => setDeductInventory(e.target.checked)}
                />
                <span>خصم الكميات المباعة من مخزون المحل تلقائيًا</span>
              </label>

              <input
                type="text"
                value={saleNote}
                onChange={(e) => setSaleNote(e.target.value)}
                placeholder="ملاحظة اختيارية على الفاتورة"
                className="min-h-[38px] w-full rounded-lg border border-slate-200 px-3 text-xs"
              />

              <div className="flex items-center justify-between rounded-lg bg-slate-50 p-3 text-sm font-bold text-slate-900">
                <span>إجمالي الفاتورة النقدية</span>
                <span className="font-mono text-base text-teal-800 tabular-nums">
                  {formatEGP(receiptTotal)}
                </span>
              </div>

              <button
                type="button"
                disabled={lines.length === 0 || submitting}
                onClick={handleCheckoutPos}
                className="min-h-[44px] w-full rounded-lg bg-teal-700 px-4 text-sm font-semibold text-white transition-colors hover:bg-teal-800 disabled:opacity-50"
              >
                {submitting ? 'جاري تسجيل البيع...' : 'توثيق وتسجيل البيع النقدي بالمحل'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Quick-Add Unregistered Barcode Modal */}
      {quickAddOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <form
            onSubmit={handleQuickAddSubmit}
            className="max-h-[90vh] w-full max-w-md space-y-3 overflow-y-auto rounded-xl border border-slate-200 bg-white p-5 shadow-xl"
          >
            <div>
              <h3 className="font-display text-base font-bold text-slate-900">
                إضافة منتج جديد للكتالوج والفاتورة
              </h3>
              <p className="mt-0.5 text-xs text-slate-600">
                يُحفظ المنتج في المحل مع ربط الباركود الخاص به لقراءته تلقائيًا في المرات القادمة.
              </p>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-700">رقم الباركود</label>
              <input
                type="text"
                dir="ltr"
                value={qaBarcode}
                onChange={(e) => setQaBarcode(e.target.value)}
                placeholder="مثال: 071737998984"
                className="min-h-[40px] w-full rounded-lg border border-slate-200 px-3 text-right font-mono text-xs"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-700">اسم المنتج</label>
              <input
                type="text"
                required
                value={qaName}
                onChange={(e) => setQaName(e.target.value)}
                placeholder="مثال: إل إم أحمر / بسكويت / منتج جديد"
                className="min-h-[40px] w-full rounded-lg border border-slate-200 px-3 text-xs"
              />
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-700">العلامة التجارية</label>
                <input
                  type="text"
                  value={qaBrand}
                  onChange={(e) => setQaBrand(e.target.value)}
                  placeholder="اختياري"
                  className="min-h-[40px] w-full rounded-lg border border-slate-200 px-3 text-xs"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-700">التصنيف</label>
                <select
                  value={qaCategory}
                  onChange={(e) => setQaCategory(e.target.value)}
                  className="min-h-[40px] w-full rounded-lg border border-slate-200 px-2.5 text-xs"
                >
                  {PRODUCT_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                  <option value={CUSTOM_CATEGORY_VALUE}>+ تصنيف مخصص (كتابة يدوية)</option>
                </select>
              </div>
            </div>

            {qaCategory === CUSTOM_CATEGORY_VALUE && (
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-700">
                  اسم التصنيف المخصص
                </label>
                <input
                  type="text"
                  required
                  value={qaCustomCategory}
                  onChange={(e) => setQaCustomCategory(e.target.value)}
                  placeholder="اكتب التصنيف المناسب..."
                  className="min-h-[40px] w-full rounded-lg border border-teal-300 px-3 text-xs"
                />
              </div>
            )}

            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-700">الحجم / العبوة</label>
                <input
                  type="text"
                  required
                  value={qaPackSize}
                  onChange={(e) => setQaPackSize(e.target.value)}
                  placeholder="مثال: علبة 20 سيجارة / 250 جم"
                  className="min-h-[40px] w-full rounded-lg border border-slate-200 px-3 text-xs"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-700">الوحدة</label>
                <input
                  type="text"
                  required
                  value={qaUnit}
                  onChange={(e) => setQaUnit(e.target.value)}
                  placeholder="علبة / قطعة / كيس"
                  className="min-h-[40px] w-full rounded-lg border border-slate-200 px-3 text-xs"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-700">السعر (ج.م)</label>
                <input
                  type="number"
                  required
                  min="1"
                  step="0.5"
                  value={qaPrice}
                  onChange={(e) => setQaPrice(e.target.value)}
                  placeholder="السعر"
                  className="min-h-[40px] w-full rounded-lg border border-slate-200 px-3 font-mono text-xs"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-700">الرصيد المتاح</label>
                <input
                  type="number"
                  required
                  min="1"
                  value={qaStock}
                  onChange={(e) => setQaStock(e.target.value)}
                  className="min-h-[40px] w-full rounded-lg border border-slate-200 px-3 font-mono text-xs"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setQuickAddOpen(false)}
                className="min-h-[40px] rounded-lg border border-slate-200 px-4 text-xs text-slate-700"
              >
                إلغاء
              </button>
              <button
                type="submit"
                disabled={qaSubmitting}
                className="min-h-[40px] rounded-lg bg-teal-700 px-4 text-xs font-semibold text-white hover:bg-teal-800 disabled:opacity-50"
              >
                {qaSubmitting ? 'جاري الحفظ...' : 'حفظ المنتج وإضافته للفاتورة'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Emergency Weighted Deli Manual Calculator Modal */}
      {weightedPickerItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <form
            onSubmit={handleConfirmWeightedManual}
            className="w-full max-w-sm space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-xl"
          >
            <div>
              <h3 className="font-display text-base font-bold text-slate-900">
                إدخال يدوي لصنف الميزان
              </h3>
              <p className="mt-0.5 text-xs text-slate-600">
                {weightedPickerItem.name} — سعر الكيلو:{' '}
                <span className="font-mono font-bold">
                  {formatEGP(weightedPickerItem.priceEGP)}
                </span>
              </p>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-700">
                الوزن بالجرام (مثال: 250 جم = ربع كيلو)
              </label>
              <input
                type="number"
                min="10"
                step="5"
                required
                value={manualGrams}
                onChange={(e) => {
                  const g = e.target.value;
                  setManualGrams(g);
                  const numG = Number(g);
                  if (Number.isFinite(numG) && numG > 0) {
                    setManualDeliPrice(
                      String(Math.round((numG / 1000) * weightedPickerItem.priceEGP * 100) / 100),
                    );
                  }
                }}
                className="min-h-[42px] w-full rounded-lg border border-slate-200 px-3 font-mono text-sm"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-700">
                أو أدخل السعر الإجمالي للقطعة (ج.م)
              </label>
              <input
                type="number"
                min="1"
                step="0.5"
                required
                value={manualDeliPrice}
                onChange={(e) => {
                  const p = e.target.value;
                  setManualDeliPrice(p);
                  const numP = Number(p);
                  if (
                    Number.isFinite(numP) &&
                    numP > 0 &&
                    weightedPickerItem.priceEGP > 0
                  ) {
                    setManualGrams(
                      String(Math.round((numP / weightedPickerItem.priceEGP) * 1000)),
                    );
                  }
                }}
                className="min-h-[42px] w-full rounded-lg border border-slate-200 px-3 font-mono text-sm"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setWeightedPickerItem(null)}
                className="min-h-[40px] rounded-lg border border-slate-200 px-4 text-xs text-slate-700"
              >
                إلغاء
              </button>
              <button
                type="submit"
                className="min-h-[40px] rounded-lg bg-teal-700 px-4 text-xs font-semibold text-white hover:bg-teal-800"
              >
                إضافة للفاتورة
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
