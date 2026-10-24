/** Random delays and human-like interaction patterns to avoid detection. */

import { DelayConfig } from '../config/anon.config.js';
import { getLogger } from './DetectionLogger.js';

export class HumanBehavior {
  private config: DelayConfig;
  private requestTimestamps: number[] = [];

  constructor(config: DelayConfig) {
    this.config = config;
  }

  private gaussianRandom(mean: number, stdDev: number): number {
    let u = 0,
      v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();

    const num = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    return num * stdDev + mean;
  }

  /**
   * Get randomized delay within range using gaussian distribution
   */
  getRandomizedDelay(min: number, max: number): number {
    const mean = (min + max) / 2;
    const stdDev = (max - min) / 4;
    const delay = this.gaussianRandom(mean, stdDev);
    return Math.max(min, Math.min(max, Math.round(delay)));
  }

  async randomDelay(): Promise<void> {
    const delay = this.getRandomizedDelay(this.config.minRequestDelay, this.config.maxRequestDelay);
    await this.sleep(delay);
  }

  async pageLoadDelay(): Promise<void> {
    const delay = this.getRandomizedDelay(
      this.config.pageLoadDelay.min,
      this.config.pageLoadDelay.max,
    );
    await this.sleep(delay);
  }

  async scrollDelay(): Promise<void> {
    const delay = this.getRandomizedDelay(this.config.scrollDelay.min, this.config.scrollDelay.max);
    await this.sleep(delay);
  }

  async clickDelay(): Promise<void> {
    const delay = this.getRandomizedDelay(this.config.clickDelay.min, this.config.clickDelay.max);
    await this.sleep(delay);
  }

  checkBurstLimit(): boolean {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;

    this.requestTimestamps = this.requestTimestamps.filter((ts) => ts > oneMinuteAgo);

    return this.requestTimestamps.length >= this.config.burstProtection.maxRequestsPerMinute;
  }

  async waitForBurstProtection(): Promise<void> {
    if (this.checkBurstLimit()) {
      getLogger().warn(
        `[HumanBehavior] Burst limit reached, cooling down for ${this.config.burstProtection.cooldownMs}ms`,
      );
      await this.sleep(this.config.burstProtection.cooldownMs);
      this.requestTimestamps = [];
    }
  }

  recordRequest(): void {
    this.requestTimestamps.push(Date.now());
  }

  getRequestsInLastMinute(): number {
    const oneMinuteAgo = Date.now() - 60000;
    return this.requestTimestamps.filter((ts) => ts > oneMinuteAgo).length;
  }

  /**
   * Simulate human-like scroll behavior on a page
   * @param page Puppeteer or Playwright page
   */
  async humanScroll(page: { evaluate: (fn: () => Promise<void>) => Promise<void> }): Promise<void> {
    await page.evaluate(async () => {
      // Runs in the page, not in Node.
      const totalHeight = document.body.scrollHeight;
      const viewportHeight = window.innerHeight;
      let scrolled = 0;

      while (scrolled < totalHeight) {
        const scrollAmount = Math.floor(Math.random() * (viewportHeight / 2)) + viewportHeight / 4;
        window.scrollBy(0, scrollAmount);
        scrolled += scrollAmount;
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 200 + 100));
      }
    });
  }

  /**
   * Simulate human-like mouse movement (Puppeteer-specific)
   */
  async humanMouseMove(
    page: {
      mouse: {
        move: (x: number, y: number, options?: { steps: number }) => Promise<void>;
      };
      viewport: () => { width: number; height: number } | null;
    },
    targetX: number,
    targetY: number,
  ): Promise<void> {
    const viewport = page.viewport();
    if (!viewport) return;

    const startX = Math.floor(Math.random() * viewport.width);
    const startY = Math.floor(Math.random() * viewport.height);

    const steps = Math.floor(Math.random() * 10) + 10;

    for (let i = 0; i <= steps; i++) {
      const progress = i / steps;
      // Slight sinusoidal curve so the path isn't a straight line.
      const curve = Math.sin(progress * Math.PI) * 20;

      const x = startX + (targetX - startX) * progress + curve;
      const y = startY + (targetY - startY) * progress;

      await page.mouse.move(x, y, { steps: 2 });
      await this.sleep(Math.random() * 20 + 10);
    }
  }

  /**
   * Simulate human-like typing with variable delays
   */
  async humanType(
    page: {
      type: (selector: string, text: string, options?: { delay: number }) => Promise<void>;
    },
    selector: string,
    text: string,
  ): Promise<void> {
    const averageDelay = 50 + Math.random() * 100;
    await page.type(selector, text, { delay: averageDelay });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  updateConfig(config: Partial<DelayConfig>): void {
    this.config = {
      ...this.config,
      ...config,
      pageLoadDelay: {
        ...this.config.pageLoadDelay,
        ...config.pageLoadDelay,
      },
      scrollDelay: {
        ...this.config.scrollDelay,
        ...config.scrollDelay,
      },
      clickDelay: {
        ...this.config.clickDelay,
        ...config.clickDelay,
      },
      burstProtection: {
        ...this.config.burstProtection,
        ...config.burstProtection,
      },
    };
  }
}

let behaviorInstance: HumanBehavior | null = null;

export function getHumanBehavior(config?: DelayConfig): HumanBehavior {
  if (!behaviorInstance && config) {
    behaviorInstance = new HumanBehavior(config);
  }
  if (!behaviorInstance) {
    behaviorInstance = new HumanBehavior({
      minRequestDelay: 500,
      maxRequestDelay: 2500,
      pageLoadDelay: { min: 1000, max: 3000 },
      scrollDelay: { min: 100, max: 500 },
      clickDelay: { min: 50, max: 200 },
      burstProtection: {
        maxRequestsPerMinute: 30,
        cooldownMs: 60000,
      },
    });
  }
  return behaviorInstance;
}

export function resetHumanBehavior(): void {
  behaviorInstance = null;
}
