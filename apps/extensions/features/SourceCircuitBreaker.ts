/**
 * Source Circuit Breaker
 *
 * When a source starts hard-blocking (Cloudflare, IP ban, layout change), every call
 * still walks the full axios -> clearance warmup -> Playwright -> Puppeteer fallback
 * chain before failing — each attempt paying full browser-launch cost. ProxyManager's
 * cooldown doesn't help here when there's no proxy pool configured (the common case).
 *
 * This tracks consecutive failures per source and "opens" (short-circuits) after a
 * threshold, so calls fail fast for a cooldown window instead of repeating expensive
 * work that's very likely to fail again. A single success (including the first
 * half-open attempt after cooldown expires) closes the breaker again.
 */

import { getBreakerFailureThreshold, getBreakerCooldownMs } from '../config/source.config.js';

export interface CircuitBreakerStats {
  source: string;
  consecutiveFailures: number;
  isOpen: boolean;
  openRemainingMs: number;
}

interface BreakerEntry {
  consecutiveFailures: number;
  openUntil: number; // 0 = closed
}

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes

export class SourceCircuitBreaker {
  private state = new Map<string, BreakerEntry>();

  constructor(
    private failureThreshold: number = DEFAULT_FAILURE_THRESHOLD,
    private cooldownMs: number = DEFAULT_COOLDOWN_MS,
  ) {}

  /**
   * Remaining cooldown in ms if the breaker is currently open for this source, 0 if
   * closed (calls should proceed normally). Cooldown expiry is checked lazily here
   * (half-open: the next caller gets one attempt through) rather than on a timer.
   */
  getOpenRemainingMs(source: string): number {
    const entry = this.state.get(source);
    if (!entry || entry.openUntil === 0) {
      return 0;
    }

    const remaining = entry.openUntil - Date.now();
    if (remaining <= 0) {
      entry.openUntil = 0;
      entry.consecutiveFailures = 0;
      return 0;
    }

    return remaining;
  }

  recordSuccess(source: string): void {
    this.state.delete(source);
  }

  recordFailure(source: string): void {
    const entry = this.state.get(source) || { consecutiveFailures: 0, openUntil: 0 };
    entry.consecutiveFailures++;

    if (entry.consecutiveFailures >= this.failureThreshold) {
      entry.openUntil = Date.now() + this.cooldownMs;
    }

    this.state.set(source, entry);
  }

  getStats(): CircuitBreakerStats[] {
    const now = Date.now();
    return Array.from(this.state.entries()).map(([source, entry]) => ({
      source,
      consecutiveFailures: entry.consecutiveFailures,
      isOpen: entry.openUntil > now,
      openRemainingMs: Math.max(0, entry.openUntil - now),
    }));
  }

  setFailureThreshold(threshold: number): void {
    this.failureThreshold = threshold;
  }

  setCooldownMs(cooldownMs: number): void {
    this.cooldownMs = cooldownMs;
  }

  reset(source?: string): void {
    if (source) {
      this.state.delete(source);
    } else {
      this.state.clear();
    }
  }
}

let breakerInstance: SourceCircuitBreaker | null = null;

export function getSourceCircuitBreaker(): SourceCircuitBreaker {
  if (!breakerInstance) {
    breakerInstance = new SourceCircuitBreaker(
      getBreakerFailureThreshold(),
      getBreakerCooldownMs(),
    );
  }
  return breakerInstance;
}

export function resetSourceCircuitBreaker(): void {
  breakerInstance = null;
}
