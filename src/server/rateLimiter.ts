import type { Request } from 'express';

interface BucketRecord {
  timestamps: number[];
}

/**
 * In-memory sliding-window rate limiter to protect authentication, QR gates,
 * PIN verification, and public order tracking routes from brute-force & scraping.
 */
export class SlidingWindowRateLimiter {
  private buckets = new Map<string, BucketRecord>();
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  consume(key: string): { allowed: boolean; retryAfterSec: number; remaining: number } {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const record = this.buckets.get(key) ?? { timestamps: [] };
    record.timestamps = record.timestamps.filter((t) => t > cutoff);

    if (record.timestamps.length >= this.maxRequests) {
      const oldest = record.timestamps[0] ?? now;
      const retryAfterSec = Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
      this.buckets.set(key, record);
      return { allowed: false, retryAfterSec, remaining: 0 };
    }

    record.timestamps.push(now);
    this.buckets.set(key, record);

    // Occasional cleanup to avoid unbounded memory growth
    if (this.buckets.size > 4000) {
      for (const [k, v] of this.buckets.entries()) {
        if (v.timestamps.length === 0 || v.timestamps[v.timestamps.length - 1] <= cutoff) {
          this.buckets.delete(k);
        }
      }
    }

    return {
      allowed: true,
      retryAfterSec: 0,
      remaining: Math.max(0, this.maxRequests - record.timestamps.length),
    };
  }

  resetAll(): void {
    this.buckets.clear();
  }
}

export function extractClientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) {
    return fwd.split(',')[0].trim();
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
}
