"use strict";

/**
 * 令牌桶限速器，契约 4.4：单源抓书并发 ≤2；源级令牌桶限速（默认 5 req/s）。
 * 每次 acquire 会 await 直到桶里补充令牌。
 */
class RateLimiter {
  /**
   * @param {number} rate 每秒补充令牌数（req/s）
   * @param {number} [burst] 桶容量，默认 1，即平均间隔 1/rate 秒
   */
  constructor(rate, burst = 1) {
    this.rate = rate;
    this.capacity = burst;
    this.tokens = burst;
    this.last = Date.now();
  }

  async acquire() {
    // 没有限速需求时直接放行
    if (!this.rate || this.rate <= 0) return;
    // 补充令牌
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < 1) {
      const waitMs = ((1 - this.tokens) / this.rate) * 1000;
      await new Promise((r) => setTimeout(r, Math.ceil(waitMs)));
      this.tokens = Math.min(this.capacity, this.tokens + waitMs / 1000 * this.rate);
      this.last = Date.now();
    }
    this.tokens -= 1;
  }

  /** 同步检查当前是否可用（用于快速拒绝或日志） */
  tryAcquire() {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/** 源令牌桶表：按 adapter.id 取（懒建） */
class SourceLimiters {
  constructor(defaultRate = 5) {
    this.defaultRate = defaultRate;
    this.map = new Map();
  }
  get(sourceId) {
    if (!this.map.has(sourceId)) {
      this.map.set(sourceId, new RateLimiter(this.defaultRate));
    }
    return this.map.get(sourceId);
  }
  /** 为特定源显式设速率（如 fanqie 的 qkfqapi 0.5、官方 1 req/s） */
  configure(sourceId, rate, burst) {
    this.map.set(sourceId, new RateLimiter(rate, burst));
  }
}

module.exports = { RateLimiter, SourceLimiters };