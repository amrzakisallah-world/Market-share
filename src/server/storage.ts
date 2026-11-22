import fs from 'node:fs';
import path from 'node:path';
import { createSeedDatabase } from '../data/seedData.ts';
import type { CommerceDatabase } from '../types/commerce.ts';

export interface CommerceStorageAdapter {
  read(): Promise<CommerceDatabase>;
  write(db: CommerceDatabase): Promise<void>;
  resetDemoData(): Promise<CommerceDatabase>;
}

export class InMemoryStorageAdapter implements CommerceStorageAdapter {
  private db: CommerceDatabase;

  constructor(initial?: CommerceDatabase) {
    this.db = initial ? structuredClone(initial) : createSeedDatabase();
  }

  async read(): Promise<CommerceDatabase> {
    return structuredClone(this.db);
  }

  async write(db: CommerceDatabase): Promise<void> {
    this.db = structuredClone(db);
  }

  async resetDemoData(): Promise<CommerceDatabase> {
    const auth = this.db.auth;
    this.db = createSeedDatabase(auth);
    return structuredClone(this.db);
  }
}

export class JsonFileStorageAdapter implements CommerceStorageAdapter {
  private readonly filePath: string;
  private readonly dataDir: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(baseDir: string = process.cwd()) {
    this.dataDir = path.resolve(baseDir, 'data');
    this.filePath = path.resolve(this.dataDir, 'commerce_db.json');
    if (!this.filePath.startsWith(this.dataDir + path.sep)) {
      throw new Error('Invalid storage file path');
    }
  }

  private ensureInitialized(): CommerceDatabase {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    if (!fs.existsSync(this.filePath)) {
      const seeded = createSeedDatabase();
      fs.writeFileSync(this.filePath, JSON.stringify(seeded, null, 2), 'utf8');
      return seeded;
    }
    const raw = fs.readFileSync(this.filePath, 'utf8');
    const parsed = JSON.parse(raw) as CommerceDatabase;
    if (!parsed || !Array.isArray(parsed.shops) || !Array.isArray(parsed.masterProducts)) {
      const seeded = createSeedDatabase();
      fs.writeFileSync(this.filePath, JSON.stringify(seeded, null, 2), 'utf8');
      return seeded;
    }
    if (!parsed.auth) {
      parsed.auth = {};
    }

    // Safely enrich existing catalog with barcodes / new weighted scale products if missing
    let mutated = false;
    const seed = createSeedDatabase(parsed.auth);
    const existingProdMap = new Map(parsed.masterProducts.map((p) => [p.id, p]));
    for (const seedProd of seed.masterProducts) {
      const existing = existingProdMap.get(seedProd.id);
      if (!existing) {
        parsed.masterProducts.push(seedProd);
        mutated = true;
      } else {
        if (!existing.barcode && seedProd.barcode) {
          existing.barcode = seedProd.barcode;
          mutated = true;
        }
        if (seedProd.isWeighted && !existing.isWeighted) {
          existing.isWeighted = seedProd.isWeighted;
          existing.scalePlu = seedProd.scalePlu;
          mutated = true;
        }
      }
    }
    const existingListingKeys = new Set(
      parsed.shopListings.map((l) => `${l.shopId}::${l.productId}`),
    );
    for (const seedListing of seed.shopListings) {
      const key = `${seedListing.shopId}::${seedListing.productId}`;
      if (!existingListingKeys.has(key)) {
        parsed.shopListings.push(seedListing);
        mutated = true;
      }
    }
    if (!Array.isArray(parsed.shopPosConfigs)) {
      parsed.shopPosConfigs = seed.shopPosConfigs;
      mutated = true;
    } else {
      for (const cfg of seed.shopPosConfigs) {
        if (!parsed.shopPosConfigs.some((c) => c.shopId === cfg.shopId)) {
          parsed.shopPosConfigs.push(cfg);
          mutated = true;
        }
      }
    }
    if (!Array.isArray(parsed.shopStaffAccounts) || parsed.shopStaffAccounts.length === 0) {
      parsed.shopStaffAccounts = seed.shopStaffAccounts;
      mutated = true;
    }
    if (!Array.isArray(parsed.shopShiftSessions)) {
      parsed.shopShiftSessions = [];
      mutated = true;
    }
    if (mutated) {
      fs.writeFileSync(this.filePath, JSON.stringify(parsed, null, 2), 'utf8');
    }

    return parsed;
  }

  async read(): Promise<CommerceDatabase> {
    await this.writeQueue;
    return this.ensureInitialized();
  }

  async write(db: CommerceDatabase): Promise<void> {
    const run = this.writeQueue.then(async () => {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }
      const tempPath = `${this.filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(db, null, 2), 'utf8');
      fs.renameSync(tempPath, this.filePath);
    });
    this.writeQueue = run.catch(() => undefined);
    await run;
  }

  async resetDemoData(): Promise<CommerceDatabase> {
    const current = await this.read();
    const fresh = createSeedDatabase(current.auth);
    await this.write(fresh);
    return fresh;
  }
}
