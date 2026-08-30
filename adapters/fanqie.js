"use strict";

/**
 * 番茄小说适配器，按 AS-CONTRACT.md 第 6 节 + WebServer/doc/FANQIE_API.md 实现。
 *
 * 链路：search → qkfqapi；getBookInfo/getCover → qkfqapi 详情；
 *       getCatalog → 官方 fanqienovel.com（无需认证）；getChapter → qkfqapi。
 * 关键约束：正文必须按章节目录的 item_id 请求，不能用书 ID。
 */

const { fetchText, fetchJson, fetchWithTimeout } = require("../lib/http");
const { RateLimiter } = require("../lib/ratelimiter");

const QKFQAPI = "https://qkfqapi.vv9v.cn";
const FANQIE = "https://fanqienovel.com";

// qkfqapi 保守 0.5 req/s；官方目录 1 req/s（AS-CONTRACT.md 第 6 节）
const limiter = new RateLimiter(0.5);
const officialLimiter = new RateLimiter(1);

const BROWSER_HEADERS = {
  Accept: "application/json, text/javascript, */*; q=0.01",
  "Accept-Language": "zh-CN,zh;q=0.9",
  Referer: "https://fanqienovel.com/",
  "X-Requested-With": "XMLHttpRequest",
};

// bookId -> { itemIds: [], titles: [], book: {...} } 缓存，避免重复请求目录
const catalogCache = new Map();
const detailCache = new Map();

/** 搜索：qkfqapi /api/v1/search，遍历 search_tabs[].data[].book_data */
async function search({ keyword, page }) {
  const url = `${QKFQAPI}/api/v1/search?query=${encodeURIComponent(keyword)}`;
  await limiter.acquire();
  const { body } = await fetchJson(url, {
    headers: BROWSER_HEADERS,
    // 0.5s 间隔，再加 15s 超时（契约兜底）
    timeout: 15000,
    retries: 1,
  });
  if (body.code !== 0) {
    throw new Error(`qkfqapi search failed: code=${body.code} message=${body.message}`);
  }
  const out = [];
  const tabs = Array.isArray(body.search_tabs) ? body.search_tabs : [];
  for (const tab of tabs) {
    if (!Array.isArray(tab.data)) continue;
    for (const item of tab.data) {
      // 实测：book_data 可能是对象（文档示例），也可能是数组（当前线上）
      const raw = item.book_data;
      const b = Array.isArray(raw) ? (raw[0] || {}) : raw;
      if (!b || !b.book_id) continue;
      out.push({
        sourceId: String(b.book_id),
        title: b.book_name,
        author: b.author,
        intro: b.abstract,
        cover: b.thumb_url || b.detail_page_thumb_url || "", // 搜索期若有封面直接给，AS 懒转存
        category: b.category,
        status: b.creation_status === 2 ? "已完结" : "连载中",
        lastUpdate: null,
        totalChapters: b.chapter_number ?? null,
        words: b.word_number ?? null,
      });
    }
  }
  return out;
}

/** 详情：qkfqapi /api/v1/books/{book_id}，补全元数据 + 封面 URL */
async function getBookInfo(sourceId) {
  const url = `${QKFQAPI}/api/v1/books/${sourceId}`;
  await limiter.acquire();
  const { body } = await fetchJson(url, { headers: BROWSER_HEADERS, timeout: 15000, retries: 1 });
  if (body.code !== 0) throw new Error(`qkfqapi book failed: code=${body.code}`);
  const d = body.data || {};
  detailCache.set(sourceId, d);
  return {
    title: d.book_name,
    author: d.author,
    intro: d.abstract,
    cover: d.thumb_url || d.detail_page_thumb_url || null,
    category: d.category,
    status: d.creation_status === 2 ? "已完结" : "连载中",
    lastUpdate: null,
    totalChapters: d.chapter_number ?? null,
    words: d.word_number ?? null,
  };
}

/**
 * 目录：官方 fanqienovel.com/api/reader/directory/detail?bookId={id}
 * data.allItemIds 顺序即章序；标题从 chapterListWithVolume（卷内章）按 itemId 对齐。
 */
