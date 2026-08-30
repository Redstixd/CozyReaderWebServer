"use strict";

/**
 * 把 so-novel 的 rules/*.json 书源规则（CSS 选择器 DSL）编译成 AS-CONTRACT.md 5.1 的 adapter。
 *
 * 复用了 so-novel 的规则语义（SearchParser / TocParser / ChapterParser / HtmlExtractor）：
 *   - 选择器取属性：`sel@href` / `sel@src` / `meta[...]`（content）自动识别
 *   - POST form 搜索体：`{searchkey: %s}` 里的 %s 用 keyword 替换
 *   - 章节正文清洗：filterTxt 正则删除、filterTag 整元素删除、
 *     paragraphTagClosed / paragraphTag 切段落
 *   - 自动检测 GBK/UTF-8 编码（so-novel 系书源多为 GBK）
 *   - search 分页 / toc 分页 / chapter 分页（按规则逐页拉取）
 */

const { fetchWithTimeout } = require("./http");
const { decodeBuffer, charsetFromContentType } = require("./util");
const cheerio = require("cheerio");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// 章节地址缓存：sourceId -> [{ title, url }]，getCatalog 阶段填充，getChapter 阶段读取
const chapterUrlCache = new Map();

/** 剥离 @后缀，返回纯 CSS 选择器 */
function stripSuffix(q) {
  if (!q) return "";
  const at = String(q).indexOf("@");
  return (at > 0 ? String(q).slice(0, at) : String(q)).trim();
}

/** 从 query 推断提取类型：@href / @src / meta[…] → 属性，否则文本 */
function contentTypeOf(q) {
  if (!q) return "text";
  if (q.includes("@href")) return "attr:href";
  if (q.includes("@src")) return "attr:src";
  if (String(q).trim().startsWith("meta[")) return "attr:content";
  return "text";
}

/**
 * 在 cheerio 上下文里按 query 取第一个匹配元素的提取值。
 * $ctx 可以是 cheerio 函数（文档根）也可以是 cheerio 元素对象。
 */
function extractOne($ctx, query) {
  const q = String(query || "").trim();
  if (!q) return "";
  const sel = stripSuffix(q);
  const type = contentTypeOf(q);
  const found = typeof $ctx === "function" ? $ctx(sel) : $ctx.find(sel);
  const el = found.first();
  if (!el || el.length === 0) return "";
  switch (type) {
    case "attr:href":
      return el.attr("href") || "";
    case "attr:src":
      return el.attr("src") || "";
    case "attr:content":
      return el.attr("content") || "";
    default:
      return el.text() || "";
  }
}

/** 相对 URL 解析成绝对 URL */
function absUrl(base, href) {
  if (!href) return "";
  try {
    return new URL(href, base).toString();
  } catch {
    return "";
  }
}

/**
 * 拉取页面并自动按 charset 解码 → cheerio 根
 */
async function fetchDocument(url, opts = {}) {
  const res = await fetchWithTimeout(url, {
    timeout: opts.timeout || 15000,
    retries: opts.retries ?? 1,
    headers: { ...opts.headers, "User-Agent": UA, Referer: opts.referer || undefined },
  });
  const buf = Buffer.from(await res.arrayBuffer());
  if (res.status >= 400) {
    throw new Error(`书源 HTTP ${res.status}: ${url}`);
  }
  const charset = opts.charset || charsetFromContentType(res.headers.get("content-type"), buf);
  const html = decodeBuffer(buf, charset);
  return cheerio.load(html, { decodeEntities: false });
}

/**
 * 清洗单行：剥除行首尾的 nbsp 实体/原始 NBSP 与空白，并压缩行内连续空白。
 * decodeEntities:false 时 cheerio 不解码 &nbsp;，源站常用它做段首缩进，
 * 必须显式剥掉，否则会原样进入 EPUB（契约 3：正文只放纯文本）。
 */
