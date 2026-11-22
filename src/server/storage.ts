import fs from 'node:fs';
import path from 'node:path';
import { createSeedDatabase } from '../data/seedData.ts';
import type { BackupSnapshotInfo, CommerceDatabase } from '../types/commerce.ts';

const SEEDED_DEMO_CUSTOMER_IDS = new Set([
  'cust_1',
  'cust_2',
  'cust_3',
  'cust_4',
  'cust_5',
  'cust_6',
]);

export interface CommerceStorageAdapter {
  read(): Promise<CommerceDatabase>;
  write(db: CommerceDatabase): Promise<void>;
  /**
   * Executes a serialized atomic Read -> Mutate -> Write transaction.
   * Prevents lost updates and race conditions under concurrent requests.
   * If `fn` throws, no changes are committed.
   */
  transact<T>(fn: (db: CommerceDatabase) => Promise<T> | T): Promise<T>;
  resetDemoData(): Promise<CommerceDatabase>;
  createBackupSnapshot(label?: string): Promise<BackupSnapshotInfo>;
  listBackupSnapshots(): Promise<BackupSnapshotInfo[]>;
  readBackupSnapshot(filename: string): Promise<CommerceDatabase>;
  restoreDatabase(nextDb: CommerceDatabase): Promise<CommerceDatabase>;
}

export function normalizeDatabaseSchema(parsed: CommerceDatabase): {
  db: CommerceDatabase;
  mutated: boolean;
} {
  let mutated = false;
  if (!parsed.auth) {
    parsed.auth = {};
    mutated = true;
  }

  const seed = createSeedDatabase(parsed.auth);

  if (!parsed.version || parsed.version < 2) {
    parsed.version = 2;
    mutated = true;
  }
  if (!parsed.nextPosReceiptSeq || !Number.isFinite(parsed.nextPosReceiptSeq)) {
    parsed.nextPosReceiptSeq = 10001;
    mutated = true;
  }
  if (!parsed.runtimeConfig) {
    parsed.runtimeConfig = seed.runtimeConfig;
    mutated = true;
  }
  if (!Array.isArray(parsed.auditLogs)) {
    parsed.auditLogs = [];
    mutated = true;
  }

  // Separate known seeded demo customers from real newly created customer profiles
  if (Array.isArray(parsed.customers)) {
    for (const c of parsed.customers) {
      if (SEEDED_DEMO_CUSTOMER_IDS.has(c.id) && c.isDemoFixture !== true) {
        c.isDemoFixture = true;
        mutated = true;
      }
    }
  } else {
    parsed.customers = seed.customers;
    mutated = true;
  }

  // Safely enrich existing catalog with barcodes / new weighted scale products if missing
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

  return { db: parsed, mutated };
}

export class InMemoryStorageAdapter implements CommerceStorageAdapter {
  private db: CommerceDatabase;
  private txQueue: Promise<void> = Promise.resolve();
  private backups: Array<{ info: BackupSnapshotInfo; data: CommerceDatabase }> = [];

  constructor(initial?: CommerceDatabase) {
    const base = initial ? structuredClone(initial) : createSeedDatabase();
    this.db = normalizeDatabaseSchema(base).db;
  }

  private runSerialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.txQueue.then(fn);
    this.txQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async read(): Promise<CommerceDatabase> {
    return this.runSerialized(async () => structuredClone(this.db));
  }

  async write(db: CommerceDatabase): Promise<void> {
    return this.runSerialized(async () => {
      this.db = structuredClone(db);
    });
  }

  async transact<T>(fn: (db: CommerceDatabase) => Promise<T> | T): Promise<T> {
    return this.runSerialized(async () => {
      const draft = structuredClone(this.db);
      const result = await fn(draft);
      this.db = draft;
      return result;
    });
  }

  async createBackupSnapshot(label = 'manual'): Promise<BackupSnapshotInfo> {
    return this.runSerialized(async () => {
      const cleanLabel = label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32) || 'manual';
      const now = new Date().toISOString();
      const stamp = now.replace(/[:.]/g, '-');
      const filename = `commerce_db.${cleanLabel}.${stamp}.json`;
      const payload = JSON.stringify(this.db, null, 2);
      const info: BackupSnapshotInfo = {
        filename,
        createdAt: now,
        sizeBytes: Buffer.byteLength(payload, 'utf8'),
        label: cleanLabel,
      };
      this.backups.unshift({ info, data: structuredClone(this.db) });
      if (this.backups.length > 25) this.backups.length = 25;
      this.db.lastBackupAt = now;
      return info;
    });
  }

  async listBackupSnapshots(): Promise<BackupSnapshotInfo[]> {
    return this.backups.map((b) => ({ ...b.info }));
  }

  async readBackupSnapshot(filename: string): Promise<CommerceDatabase> {
    const found = this.backups.find((b) => b.info.filename === filename);
    if (!found) {
      throw new Error('ملف النسخة الاحتياطية غير موجود');
    }
    return structuredClone(found.data);
  }

  async restoreDatabase(nextDb: CommerceDatabase): Promise<CommerceDatabase> {
    return this.runSerialized(async () => {
      const normalized = normalizeDatabaseSchema(structuredClone(nextDb)).db;
      this.db = normalized;
      return structuredClone(this.db);
    });
  }

  async resetDemoData(): Promise<CommerceDatabase> {
    return this.runSerialized(async () => {
      const auth = this.db.auth;
      const runtimeConfig = this.db.runtimeConfig;
      const fresh = createSeedDatabase(auth);
      if (runtimeConfig) {
        fresh.runtimeConfig = { ...runtimeConfig, updatedAt: new Date().toISOString() };
      }
      this.db = fresh;
      return structuredClone(this.db);
    });
  }
}

