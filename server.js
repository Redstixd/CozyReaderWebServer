"use strict";

const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");

const { loadConfig } = require("./lib/config");
const { loadAdapters, sourceList, getSource } = require("./lib/registry");
const { aggregateSearch, resolveSource } = require("./lib/search");
const { JobManager } = require("./lib/jobs");
const { fail, parseSearchParams, parseDownloadParams } = require("./lib/errors");
const { parseBody, logRequest } = require("./lib/util");

const VERSION = "0.1.0";
const SERVICE = "cozy-reader-as";

/** 统一写 JSON 信封 + CORS 头 */
function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(payload));
}

function ok(res, data, status = 200) {
  sendJson(res, status, { ok: true, data });
}

function err(res, e) {
  const status = e && e.status ? e.status : 500;
  const code = e && e.code ? e.code : "INTERNAL";
  const message = e && e.message ? e.message : "内部错误";
  const detail = e && e.detail ? e.detail : {};
  sendJson(res, status, { ok: false, error: { code, message, ...(Object.keys(detail).length ? { detail } : {}) } });
}

/**
 * 静态 EPUB 路径解析。
 * URL 段是 encodeURIComponent 后的 sourceId（可能含 %2F 等转义），文件路径也用同一编码段，
 * 天然防路径穿越（编码段不含真实斜杠）。
 */
function parseStaticBookPath(dataDir, source, encSourceId) {
  if (!/^[a-z0-9_]+$/.test(source)) throw fail("BAD_REQUEST", "source 非法");
  if (!encSourceId) throw fail("BAD_REQUEST", "sourceId 非法");
  const sourceId = decodeURIComponent(encSourceId);
  // 防穿越：解码后禁止路径分隔与回溯
  if (sourceId.includes(":") || sourceId.includes("\\") || sourceId.includes("..")) {
    throw fail("BAD_REQUEST", "sourceId 非法");
  }
  const rel = path.posix.join("books", source, encSourceId + ".epub");
  const abs = path.resolve(dataDir, rel);
  if (!abs.startsWith(path.resolve(dataDir) + path.sep)) throw fail("BAD_REQUEST", "路径非法");
  return { rel, abs };
}

const IMG_EXT = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  webp: "image/webp", gif: "image/gif", avif: "image/avif", bmp: "image/bmp",
};

/** 静态图片（契约 2.7：带缓存头） */
async function serveStaticImg(cfg, res, hash, ext) {
  if (!/^[0-9a-f]{40}$/.test(hash)) throw fail("BAD_REQUEST", "图片 hash 非法");
  const type = IMG_EXT[ext] || "image/jpeg";
  const file = path.join(cfg.dataDir, "imgs", `${hash}.${ext}`);
  if (!fs.existsSync(file)) throw fail("BOOK_NOT_FOUND", "图片不存在");
  const buf = await fs.promises.readFile(file);
  res.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": "public, max-age=86400, immutable",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(buf);
}

/** 静态 EPUB（契约 2.6） */
async function serveStaticEpub(cfg, res, source, sourceId) {
  const { rel, abs } = parseStaticBookPath(cfg.dataDir, source, sourceId);
  if (!fs.existsSync(abs)) throw fail("BOOK_NOT_FOUND", "书籍文件不存在");
  const buf = await fs.promises.readFile(abs);
  res.writeHead(200, {
    "Content-Type": "application/epub+zip",
    "Content-Length": buf.length,
    "Access-Control-Allow-Origin": "*",
  });
  res.end(buf);
}

