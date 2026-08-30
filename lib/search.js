"use strict";

const path = require("node:path");
const fs = require("node:fs");

const { fail } = require("./errors");
const { sha1Hex } = require("./util");

/**
 * 搜索聚合（契约 2.3）：
 *   - 多源并发搜索，单源失败跳过（全失败才报错）
 *   - 结果归一化 + bookId = source:sourceId
 *   - cover：懒转存——本地 imgs 缓存命中则返回 AS 地址，否则 ""（前端占位图，下载时再转存）
 */

const coverCache = new Map(); // url -> AS 地址（本进程内防重复 stat）

function isCoverCached(cfg, url) {
  if (!url) return "";
  if (coverCache.has(url)) return coverCache.get(url);
  const hash = sha1Hex(url);
  const exts = ["jpg", "jpeg", "png", "webp", "gif", "avif"];
  const dir = path.join(cfg.dataDir, "imgs");
  for (const ext of exts) {
    if (fs.existsSync(path.join(dir, `${hash}.${ext}`))) {
      const asUrl = `/static/imgs/${hash}.${ext}`;
      coverCache.set(url, asUrl);
      return asUrl;
    }
  }
  return "";
}

/** 归一化一条搜索结果（契约 2.3 results 字段），缺的补 null */
function normalizeResult(adapter, item) {
  const sourceId = item.sourceId != null ? String(item.sourceId) : "";
  return {
    bookId: `${adapter.id}:${sourceId}`,
    source: adapter.id,
    sourceId,
    title: item.title || "",
    author: item.author || "",
    intro: item.intro || "",
    cover: item.cover || "",
    category: item.category || "",
    status: item.status || "",
    lastUpdate: item.lastUpdate || null,
    totalChapters: item.totalChapters != null ? Number(item.totalChapters) : null,
    words: item.words != null ? Number(item.words) : null,
  };
}

/**
 * 执行聚合搜索。
 * @param {object} cfg
 * @param {Map<string,object>} adapters
 * @param {{keyword:string, source?:string, page:number}} params
 */
async function aggregateSearch(cfg, adapters, params) {
  const { keyword, page } = params;
  // 选源：指定 source 或全部启用源
  let sources;
  if (params.source) {
    const adapter = adapters.get(params.source);
    if (!adapter) throw fail("SOURCE_NOT_FOUND", "书源不存在");
    sources = [adapter];
  } else {
    sources = [...adapters.values()].filter((a) => a.enabled);
  }

  const results = [];
  const errors = [];
  // 单源搜索预算：超时的源跳过不阻塞聚合（稳定源通常 <2s，够用）
  const budget = cfg.searchTimeoutMs || 8000;
  await Promise.all(
    sources.map(async (adapter) => {
      try {
        const list = await Promise.race([
          adapter.search({ keyword, page }),
          new Promise((_, rej) =>
            setTimeout(() => rej(Object.assign(new Error("搜索超时"), { __budget: true })), budget)
          ),
        ]);
        if (!Array.isArray(list)) return;
        for (const item of list) {
          if (!item || item.sourceId == null) continue;
          const norm = normalizeResult(adapter, item);
          if (params.source) {
            // 单源：cover 走懒转存（命中缓存给 AS 地址）
            norm.cover = isCoverCached(cfg, norm.cover) || "";
          }
          results.push(norm);
        }
      } catch (e) {
        errors.push({ source: adapter.id, err: e });
      }
    })
  );

  // 单源失败 → 抛错；多源部分失败 → 记录日志，保留成功结果
  if (results.length === 0 && errors.length > 0) {
    const e = errors[0].err;
    if (errors.length === sources.length && sources.length === 1) {
      throw e;
    }
    throw fail("SOURCE_ERROR", "所有书源搜索失败", { errors: errors.map((x) => x.source) });
  }
  for (const x of errors) {
    console.warn(`[search] 书源 ${x.source} 搜索失败: ${x.err && x.err.message}`);
  }

  return { keyword, page, hasMore: false, results };
}

module.exports = { aggregateSearch, normalizeResult, isCoverCached };