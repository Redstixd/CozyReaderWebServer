"use strict";

const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

const { fail } = require("./errors");
const { sleep } = require("./util");
const { buildEpub } = require("./epub");
const { mirrorCover, saveCoverBuffer } = require("./cover");
const { SourceLimiters } = require("./ratelimiter");

/**
 * 任务管理（契约 2.4/2.5/4.3/4.4）：
 *   - 任务在内存，重启丢任务 → JOB_NOT_FOUND 可接受（契约 1）
 *   - 同 bookId 并发去重：返回同一 jobId
 *   - 增量更新：!refresh 且缓存章数与最新目录一致 → 直接 done 返回现有 epubUrl（updated=false）
 *   - 否则全量重抓重打（updated=true）；refresh=true 强制全量
 *   - 抓书：getBookInfo → getCatalog → 封面转存 → 逐章（并发 2、间隔 200ms、
 *     单次 15s 超时、失败重试 1 次）→ 打 EPUB → 写 data/books/{source}/{sourceId}.epub
 *   - 任务至少存活 24h
 */

function shortId() {
  return crypto.randomBytes(2).toString("hex");
}

/** search 时的元数据缓存：bookId → SearchResult（download 时 getBookInfo 失败可降级） */
const searchMetaCache = new Map();

/** 记录一次搜索结果的元数据，供下载降级用 */
function rememberSearchMeta(results) {
  for (const r of results || []) {
    if (!r || !r.bookId) continue;
    searchMetaCache.set(r.bookId, r);
  }
  if (searchMetaCache.size > 2000) {
    const oldest = searchMetaCache.keys().next().value;
    if (oldest !== undefined) searchMetaCache.delete(oldest);
  }
}

class JobManager {
  constructor(cfg, adapters) {
    this.cfg = cfg;
    this.adapters = adapters; // Map<id, adapter>
    this.jobs = new Map(); // jobId -> job
    this.activeByBook = new Map(); // bookId -> jobId （running/queued 去重）
    this.limiters = new SourceLimiters(cfg.crawl.perSourceRate || 5);
    this._startSweeper();
  }

  _startSweeper() {
    const ttl = this.cfg.jobTtlMs || 24 * 60 * 60 * 1000;
    this._sweeper = setInterval(() => {
      const now = Date.now();
      for (const [jobId, job] of this.jobs) {
        if (now - job.createdAt > ttl) {
          this.jobs.delete(jobId);
          if (this.activeByBook.get(job.bookId) === jobId) this.activeByBook.delete(job.bookId);
        }
      }
    }, Math.max(ttl / 6, 60_000));
    this._sweeper.unref?.();
  }

  /**
   * 发起下载任务。
   * @param {string} source
   * @param {string} sourceId
   * @param {boolean} refresh
   * @returns {{jobId:string, job:object}}
   */
  async create({ source, sourceId, refresh }) {
    const adapter = this.adapters.get(source);
    if (!adapter) throw fail("SOURCE_NOT_FOUND", "书源不存在");

    const bookId = `${source}:${sourceId}`;
    // sourceId 可能含 "/"（HTML 书源的详情页路径，如 /novel/7515/）。
    // 统一 encodeURIComponent 后再用于文件路径与 URL，保证静态路由解析一致。
    const encSourceId = encodeURIComponent(sourceId);
    const epubRel = `books/${source}/${encSourceId}.epub`;
    const epubFile = path.join(this.cfg.dataDir, epubRel);
    const epubUrl = `/static/${epubRel.replace(/\\/g, "/")}`;
    const hasCache = fs.existsSync(epubFile);

    // 去重：已有 running/queued 任务直接返回同一 jobId
    const existingId = this.activeByBook.get(bookId);
    if (existingId && this.jobs.has(existingId)) {
      const ex = this.jobs.get(existingId);
      if (ex.status === "running" || ex.status === "queued") {
        return { jobId: ex.jobId, job: ex };
      }
    }

    const job = this._newJob({ source, sourceId, bookId });
    this.jobs.set(job.jobId, job);
    this.activeByBook.set(bookId, job.jobId);

    // 异步执行，不阻塞响应
    this._run(job, adapter, { refresh, epubFile, epubUrl, hasCache }).catch((err) => {
      // 兜底：确保 job 落到 failed
      if (job.status !== "done") {
        job.status = "failed";
        job.error = toErrorEnvelope(err);
        job.updatedAt = Date.now();
      }
      this.activeByBook.delete(bookId);
    });

    return { jobId: job.jobId, job };
  }

