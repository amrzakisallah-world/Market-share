import { BrowserMultiFormatReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';

export interface NativeBarcodeDetectorInstance {
  detect(
    source: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement | ImageBitmap,
  ): Promise<Array<{ rawValue: string; format: string }>>;
}

interface BarcodeDetectorConstructor {
  new (options?: { formats?: string[] }): NativeBarcodeDetectorInstance;
  getSupportedFormats?: () => Promise<string[]>;
}

const RETAIL_FORMATS = [
  BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8,
  BarcodeFormat.UPC_A,
  BarcodeFormat.UPC_E,
  BarcodeFormat.CODE_128,
  BarcodeFormat.CODE_39,
  BarcodeFormat.ITF,
  BarcodeFormat.QR_CODE,
];

export function createHighAccuracyZxingReader(): BrowserMultiFormatReader {
  const hints = new Map<DecodeHintType, unknown>();
  hints.set(DecodeHintType.TRY_HARDER, true);
  hints.set(DecodeHintType.POSSIBLE_FORMATS, RETAIL_FORMATS);

  return new BrowserMultiFormatReader(hints, {
    delayBetweenScanAttempts: 120,
    delayBetweenScanSuccess: 1400,
  });
}

export function createNativeBarcodeDetector(): NativeBarcodeDetectorInstance | null {
  const Ctor = (
    window as unknown as { BarcodeDetector?: BarcodeDetectorConstructor }
  ).BarcodeDetector;
  if (!Ctor) return null;
  try {
    return new Ctor({
      formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf'],
    });
  } catch {
    try {
      return new Ctor();
    } catch {
      return null;
    }
  }
}

export function hasNativeBarcodeDetector(): boolean {
  return typeof (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector === 'function';
}

function drawToCanvas(
  source: HTMLVideoElement | HTMLImageElement,
  options?: {
    cropCenter?: boolean;
    highContrast?: boolean;
    rotate90?: boolean;
    maxDim?: number;
  },
): HTMLCanvasElement | null {
  const rawW =
    source instanceof HTMLVideoElement ? source.videoWidth : source.naturalWidth || source.width;
  const rawH =
    source instanceof HTMLVideoElement ? source.videoHeight : source.naturalHeight || source.height;
  if (!rawW || !rawH) return null;

  const cropX = options?.cropCenter ? Math.round(rawW * 0.12) : 0;
  const cropY = options?.cropCenter ? Math.round(rawH * 0.2) : 0;
  const cropW = options?.cropCenter ? Math.round(rawW * 0.76) : rawW;
  const cropH = options?.cropCenter ? Math.round(rawH * 0.6) : rawH;

  const maxDim = options?.maxDim ?? 1400;
  const scale = Math.min(1, maxDim / Math.max(cropW, cropH));
  const outW = Math.max(1, Math.round(cropW * scale));
  const outH = Math.max(1, Math.round(cropH * scale));

  const canvas = document.createElement('canvas');
  if (options?.rotate90) {
    canvas.width = outH;
    canvas.height = outW;
  } else {
    canvas.width = outW;
    canvas.height = outH;
  }

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  if (options?.highContrast) {
    ctx.filter = 'grayscale(100%) contrast(210%) brightness(106%)';
  }

  if (options?.rotate90) {
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(source, cropX, cropY, cropW, cropH, -outW / 2, -outH / 2, outW, outH);
  } else {
    ctx.drawImage(source, cropX, cropY, cropW, cropH, 0, 0, outW, outH);
  }

  return canvas;
}

/**
 * Multi-pass barcode detection for still camera snapshots or uploaded photos.
 * Tries native BarcodeDetector + ZXing TRY_HARDER across original, high-contrast center crop, and 90deg rotated views.
 */
export async function decodeBarcodeFromVisualSource(
  source: HTMLVideoElement | HTMLImageElement,
  detector: NativeBarcodeDetectorInstance | null,
  reader: BrowserMultiFormatReader,
): Promise<string | null> {
  const passes: Array<{
    cropCenter?: boolean;
    highContrast?: boolean;
    rotate90?: boolean;
  }> = [
    {},
    { cropCenter: true, highContrast: true },
    { rotate90: true },
    { cropCenter: true, highContrast: true, rotate90: true },
  ];

  for (const pass of passes) {
    const canvas = drawToCanvas(source, pass);
    if (!canvas) continue;

    if (detector) {
      try {
        const found = await detector.detect(canvas);
        const valid = found.find((f) => f.rawValue && f.rawValue.trim().length >= 4);
        if (valid) {
          return valid.rawValue.trim();
        }
      } catch {
        // Fallback to ZXing on this canvas
      }
    }

    try {
      const result = reader.decodeFromCanvas(canvas);
      const text = result.getText()?.trim();
      if (text) return text;
    } catch {
      // NotFoundException on this pass, try next pass
    }
  }

  return null;
}

export async function decodeBarcodeFromImageFile(
  file: File,
  detector: NativeBarcodeDetectorInstance | null,
  reader: BrowserMultiFormatReader,
): Promise<string | null> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('تعذر قراءة ملف الصورة'));
      el.src = url;
    });
    return await decodeBarcodeFromVisualSource(img, detector, reader);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function setupCameraTrackControls(videoEl: HTMLVideoElement): Promise<{
  hasTorch: boolean;
  setTorch: (enabled: boolean) => Promise<void>;
}> {
  const stream = videoEl.srcObject;
  if (!(stream instanceof MediaStream)) {
    return { hasTorch: false, setTorch: async () => {} };
  }
  const track = stream.getVideoTracks()[0];
  if (!track) {
    return { hasTorch: false, setTorch: async () => {} };
  }

  const caps = (typeof track.getCapabilities === 'function' ? track.getCapabilities() : {}) as {
    focusMode?: string[];
    torch?: boolean;
  };

  if (Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) {
    try {
      await track.applyConstraints({
        advanced: [{ focusMode: 'continuous' } as unknown as MediaTrackConstraintSet],
      });
    } catch {
      // Ignore if device rejects continuous focus constraint
    }
  }

  const hasTorch = Boolean(caps.torch);
  return {
    hasTorch,
    setTorch: async (enabled: boolean) => {
      if (!hasTorch) return;
      try {
        await track.applyConstraints({
          advanced: [{ torch: enabled } as unknown as MediaTrackConstraintSet],
        });
      } catch {
        // Ignore torch toggle failures
      }
    },
  };
}