async function getCatalog(sourceId) {
  const url = `${FANQIE}/api/reader/directory/detail?bookId=${sourceId}`;
  await officialLimiter.acquire();
  const res = await fetchText(url, {
    headers: { ...BROWSER_HEADERS, Referer: "https://fanqienovel.com/" },
    timeout: 15000,
    retries: 1,
  });
  let data;
  try {
    data = JSON.parse(res.text).data;
  } catch {
    throw new Error(`番茄目录接口返回非 JSON：${res.text.slice(0, 120)}`);
  }
  const itemIds = Array.isArray(data.allItemIds) ? data.allItemIds : [];
  // 标题表：itemId -> title
  const titleMap = new Map();
  const volumes = Array.isArray(data.chapterListWithVolume) ? data.chapterListWithVolume : [];
  for (const vol of volumes) {
    if (!Array.isArray(vol)) continue;
    for (const ch of vol) {
      if (ch && ch.itemId) {
        const t = (ch.title || "").trim();
        if (t) titleMap.set(String(ch.itemId), t);
      }
    }
  }
  const titles = itemIds.map((id, i) => titleMap.get(String(id)) || `第 ${i + 1} 章`);
  const catalog = itemIds.map((id, i) => ({ index: i, title: titles[i] }));
  catalogCache.set(sourceId, { itemIds: itemIds.map(String), titles });
  return catalog;
}

/**
 * 单章正文：qkfqapi /api/v1/chapters/{item_id}
 * item_id 来自 getCatalog 缓存的 allItemIds；content 是 HTML，按契约第 3 节清洗为纯文本段落。
 */
async function getChapter(sourceId, index, title) {
  const cached = catalogCache.get(sourceId);
  let itemId = cached && cached.itemIds[index];
  if (!itemId) {
    // 没走过 getCatalog 就直接请求目录（下载流程总会先 getCatalog，这里是兜底）
    await getCatalog(sourceId);
    const again = catalogCache.get(sourceId);
    itemId = again && again.itemIds[index];
  }
  if (!itemId) {
    throw new Error(`章节不存在：${sourceId}#${index}`);
  }
  const url = `${QKFQAPI}/api/v1/chapters/${itemId}`;
  await limiter.acquire();
  const { body } = await fetchJson(url, { headers: BROWSER_HEADERS, timeout: 15000, retries: 1 });
  if (body.code !== 0) {
    // 101004 表示 item_id 非法（很可能误用了书 ID）
    throw new Error(`qkfqapi chapter failed: code=${body.code} ${body.message || ""}`);
  }
  return cleanChapterContent((body.data || {}).content || "");
}

/**
 * 正文 HTML 清洗（FANQIE_API.md §4）→ 纯文本字符串（契约 3：章内 \n\n 合并成 <p>）。
 * 返回按段落拼接、以 \n\n 分隔的纯文本，book 侧在生成 EPUB 时切 <p>。
 */
function cleanChapterContent(html) {
  let s = String(html || "");
  // 1. 提取段落型 <p idx="\d+">...</p>；无则不切
  const paras = [];
  const re = /<p\b[^>]*>(.*?)<\/p>/gis;
  let m;
  while ((m = re.exec(s)) !== null) {
    paras.push(m[1]);
  }
  if (paras.length > 0) {
    s = paras.join("\n\n");
  }
  // 2. 删除音频注释块 {!-- PGC_VOICE:...--}
  s = s.replace(/\{!--[\s\S]*?--\}/g, "");
  // 3. 先去 header/footer，再剥剩余标签
  s = s
    .replace(/<\/?header[^>]*>/gi, "")
    .replace(/<\/?footer[^>]*>/gi, "")
    .replace(/<\/?article[^>]*>/gi, "");
  s = s.replace(/<[^>]+>/g, "");
  // 4. 转义还原
  s = s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&#160;/g, " ");
  // 5. 空行压缩 + 去首尾空白行（含行首残留的 &nbsp; 缩进实体）
  const lines = s
    .split(/\r?\n/)
    .map((l) => l.replace(/^(?:&nbsp;|&#160;|\s|\u00A0)+|(?:&nbsp;|&#160;|\s|\u00A0)+$/g, "").replace(/[ \t\u00A0]+/g, " ").trim())
    .filter((l) => l.length > 0);
  return lines.join("\n\n");
}

/** 封面：详情接口的 thumb_url，抓原始字节返回 Buffer */
async function getCover(sourceId) {
  let cover = null;
  if (detailCache.has(sourceId)) {
    const d = detailCache.get(sourceId);
    cover = d.thumb_url || d.detail_page_thumb_url;
  } else {
    const info = await getBookInfo(sourceId);
    cover = info.cover;
  }
  if (!cover) return null;
  const res = await fetchWithTimeout(cover, { timeout: 10000, retries: 1, headers: { Referer: "https://fanqienovel.com/" } });
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

module.exports = {
  id: "fanqie",
  name: "番茄小说",
  enabled: true,
  search,
  getBookInfo,
  getCatalog,
  getChapter,
  getCover,
};