function buildApp(cfg) {
  const adapters = loadAdapters(cfg);
  const jobs = new JobManager(cfg, adapters);
  const app = http.createServer(async (req, res) => {
    const start = Date.now();
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const p = url.pathname;

      // 预检：OPTIONS → 204，不经过业务逻辑（契约 1）
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        logRequest(req, 204, Date.now() - start);
        return;
      }

      // GET /health
      if (req.method === "GET" && p === "/health") {
        ok(res, {
          service: SERVICE,
          version: VERSION,
          time: new Date().toISOString(),
          sources: sourceList(adapters),
        });
        return;
      }

      // GET /api/sources
      if (req.method === "GET" && p === "/api/sources") {
        ok(res, sourceList(adapters));
        return;
      }

      // POST /api/search
      if (req.method === "POST" && p === "/api/search") {
        const body = await parseBody(req);
        const params = parseSearchParams(body);
        const data = await aggregateSearch(cfg, adapters, params);
        rememberSearchMeta(data.results);
        ok(res, data);
        return;
      }

      // POST /api/download
      if (req.method === "POST" && p === "/api/download") {
        const body = await parseBody(req);
        const { source, sourceId, refresh, from, to } = parseDownloadParams(body);
        const { jobId } = await jobs.create({ source, sourceId, refresh, from, to });
        ok(res, { jobId });
        return;
      }

      // GET /api/catalog?source=<id|name>&sourceId=<url> —— 返回目录供前端做部分下载弹窗
      if (req.method === "GET" && p === "/api/catalog") {
        const source = url.searchParams.get("source") || "";
        const sourceId = url.searchParams.get("sourceId") || "";
        const adapter = resolveSource(adapters, source) || getSource(adapters, source);
        if (!adapter) throw fail("SOURCE_NOT_FOUND", "书源不存在");
        const catalog = await adapter.getCatalog(sourceId);
        if (!Array.isArray(catalog)) throw fail("SOURCE_ERROR", "目录解析失败");
        const chapters = catalog.map((c) => ({ index: c.index, title: c.title || `第 ${c.index + 1} 章` }));
        ok(res, { source: adapter.id, sourceId, totalChapters: chapters.length, chapters });
        return;
      }

      // GET /api/jobs/{jobId}
      const mJob = p.match(/^\/api\/jobs\/(.+)$/);
      if (req.method === "GET" && mJob) {
        const job = jobs.get(decodeURIComponent(mJob[1]));
        ok(res, {
          jobId: job.jobId,
          status: job.status,
          progress: job.progress || { crawled: 0, total: 0 },
          epubUrl: job.epubUrl || null,
          error: job.error ? { code: job.error.code, message: job.error.message } : null,
          updated: job.updated ?? false,
          from: job.from ?? null,
          to: job.to ?? null,
        });
        return;
      }

      // GET /static/books/{source}/{sourceId}.epub
      const mBook = p.match(/^\/static\/books\/([^/]+)\/([^/]+)\.epub$/i);
      if (req.method === "GET" && mBook) {
        await serveStaticEpub(cfg, res, mBook[1], mBook[2]);
        return;
      }

      // GET /static/imgs/{hash}.{ext}
      const mImg = p.match(/^\/static\/imgs\/([0-9a-f]{40})\.([a-z0-9]+)$/i);
      if (req.method === "GET" && mImg) {
        await serveStaticImg(cfg, res, mImg[1].toLowerCase(), mImg[2].toLowerCase());
        return;
      }

      throw fail("NOT_FOUND", "接口不存在");
    } catch (e) {
      err(res, e);
    } finally {
      logRequest(req, res.statusCode || 200, Date.now() - start);
    }
  });
  return { app, adapters, jobs };
}

function main() {
  const cfg = loadConfig();
  const { app } = buildApp(cfg);
  // 确保数据目录存在
  fs.mkdirSync(path.join(cfg.dataDir, "books"), { recursive: true });
  fs.mkdirSync(path.join(cfg.dataDir, "imgs"), { recursive: true });
  app.listen(cfg.port, cfg.host, () => {
    console.log(`[${SERVICE} v${VERSION}] listening on http://${cfg.host}:${cfg.port}  dataDir=${cfg.dataDir}`);
  });
}

// search 聚合的结果供下载降级，复用 jobs 模块里的缓存函数
function rememberSearchMeta(results) {
  const { rememberSearchMeta: fn } = require("./lib/jobs");
  fn(results);
}

if (require.main === module) {
  main();
}

module.exports = { buildApp, main };