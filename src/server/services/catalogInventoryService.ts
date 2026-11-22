import type {
  CatalogItemView,
  CommerceDatabase,
  InventoryMovement,
  MasterProduct,
  ProductCategory,
} from '../../types/commerce.ts';
import type { CommerceStorageAdapter } from '../storage.ts';
import {
  DomainError,
  appendAuditLog,
  makeId,
  roundMoney,
  roundStockQty,
} from './shared.ts';

export class CatalogInventoryService {
  private readonly storage: CommerceStorageAdapter;

  constructor(storage: CommerceStorageAdapter) {
    this.storage = storage;
  }

  buildShopCatalogFromDb(db: CommerceDatabase, shopId: string): CatalogItemView[] {
    const shop = db.shops.find((s) => s.id === shopId);
    if (!shop) {
      throw new DomainError('المحل المطلوب غير موجود', 404);
    }
    const productById = new Map(db.masterProducts.map((p) => [p.id, p]));
    const result: CatalogItemView[] = [];

    for (const listing of db.shopListings) {
      if (listing.shopId !== shopId) continue;
      const product = productById.get(listing.productId);
      if (!product) continue;
      const availableToSell = Math.max(
        0,
        roundStockQty(listing.currentStock - listing.reservedStock),
      );
      result.push({
        listingId: listing.id,
        shopId: listing.shopId,
        productId: product.id,
        sku: product.sku,
        barcode: product.barcode,
        isWeighted: product.isWeighted,
        scalePlu: product.scalePlu,
        name: product.name,
        brand: product.brand,
        category: product.category,
        packSize: product.packSize,
        unit: product.unit,
        description: product.description,
        priceEGP: listing.priceEGP,
        priceUpdatedAt: listing.priceUpdatedAt,
        priceSourceNote: listing.priceSourceNote,
        isAvailable: listing.isAvailable,
        currentStock: listing.currentStock,
        reservedStock: listing.reservedStock,
        availableToSell,
        lowStockThreshold: listing.lowStockThreshold,
        isLowStock: availableToSell <= listing.lowStockThreshold,
      });
    }
    return result;
  }

  async getShopCatalog(shopId: string): Promise<CatalogItemView[]> {
    const db = await this.storage.read();
    return this.buildShopCatalogFromDb(db, shopId);
  }

  async getShopInventoryMovements(shopId: string): Promise<InventoryMovement[]> {
    const db = await this.storage.read();
    return db.inventoryMovements.filter((m) => m.shopId === shopId);
  }

  async updateShopProductListing(input: {
    shopId: string;
    productId: string;
    priceEGP?: number;
    isAvailable?: boolean;
    stockDelta?: number;
    lowStockThreshold?: number;
    reason: string;
    actorName: string;
  }): Promise<CatalogItemView> {
    const reason = (input.reason ?? '').trim();
    if (!reason) {
      throw new DomainError('لا يُسمح بتعديل السعر أو المخزون بدون تسجيل سبب العملية');
    }

    return this.storage.transact((db) => {
      const listing = db.shopListings.find(
        (l) => l.shopId === input.shopId && l.productId === input.productId,
      );
      const product = db.masterProducts.find((p) => p.id === input.productId);
      if (!listing || !product) {
        throw new DomainError('المنتج غير موجود في كتالوج هذا المحل', 404);
      }

      const now = new Date().toISOString();
      const changes: string[] = [];

      if (input.priceEGP !== undefined) {
        const price = Number(input.priceEGP);
        if (!Number.isFinite(price) || price <= 0) {
          throw new DomainError('السعر يجب أن يكون أكبر من صفر');
        }
        const rounded = roundMoney(price);
        if (rounded !== listing.priceEGP) {
          changes.push(`السعر ${listing.priceEGP} -> ${rounded}`);
          listing.priceEGP = rounded;
          listing.priceUpdatedAt = now;
          listing.priceSourceNote = `تحديث يدوي بواسطة ${input.actorName}: ${reason}`;
        }
      }

      if (input.lowStockThreshold !== undefined) {
        const threshold = Math.max(0, Math.floor(Number(input.lowStockThreshold)));
        if (Number.isFinite(threshold)) {
          listing.lowStockThreshold = threshold;
        }
      }

      if (input.stockDelta !== undefined && input.stockDelta !== 0) {
        const delta = product.isWeighted
          ? roundStockQty(Number(input.stockDelta))
          : Math.trunc(Number(input.stockDelta));
        if (!Number.isFinite(delta)) {
          throw new DomainError('قيمة تعديل المخزون غير صالحة');
        }
        const newStock = roundStockQty(listing.currentStock + delta);
        if (newStock < listing.reservedStock) {
          throw new DomainError(
            `لا يمكن خفض المخزون عن الكمية المحجوزة حاليًا للطلبات (${listing.reservedStock})`,
          );
        }
        changes.push(`المخزون ${delta > 0 ? `+${delta}` : delta}`);
        listing.currentStock = newStock;
        db.inventoryMovements.unshift({
          id: makeId('mov'),
          shopId: input.shopId,
          productId: product.id,
          productName: product.name,
          type: delta > 0 ? 'manual_add' : 'manual_deduct',
          quantityDelta: delta,
          reservedDelta: 0,
          stockAfter: listing.currentStock,
          reservedAfter: listing.reservedStock,
          actorRole: 'shop_owner',
          actorName: input.actorName,
          reason,
          createdAt: now,
        });
      }

      if (input.isAvailable !== undefined) {
        if (input.isAvailable && listing.currentStock - listing.reservedStock <= 0) {
          throw new DomainError('لا يمكن تفعيل توفر منتج رصيده المتاح صفر');
        }
        listing.isAvailable = input.isAvailable;
      } else if (listing.currentStock - listing.reservedStock <= 0) {
        listing.isAvailable = false;
      }

      appendAuditLog(db, {
        actorRole: 'shop_owner',
        actorName: input.actorName,
        shopId: input.shopId,
        category: 'inventory',
        action: 'update_listing',
        targetId: product.id,
        summary: `تعديل "${product.name}" (${changes.join('، ') || 'حالة التوفر'}) — السبب: ${reason}`,
      });

      return this.buildShopCatalogFromDb(db, input.shopId).find(
        (c) => c.productId === input.productId,
      )!;
    });
  }

