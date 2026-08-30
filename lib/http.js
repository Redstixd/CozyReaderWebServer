"use strict";

const { fail, HTTP_STATUS } = require("./errors");
const { sleep } = require("./util");

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/**
 * 带超时的 fetch：AbortController 实现（契约 5.3：外层 15s 超时）
 *   - 网络错误 / DNS / 超时 → 抛 TIMEOUT（504）
 *   - HTTP >= 500 或连接类异常 → 允许重试（retries 次）
 *   - HTTP 429 → 指数退避 sleep(min(2**n, 10)) 后重试（FANQIE_API.md §1.3）
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.timeout=15000] 毫秒
 * @param {number} [opts.retries=0] 额外重试次数
 * @param {object} [opts.headers]
 * @param {object} [opts.retryOn429=true] 429 指数退避开关
 * @returns {Promise<Response>} 未 throw 的 Response（调用方负责 body 消耗）
 */
async function fetchWithTimeout(url, opts = {}) {
  const timeout = opts.timeout ?? 15000;
  const retries = opts.retries ?? 0;
  const retryOn429 = opts.retryOn429 ?? true;
  const headers = { "User-Agent": DEFAULT_UA, ...(opts.headers || {}) };
  const { rawResponse } = opts;

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    let res;
    try {
      res = await fetch(url, {
        method: opts.method || "GET",
        headers,
        body: opts.body,
        redirect: opts.redirect ?? "follow",
        signal: ctrl.signal,
      });
    } catch (err) {
      lastErr = err;
      clearTimeout(timer);
      // abort 是超时；ENOTFOUND/ECONNRESET 等视为网络错误——契约归为 TIMEOUT 大类
      if (attempt < retries && (err.name === "AbortError" || err.code === "ECONNRESET" || err.code === "ENOTFOUND" || err.code === "ETIMEDOUT")) {
        await sleep(300 * (attempt + 1));
        continue;
      }
      throw fail("TIMEOUT", "书源请求超时或网络不可达", { url, cause: String(err && err.message) });
    }
    clearTimeout(timer);

    if (res.status === 429 && retryOn429) {
      // 429 指数退避最小次数，最多 3 次（FANQIE_API.md §1.3）
      if (attempt < Math.max(retries, 3)) {
        const backoff = Math.min(2 ** (attempt + 1), 10);
        res.body?.cancel?.();
        await sleep(backoff * 1000);
        continue;
      }
    }
    if (res.status >= 500 && attempt < retries) {
      res.body?.cancel?.();
      await sleep(300 * (attempt + 1));
      continue;
    }
    return res;
  }
  // 理论上走不到；保险
  if (lastErr) throw fail("TIMEOUT", "书源请求失败", { cause: String(lastErr) });
  throw fail("SOURCE_ERROR", "书源请求失败");
}

/**
 * 抓文本：自动按 charset 解码（so-novel 系书源多为 GBK）。
 * 返回 {status, headers, text, buffer, url}
 */
async function fetchText(url, opts = {}) {
  const res = await fetchWithTimeout(url, opts);
  const buf = Buffer.from(await res.arrayBuffer());
  const { charsetFromContentType, decodeBuffer } = require("./util");
  const charset = opts.charset || charsetFromContentType(res.headers.get("content-type"), buf);
  return {
    status: res.status,
    headers: res.headers,
    text: decodeBuffer(buf, charset),
    buffer: buf,
    url: res.url || url,
  };
}

/** 抓 JSON：外包 {code, message, data...}；调用方自行判断 code 语义 */
async function fetchJson(url, opts = {}) {
  const res = await fetchWithTimeout(url, opts);
  const text = await res.text();
  if (res.ok) {
    try {
      return { status: res.status, body: JSON.parse(text), headers: res.headers };
    } catch {
      throw fail("SOURCE_ERROR", "书源返回非法 JSON", { url, preview: text.slice(0, 200) });
    }
  }
  throw fail("SOURCE_ERROR", `书源 HTTP ${res.status}`, { url, status: res.status });
}

module.exports = { fetchWithTimeout, fetchText, fetchJson, DEFAULT_UA };