export class JsonFileStorageAdapter implements CommerceStorageAdapter {
  private readonly filePath: string;
  private readonly dataDir: string;
  private readonly backupsDir: string;
  private txQueue: Promise<void> = Promise.resolve();

  constructor(baseDir: string = process.cwd()) {
    this.dataDir = path.resolve(baseDir, 'data');
    this.backupsDir = path.resolve(this.dataDir, 'backups');
    this.filePath = path.resolve(this.dataDir, 'commerce_db.json');
    if (!this.filePath.startsWith(this.dataDir + path.sep)) {
      throw new Error('Invalid storage file path');
    }
  }

  private runSerialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.txQueue.then(fn);
    this.txQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private atomicWriteSync(db: CommerceDatabase): void {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(tempPath, this.filePath);
  }

  private ensureInitialized(): CommerceDatabase {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    if (!fs.existsSync(this.filePath)) {
      const seeded = createSeedDatabase();
      this.atomicWriteSync(seeded);
      return seeded;
    }
    const raw = fs.readFileSync(this.filePath, 'utf8');
    const parsed = JSON.parse(raw) as CommerceDatabase;
    if (!parsed || !Array.isArray(parsed.shops) || !Array.isArray(parsed.masterProducts)) {
      const seeded = createSeedDatabase();
      this.atomicWriteSync(seeded);
      return seeded;
    }

    const { db, mutated } = normalizeDatabaseSchema(parsed);
    if (mutated) {
      this.atomicWriteSync(db);
    }
    return db;
  }

  async read(): Promise<CommerceDatabase> {
    return this.runSerialized(async () => this.ensureInitialized());
  }

  async write(db: CommerceDatabase): Promise<void> {
    return this.runSerialized(async () => {
      this.atomicWriteSync(db);
    });
  }

  async transact<T>(fn: (db: CommerceDatabase) => Promise<T> | T): Promise<T> {
    return this.runSerialized(async () => {
      const current = this.ensureInitialized();
      const draft = structuredClone(current);
      const result = await fn(draft);
      this.atomicWriteSync(draft);
      return result;
    });
  }

  private writeSnapshotFileSync(db: CommerceDatabase, label: string): BackupSnapshotInfo {
    if (!fs.existsSync(this.backupsDir)) {
      fs.mkdirSync(this.backupsDir, { recursive: true });
    }
    const cleanLabel = label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32) || 'manual';
    const now = new Date().toISOString();
    const stamp = now.replace(/[:.]/g, '-');
    const filename = `commerce_db.${cleanLabel}.${stamp}.json`;
    const fullPath = path.resolve(this.backupsDir, filename);
    if (!fullPath.startsWith(this.backupsDir + path.sep)) {
      throw new Error('Invalid backup snapshot path');
    }
    const serialized = JSON.stringify(db, null, 2);
    fs.writeFileSync(fullPath, serialized, 'utf8');
    return {
      filename,
      createdAt: now,
      sizeBytes: Buffer.byteLength(serialized, 'utf8'),
      label: cleanLabel,
    };
  }

  async createBackupSnapshot(label = 'manual'): Promise<BackupSnapshotInfo> {
    return this.runSerialized(async () => {
      const current = this.ensureInitialized();
      const info = this.writeSnapshotFileSync(current, label);
      current.lastBackupAt = info.createdAt;
      this.atomicWriteSync(current);
      return info;
    });
  }

  async listBackupSnapshots(): Promise<BackupSnapshotInfo[]> {
    if (!fs.existsSync(this.backupsDir)) return [];
    const files = fs
      .readdirSync(this.backupsDir)
      .filter((f) => f.endsWith('.json') && !f.includes('..'));
    const list: BackupSnapshotInfo[] = [];
    for (const filename of files) {
      const fullPath = path.resolve(this.backupsDir, filename);
      if (!fullPath.startsWith(this.backupsDir + path.sep)) continue;
      const stat = fs.statSync(fullPath);
      const parts = filename.split('.');
      list.push({
        filename,
        createdAt: stat.mtime.toISOString(),
        sizeBytes: stat.size,
        label: parts.length >= 3 ? parts[1] : undefined,
      });
    }
    return list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 30);
  }

  async readBackupSnapshot(filename: string): Promise<CommerceDatabase> {
    if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
      throw new Error('اسم ملف النسخة الاحتياطية غير صالح');
    }
    const fullPath = path.resolve(this.backupsDir, filename);
    if (!fullPath.startsWith(this.backupsDir + path.sep) || !fs.existsSync(fullPath)) {
      throw new Error('ملف النسخة الاحتياطية غير موجود');
    }
    const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as CommerceDatabase;
    return normalizeDatabaseSchema(parsed).db;
  }

  async restoreDatabase(nextDb: CommerceDatabase): Promise<CommerceDatabase> {
    return this.runSerialized(async () => {
      const current = this.ensureInitialized();
      // Safety snapshot before restoring any backup
      this.writeSnapshotFileSync(current, 'pre_restore');
      const normalized = normalizeDatabaseSchema(structuredClone(nextDb)).db;
      this.atomicWriteSync(normalized);
      return normalized;
    });
  }

  async resetDemoData(): Promise<CommerceDatabase> {
    return this.runSerialized(async () => {
      const current = this.ensureInitialized();
      // Preserve safety snapshot before wiping demo/operational data
      this.writeSnapshotFileSync(current, 'pre_reset');
      const fresh = createSeedDatabase(current.auth);
      if (current.runtimeConfig) {
        fresh.runtimeConfig = {
          ...current.runtimeConfig,
          updatedAt: new Date().toISOString(),
        };
      }
      this.atomicWriteSync(fresh);
      return fresh;
    });
  }
}