  async addProductToShop(input: {
    shopId: string;
    name: string;
    brand: string;
    category: ProductCategory;
    packSize: string;
    unit: string;
    barcode?: string;
    isWeighted?: boolean;
    scalePlu?: string;
    description?: string;
    priceEGP: number;
    initialStock: number;
    lowStockThreshold?: number;
    actorName: string;
  }): Promise<CatalogItemView> {
    const name = input.name?.trim();
    const brand = input.brand?.trim() || 'عام';
    const packSize = input.packSize?.trim();
    const unit = input.unit?.trim();
    const price = Number(input.priceEGP);
    const initialStock = input.isWeighted
      ? roundStockQty(Number(input.initialStock))
      : Math.floor(Number(input.initialStock));

    if (!name || !packSize || !unit) {
      throw new DomainError('يرجى إدخال اسم المنتج والحجم والوحدة');
    }
    if (!Number.isFinite(price) || price <= 0) {
      throw new DomainError('يرجى إدخال سعر صحيح أكبر من صفر');
    }
    if (!Number.isFinite(initialStock) || initialStock < 0) {
      throw new DomainError('الكمية الافتتاحية يجب أن تكون صفر أو أكثر');
    }

    const cleanBarcode = input.barcode?.trim() || undefined;
    const cleanPlu = input.scalePlu?.trim() || undefined;

    return this.storage.transact((db) => {
      const shop = db.shops.find((s) => s.id === input.shopId);
      if (!shop) {
        throw new DomainError('المحل غير موجود', 404);
      }

      if (cleanBarcode) {
        const dupBarcode = db.shopListings.some((l) => {
          if (l.shopId !== input.shopId) return false;
          const p = db.masterProducts.find((mp) => mp.id === l.productId);
          return p?.barcode === cleanBarcode;
        });
        if (dupBarcode) {
          throw new DomainError(`الباركود ${cleanBarcode} مسجل بالفعل لمنتج في هذا المحل`);
        }
      }

      const now = new Date().toISOString();
      const productId = makeId('prod');
      const sku = `EG-CUS-${String(db.masterProducts.length + 1).padStart(3, '0')}`;

      const masterProduct: MasterProduct = {
        id: productId,
        sku,
        barcode: cleanBarcode,
        isWeighted: Boolean(input.isWeighted),
        scalePlu: cleanPlu,
        name,
        brand,
        category: input.category,
        packSize,
        unit,
        description: input.description?.trim() || `${name} ${packSize}`,
      };
      db.masterProducts.push(masterProduct);

      db.shopListings.push({
        id: makeId('lst'),
        shopId: input.shopId,
        productId,
        priceEGP: roundMoney(price),
        priceUpdatedAt: now,
        priceSourceNote: 'سعر مدخل من المحل',
        isAvailable: initialStock > 0,
        currentStock: initialStock,
        reservedStock: 0,
        lowStockThreshold: Math.max(1, Math.floor(input.lowStockThreshold ?? 5)),
      });

      db.inventoryMovements.unshift({
        id: makeId('mov'),
        shopId: input.shopId,
        productId,
        productName: name,
        type: 'manual_add',
        quantityDelta: initialStock,
        reservedDelta: 0,
        stockAfter: initialStock,
        reservedAfter: 0,
        actorRole: 'shop_owner',
        actorName: input.actorName,
        reason: 'إضافة منتج جديد لكتالوج المحل',
        createdAt: now,
      });

      appendAuditLog(db, {
        actorRole: 'shop_owner',
        actorName: input.actorName,
        shopId: input.shopId,
        category: 'inventory',
        action: 'add_product',
        targetId: productId,
        summary: `إضافة منتج جديد "${name}" بسعر ${roundMoney(price)} ج.م ورصيد ${initialStock}`,
      });

      return this.buildShopCatalogFromDb(db, input.shopId).find(
        (c) => c.productId === productId,
      )!;
    });
  }
}
