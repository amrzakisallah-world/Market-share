import type { ShopDashboardData } from '../api/client';

export type ScaleDecodeMode = 'auto' | 'weight_embedded' | 'price_embedded';

export interface DecodedBarcodeMatch {
  kind: 'packaged' | 'scale_weight' | 'scale_price';
  rawBarcode: string;
  item: ShopDashboardData['catalog'][number];
  quantity: number; // unit count for packaged, or weightKg for weighted
  weightKg?: number;
  unitPriceEGP: number;
  lineTotalEGP: number;
  note: string;
}

/**
 * Decodes either:
 * 1) Standard packaged EAN-13 / EAN-8 / UPC / SKU barcode
 * 2) Electronic Deli/Cheese Scale 13-digit barcode (Prefix 20-29):
 *    Format: PP IIIII VVVVV C
 *    - PP: 20,21,27 => weight in grams (VVVVV / 1000 kg)
 *    - PP: 22,23,24,28,29 => price in piasters (VVVVV / 100 EGP)
 *    (Can also be overridden by cashier via ScaleDecodeMode)
 */
export function normalizeBarcodeVariants(rawCode: string): string[] {
  const clean = rawCode.replace(/[\s-]+/g, '').trim();
  if (!clean) return [];
  const variants = new Set<string>([clean]);
  if (/^\d+$/.test(clean)) {
    // Handle UPC-A (12 digits) <-> EAN-13 (leading 0 + 12 digits)
    if (clean.length === 12) {
      variants.add(`0${clean}`);
    } else if (clean.length === 13 && clean.startsWith('0')) {
      variants.add(clean.slice(1));
    }
    const stripped = clean.replace(/^0+/, '');
    if (stripped.length >= 6) {
      variants.add(stripped);
    }
  }
  return Array.from(variants);
}

export function decodeShopBarcode(
  rawCode: string,
  catalog: ShopDashboardData['catalog'],
  scaleMode: ScaleDecodeMode = 'auto',
): DecodedBarcodeMatch | { error: string; notFoundBarcode?: string } {
  const code = rawCode.replace(/[\s-]+/g, '').trim();
  if (!code) {
    return { error: 'يرجى إدخال أو مسح رقم الباركود' };
  }

  const variants = normalizeBarcodeVariants(code);

  // 1. Check exact packaged barcode (with UPC-A/EAN-13 leading-zero equivalence) or SKU match
  const exactPackaged = catalog.find((c) => {
    if (c.sku.toLowerCase() === code.toLowerCase()) return true;
    if (!c.barcode) return false;
    const itemVariants = normalizeBarcodeVariants(c.barcode);
    return variants.some((v) => itemVariants.includes(v));
  });
  if (exactPackaged) {
    return {
      kind: 'packaged',
      rawBarcode: code,
      item: exactPackaged,
      quantity: 1,
      unitPriceEGP: exactPackaged.priceEGP,
      lineTotalEGP: exactPackaged.priceEGP,
      note: `باركود منتج (${code})`,
    };
  }

  // 2. Check Electronic Scale Barcode (13 digits starting with 20..29)
  if (/^2[0-9]\d{11}$/.test(code)) {
    const prefix = code.slice(0, 2);
    const plu = code.slice(2, 7);
    const valDigits = Number(code.slice(7, 12));

    const scaleItem = catalog.find(
      (c) =>
        c.scalePlu === plu ||
        (c.scalePlu && Number(c.scalePlu) === Number(plu)),
    );

    if (!scaleItem) {
      return {
        notFoundBarcode: code,
        error: `تمت قراءة باركود ميزان (كود الصنف PLU: ${plu}) ولكن هذا الكود غير مربوط بمنتج في كتالوج المحل. يمكنك ربطه بمنتج جديد أو استخدام الإدخال اليدوي.`,
      };
    }

    const isPriceMode =
      scaleMode === 'price_embedded' ||
      (scaleMode === 'auto' && ['22', '23', '24', '28', '29'].includes(prefix));

    if (isPriceMode) {
      const priceEGP = Math.round((valDigits / 100) * 100) / 100;
      const estimatedKg =
        scaleItem.priceEGP > 0
          ? Math.round((priceEGP / scaleItem.priceEGP) * 1000) / 1000
          : 0.25;
      return {
        kind: 'scale_price',
        rawBarcode: code,
        item: scaleItem,
        quantity: estimatedKg,
        weightKg: estimatedKg,
        unitPriceEGP: scaleItem.priceEGP,
        lineTotalEGP: priceEGP,
        note: `باركود ميزان (سعر مباشر ${priceEGP} ج.م · ~${Math.round(estimatedKg * 1000)} جم)`,
      };
    }

    // Weight-embedded mode (grams -> kg)
    const weightKg = Math.round((valDigits / 1000) * 1000) / 1000;
    const lineTotalEGP = Math.round(weightKg * scaleItem.priceEGP * 100) / 100;
    return {
      kind: 'scale_weight',
      rawBarcode: code,
      item: scaleItem,
      quantity: weightKg,
      weightKg,
      unitPriceEGP: scaleItem.priceEGP,
      lineTotalEGP,
      note: `باركود ميزان (وزن ${Math.round(weightKg * 1000)} جم × ${scaleItem.priceEGP} ج.م/كجم)`,
    };
  }

  return {
    notFoundBarcode: code,
    error: `تمت قراءة الباركود "${code}"، وهو غير مسجل في كتالوج المحل حاليًا.`,
  };
}