  _newJob({ source, sourceId, bookId }) {
    const jobId = `${source}.${sourceId}.${shortId()}`;
    return {
      jobId,
      bookId,
      source,
      sourceId,
      status: "queued",
      progress: { crawled: 0, total: 0 },
      epubUrl: null,
      error: null,
      updated: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  get(jobId) {
    const job = this.jobs.get(String(jobId || ""));
    if (!job) throw fail("JOB_NOT_FOUND", "任务不存在或已过期");
    return job;
  }

  async _run(job, adapter, { refresh, epubFile, epubUrl, hasCache }) {
    job.status = "running";
    job.updatedAt = Date.now();
    const limiter = this.limiters.get(job.source);
    try {
      // 4.3.3 getBookInfo 拿元信息；失败降级用 search 缓存
      let info = null;
      try {
        info = await this._call(adapter.getBookInfo, [job.sourceId]);
      } catch (e) {
        console.warn(`[job ${job.jobId}] getBookInfo 失败，降级: ${e.message}`);
        info = null;
      }
      if (!info) info = searchMetaCache.get(job.bookId) || {};
      const meta = normalizeInfo(info);

      // 4.3.4 getCatalog 拿目录
      const catalog = await this._call(adapter.getCatalog, [job.sourceId]);
      if (!Array.isArray(catalog) || catalog.length === 0) {
        throw new Error("目录为空或解析失败");
      }
      const total = catalog.length;
      job.progress.total = total;

      // 增量更新：非强制刷新且已有缓存时，比对章节数——相同直接命中缓存（不重抓）
      if (!refresh && hasCache) {
        const cached = await readEpubProgress(epubFile); // {crawled, total}
        if (cached.total > 0 && cached.total === total) {
          job.status = "done";
          job.epubUrl = epubUrl;
          job.progress = { crawled: cached.total, total };
          job.updated = false;
          job.updatedAt = Date.now();
          return; // finally 会清除 activeByBook
        }
      }

      // 4.3.5 封面转存（getCover 或 info.cover URL）→ meta 用 AS 地址
      let coverAsUrl = "";
      try {
        if (typeof adapter.getCover === "function") {
          const buf = await this._call(adapter.getCover, [job.sourceId], 10000);
          if (buf && buf.length) {
            coverAsUrl = await saveCoverBuffer(this.cfg, buf, `${job.sourceId}:cover`);
          }
        }
        if (!coverAsUrl && info.cover) {
          coverAsUrl = await mirrorCover(this.cfg, info.cover);
        }
      } catch {
        coverAsUrl = "";
      }

      // 4.3.6 逐章抓取：并发 2、间隔 200ms、单次 15s 超时、失败重试 1 次；更新 progress
      const chapters = new Array(total);
      let next = 0;
      let crawled = 0;
      const worker = async () => {
        for (;;) {
          const i = next++;
          if (i >= total) return;
          const item = catalog[i];
          await limiter.acquire();
          let text;
          try {
            text = await this._call(adapter.getChapter, [job.sourceId, item.index ?? i, item.title]);
          } catch (e) {
            // 章节级失败：整本失败（契约 4.3.9 已抓正文丢弃）
            throw new SourceJobError(e);
          }
          if (typeof text !== "string") text = "";
          chapters[i] = { title: item.title || `第 ${i + 1} 章`, text };
          crawled += 1;
          job.progress.crawled = crawled;
          job.updatedAt = Date.now();
          if (i < total - 1) await sleep(this.cfg.crawl.chapterIntervalMs || 200);
        }
      };
      await Promise.all(Array.from({ length: this.cfg.crawl.chapterConcurrency || 2 }, worker));

      // 4.3.7 打 EPUB 并写盘
      const epubBuf = await buildEpub(
        {
          bookId: job.bookId,
          title: meta.title || job.sourceId,
          author: meta.author || "",
          date: meta.lastUpdate || null,
          source: job.source,
          sourceId: job.sourceId,
          totalChapters: total,
          status: meta.status || "",
          category: meta.category || "",
          words: meta.words != null ? String(meta.words) : "",
          cover: coverAsUrl,
        },
        chapters
      );
      await fs.promises.mkdir(path.dirname(epubFile), { recursive: true });
      await fs.promises.writeFile(epubFile, epubBuf);

      job.status = "done";
      job.epubUrl = epubUrl;
      job.progress = { crawled: total, total };
      job.updated = true;
      job.updatedAt = Date.now();
    } catch (e) {
      job.status = "failed";
      job.error = toErrorEnvelope(e);
      job.updatedAt = Date.now();
    } finally {
      this.activeByBook.delete(job.bookId);
    }
  }

  /** 适配器方法兜底：15s 超时（AbortController 交给内部 fetch），失败重试 1 次（契约 5.3） */
  async _call(fn, args, timeoutMs) {
    const to = timeoutMs || this.cfg.crawl.chapterTimeoutMs || 15000;
    let lastErr;
    for (let attempt = 0; attempt <= (this.cfg.crawl.chapterRetries ?? 1); attempt++) {
      try {
        const p = Promise.resolve(fn(...args));
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), to);
        try {
          return await Promise.race([
            p,
            new Promise((_, rej) => ctrl.signal.addEventListener("abort", () => rej(timeoutError()), { once: true })),
          ]);
        } finally {
          clearTimeout(timer);
        }
      } catch (e) {
        lastErr = e;
        if (attempt < (this.cfg.crawl.chapterRetries ?? 1)) {
          await sleep(300 * (attempt + 1));
        }
      }
    }
    throw lastErr;
  }
}