function cleanLine(s) {
  return String(s || "")
    .replace(/^(?:&nbsp;|&#160;|\s)+|(?:&nbsp;|&#160;|\s)+$/g, "")
    .replace(/[ \t\u00A0]+/g, " ")
    .trim();
}

/**
 * 清洗正文 HTML → 纯文本字符串（段落间用 \n\n 分隔）。
 * 对齐 so-novel ChapterParser + ChapterRenderer 语义。
 *
 * 注意：入参 html 是 extractHtmlContent 按 r.content 提取的 innerHTML 片段，
 * 所以这里直接对整个片段操作（不再按 r.content 二次选择）。
 */
function cleanContent(html, rule) {
  const r = rule || {};
  const $ = cheerio.load(html || "");
  if (r.filterTag) {
    $(r.filterTag).remove();
  }
  let paras = [];
  if (r.paragraphTagClosed) {
    // <p>…</p> 形式：每个直接子元素为一段
    $("body").children().each(function () {
      const t = cleanLine($(this).text());
      if (t) paras.push(t);
    });
    if (paras.length === 0) {
      paras = $("body").text().split(/\n{2,}/).map(cleanLine).filter(Boolean);
    }
  } else if (r.paragraphTag) {
    // <br>+ 等分隔符：替换成换行再剥标签
    let replaced;
    try {
      replaced = $("body").html().replace(new RegExp("(" + r.paragraphTag + ")", "gi"), "\n\n");
    } catch {
      replaced = $("body").html();
    }
    const txt = String(replaced || "").replace(/<[^>]+>/g, "");
    paras = txt.split(/\n{2,}/).map(cleanLine).filter(Boolean);
  } else {
    const txt = $("body").text() || "";
    paras = txt.split(/\n{2,}/).map(cleanLine).filter(Boolean);
  }
  let text = paras.join("\n\n");
  if (r.filterTxt) {
    try {
      text = text.replace(new RegExp(r.filterTxt, "g"), "");
    } catch {
      /* 非法正则忽略 */
    }
  }
  return text.split(/\n{2,}/).map(cleanLine).filter(Boolean).join("\n\n");
}

/**
 * POST 表单：把规则 data 字符串解析成对象。
 * 注意：不在这里替换 %s——保持占位符，由 doSearch 用真实 keyword 替换。
 */
function buildFormData(dataStr) {
  const raw = String(dataStr || "").trim();
  const obj = {};
  if (!raw) return obj;
  const inner = raw.replace(/^\{/, "").replace(/\}$/, "");
  // 简易解析 {k1: v1, k2: v2}（值里可能出现逗号/引号，这里按逗号分隔后匹配）
  for (const part of inner.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
    const m = part.match(/\s*([^:]+)\s*:\s*(.*?)\s*$/);
    if (m) {
      const k = m[1].trim().replace(/^["']|["']$/g, "");
      const v = m[2].trim().replace(/^["']|["']$/g, "");
      obj[k] = v;
    }
  }
  return obj;
}

/**
 * 取 content 选择器的 innerHTML，并处理 so-novel 的 @java:base64.decode() DSL：
 * 提取 document.writeln(qsbs.bb('...')) 里的 base64 串拼接解码（顶点小说等站点的正文混淆）。
 */
function extractHtmlContent($doc, contentSel) {
  const q = String(contentSel || "").trim();
  if (!q) return "";
  const sel = stripSuffix(q);
  const needsBase64 = q.includes("base64");
  const el = $doc(sel);
  if (!el || el.length === 0) return "";
  let html = el.html() || "";
  if (needsBase64) {
    const parts = [];
    const re = /qsbs\.bb\('([^']+)'\)/g;
    let m;
    while ((m = re.exec(html)) !== null) parts.push(m[1]);
    if (parts.length > 0) {
      html = parts.map((p) => Buffer.from(p, "base64").toString("utf8")).join("\n\n");
    }
  }
  return html;
}

/**
 * 编译 so-novel 规则为一个 AS adapter。
 * @param {object} rule so-novel 规则对象
 * @param {string} [forceId] 强制 adapter id（[a-z0-9_]）
 */
function compileRuleAdapter(rule, forceId) {
  const r = rule || {};
  const name = String(r.name || "");
  let id =
    forceId ||
    name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 24) ||
    "rule";
  if (!/^[a-z0-9_]+$/.test(id)) id = "rule" + id.replace(/[^a-z0-9_]/g, "").slice(0, 20);

  const siteUrl = (r.url || "").trim();
  const search = r.search || {};
  const book = r.book || {};
  const toc = r.toc || {};
  const chapter = r.chapter || {};

  const buildSearchData = buildFormData(search.data || "");

  async function doSearch(keyword) {
    if (!search.url || !search.result || !search.bookName) return [];
    let url = search.url.includes("%s") ? search.url.replace("%s", encodeURIComponent(keyword)) : search.url;
    const method = (search.method || "GET").toUpperCase();
    let $root;
    if (method === "POST") {
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(buildSearchData)) {
        form.append(k, String(v).includes("%s") ? String(v).replace("%s", keyword) : v);
      }
      const res = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: siteUrl || url,
          "User-Agent": UA,
        },
        body: form.toString(),
        timeout: 15000,
        retries: 1,
      });
      const buf = Buffer.from(await res.arrayBuffer());
      if (res.status >= 400) throw new Error(`搜索页 HTTP ${res.status}`);
      const charset = charsetFromContentType(res.headers.get("content-type"), buf);
      $root = cheerio.load(decodeBuffer(buf, charset), { decodeEntities: false });
    } else {
      $root = await fetchDocument(url, { retries: 1, timeout: 15000 });
    }

    const resultSel = stripSuffix(search.result);
    const items = $root(resultSel);
    const results = [];
    items.each((_, el) => {
      const $el = $root(el);
      const title = extractOne($el, search.bookName);
      if (!title) return;
      const href = extractOne($el, search.bookName + "@href");
      if (!href) return;
      results.push({
        sourceId: href, // 相对/绝对 URL 存为 sourceId，下载时用 siteUrl 解析
        title: title.trim(),
        author: (search.author ? extractOne($el, search.author) : "").trim(),
        intro: "",
        cover: "",
        category: (search.category ? extractOne($el, search.category) : "").trim(),
        status: (search.status ? extractOne($el, search.status) : "").trim(),
        lastUpdate: (search.lastUpdateTime ? extractOne($el, search.lastUpdateTime) : "").trim() || null,
        totalChapters: null,
        words: (search.wordCount ? extractOne($el, search.wordCount) : "").trim() || null,
      });
    });
    return results;
  }

  /** 详情页：返回 { $doc, info, detailUrl } */
  async function getBookDetail(sourceId) {
    const detailUrl = absUrl(siteUrl, sourceId);
    const $doc = await fetchDocument(detailUrl, { retries: 1, timeout: 15000 });
    const metaOf = (sel) => $doc(sel).first().attr("content") || "";
    const pick = (ruleKey, ogKey) => {
      if (book[ruleKey]) return extractOne($doc, book[ruleKey]);
      return metaOf(`meta[property="og:novel:${ogKey}"]`) || "";
    };
    const info = {
      title: book.bookName ? extractOne($doc, book.bookName) : pick("", "book_name"),
      author: book.author ? extractOne($doc, book.author) : metaOf('meta[property="og:novel:author"]'),
      intro: book.intro
        ? extractOne($doc, book.intro)
        : metaOf('meta[property="og:description"]') || $doc("#intro").first().text().trim(),
      cover: book.coverUrl ? extractOne($doc, book.coverUrl) : metaOf('meta[property="og:image"]'),
      category: book.category ? extractOne($doc, book.category) : metaOf('meta[property="og:novel:category"]'),
      status: book.status ? extractOne($doc, book.status) : metaOf('meta[property="og:novel:status"]'),
      latestChapter: pick("latestChapter", "lastest_chapter_name"),
      lastUpdate: book.lastUpdateTime
        ? extractOne($doc, book.lastUpdateTime)
        : metaOf('meta[property="og:novel:update_time"]'),
      totalChapters: null,
      words: null,
    };
    return { $doc, info, detailUrl };
  }

  const adapter = {
    id,
    name: name || id,
    enabled: !r.disabled,
    siteUrl,

    /** 搜索 */
    async search({ keyword }) {
      return doSearch(keyword);
    },

    /** 元信息补全（失败返回 null，AS 降级用搜索时的信息） */
    async getBookInfo(sourceId) {
      try {
        const { info } = await getBookDetail(sourceId);
        return info;
      } catch {
        return null;
      }
    },

    /** 目录 */
    async getCatalog(sourceId) {
      const detailUrl = absUrl(siteUrl, sourceId);
      // 从详情页 URL 用 book.url 正则提取 id（so-novel TocParser 语义）
      let id = null;
      if (book.url) {
        try {
          const m = detailUrl.match(new RegExp(book.url));
          if (m && m[1]) id = m[1];
        } catch {
          /* 非法正则忽略 */
        }
      }
      // 目录页 URL：toc.url 存在则用 id 构造，否则目录就在详情页
      let tocUrl = detailUrl;
      if (toc.url && id) {
        const t = toc.url.includes("%s") ? toc.url.replace("%s", encodeURIComponent(id)) : toc.url;
        tocUrl = absUrl(siteUrl, t);
      }
      // baseUri：解析相对章节链接的基准
      let tocBase = tocUrl;
      if (toc.baseUri && id) {
        const b = toc.baseUri.includes("%s") ? toc.baseUri.replace("%s", encodeURIComponent(id)) : toc.baseUri;
        if (b) tocBase = absUrl(siteUrl, b);
      }
      const $doc = await fetchDocument(tocUrl, { retries: 1, timeout: 15000 });
      const itemSel = stripSuffix(toc.item);
      const catalog = [];
      $doc(itemSel).each((_, el) => {
        const $el = $doc(el);
        const title = $el.text().trim();
        const href = $el.attr("href") || "";
        const chapterUrl = absUrl(tocBase, href);
        if (!title || !chapterUrl) return;
        catalog.push({ index: catalog.length, title, url: chapterUrl });
      });

      // toc 分页（下拉菜单 / 下一页）
      if (toc.nextPage) {
        const pages = [];
        const nextSel = stripSuffix(toc.nextPage);
        $doc(nextSel).each((_, el) => {
          const v = $doc(el).attr("value") || $doc(el).attr("href") || "";
          const u = absUrl(tocUrl, v);
          if (u && u !== tocUrl) pages.push(u);
        });
        for (const u of pages) {
          const $doc2 = await fetchDocument(u, { retries: 1 });
          $doc2(itemSel).each((_, el) => {
            const title = $doc2(el).text().trim();
            const href = $doc2(el).attr("href") || "";
            const chapterUrl = absUrl(u, href);
            if (title && chapterUrl) catalog.push({ index: catalog.length, title, url: chapterUrl });
          });
        }
      }

      chapterUrlCache.set(sourceId, catalog.map((c) => ({ title: c.title, url: c.url })));
      return catalog.map((c) => ({ index: c.index, title: c.title }));
    },

    /** 单章正文 */
    async getChapter(sourceId, index) {
      const cached = chapterUrlCache.get(sourceId);
      const item = cached && cached[index];
      if (!item || !item.url) throw new Error(`章节地址缺失: ${sourceId}#${index}`);
      const $doc = await fetchDocument(item.url, { retries: 1, timeout: 15000 });
      const contentHtml = extractHtmlContent($doc, chapter.content);
      if (!contentHtml) throw new Error(`正文为空: ${item.url}`);
      return cleanContent(contentHtml, chapter);
    },

    /** 封面：详情页 og:image 或规则 coverUrl */
    async getCover(sourceId) {
      try {
        const { info } = await getBookDetail(sourceId);
        if (!info.cover) return null;
        const res = await fetchWithTimeout(info.cover, { timeout: 10000, retries: 1, headers: { "User-Agent": UA } });
        if (!res.ok) return null;
        return Buffer.from(await res.arrayBuffer());
      } catch {
        return null;
      }
    },
  };

  return adapter;
}

module.exports = {
  compileRuleAdapter,
  cleanContent,
  extractOne,
  absUrl,
  buildFormData,
  fetchDocument,
  stripSuffix,
  contentTypeOf,
  extractHtmlContent,
};