class SourceJobError extends Error {}

function timeoutError() {
  const e = new Error("超时");
  e.code = "TIMEOUT";
  return e;
}

/** 从已缓存的 EPUB 读取 totalChapters（用于缓存命中的任务进度） */
async function readEpubProgress(epubFile) {
  try {
    const JSZip = require("jszip");
    const zip = await JSZip.loadAsync(fs.readFileSync(epubFile));
    const opf = await zip.file("OEBPS/content.opf").async("string");
    const m = opf.match(/<meta property="totalChapters">(\d+)<\/meta>/);
    const total = m ? Number(m[1]) : 0;
    return { crawled: total, total };
  } catch {
    return { crawled: 0, total: 0 };
  }
}

/** 归一化 BookInfo / SearchResult（契约 5.2） */
function normalizeInfo(info) {
  return {
    title: info.title || "",
    author: info.author || "",
    intro: info.intro || "",
    cover: info.cover || "",
    category: info.category || "",
    status: info.status || "",
    lastUpdate: info.lastUpdate || null,
    totalChapters: info.totalChapters ?? null,
    words: info.words ?? null,
  };
}

/** 错误 → 契约错误信封（2.8 状态码表） */
function toErrorEnvelope(e) {
  if (e && e.code === "TIMEOUT") {
    return { code: "TIMEOUT", message: e.message || "抓源超时", detail: {} };
  }
  if (e && e.code && ["BAD_REQUEST", "SOURCE_NOT_FOUND", "JOB_NOT_FOUND", "BOOK_NOT_FOUND", "INTERNAL"].includes(e.code)) {
    return { code: e.code, message: e.message, detail: e.detail || {} };
  }
  return { code: "SOURCE_ERROR", message: e && e.message ? e.message : "书源请求失败", detail: {} };
}

module.exports = { JobManager, rememberSearchMeta, toErrorEnvelope, normalizeInfo };