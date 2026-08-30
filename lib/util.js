"use strict";

const crypto = require("node:crypto");

/** 返回 UTC ISO 时间（用于健康检查 time 字段，契约 2.1） */
function nowISO() {
  return new Date().toISOString();
}

/** YYYY-MM-DD（契约：lastUpdate 用 YYYY-MM-DD 字符串） */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/** sha1 十六进制，用于封面转存命名 data/imgs/{sha1(url)}.{ext}（契约 4.5） */
function sha1Hex(input) {
  return crypto.createHash("sha1").update(String(input)).digest("hex");
}

/** 从 header/响应推断 Content-Type 里的 charset；缺省 utf-8 */
function charsetFromContentType(contentType, bodyBuffer) {
  const ct = String(contentType || "").toLowerCase();
  const m = ct.match(/charset\s*=\s*"?([a-z0-9_\-]+)"?/i);
  if (m) return m[1];
  // 无 charset 头时，用 BOM / 前 4KB 试探（so-novel 系书源大多是 GBK）
  if (!bodyBuffer) return "utf-8";
  const head = bodyBuffer.subarray(0, 4096);
  // UTF-8 有效编码占比粗判
  return looksUtf8(head) ? "utf-8" : "gbk";
}

function looksUtf8(buf) {
  // 用 TextDecoder 的 fatal 判定是否为合法 UTF-8
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/** 把 Buffer / 视具体 charset 解码成字符串 */
function decodeBuffer(buf, charset) {
  const iconv = require("iconv-lite");
  const enc = (charset || "utf-8").toLowerCase().replace(/[-_]/g, "");
  if (enc === "utf8" || enc === "utf") {
    return buf.toString("utf-8");
  }
  if (iconv.encodingExists(enc)) {
    try {
      return iconv.decode(buf, enc);
    } catch {
      /* fallthrough */
    }
  }
  return buf.toString("utf-8");
}

/** 简单的请求体解析：JSON；当 Content-Type 是 form，返回 query-like 对象 */
async function parseBody(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const e = new Error("请求体过大");
      e.status = 400;
      throw e;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf-8");
  const ct = String(req.headers["content-type"] || "").toLowerCase();
  if (ct.includes("application/json") || raw.startsWith("{")) {
    try {
      return JSON.parse(raw);
    } catch {
      const e = new Error("JSON 解析失败");
      e.status = 400;
      throw e;
    }
  }
  // form-urlencoded → 简单解析成对象
  const out = {};
  for (const pair of raw.split("&")) {
    const [k, v] = pair.split("=");
    if (k) out[decodeURIComponent(k)] = decodeURIComponent(v || "");
  }
  return out;
}

/** 卡路径穿越：解析到 data 根目录内为 true（与 so-novel BookDownloadServlet 同理） */
function isSafeInside(baseDir, relPath) {
  const path = require("node:path");
  const resolved = path.resolve(baseDir, relPath);
  return resolved === baseDir || resolved.startsWith(baseDir + path.sep);
}

/** 每秒一行日志：ts method path status ms（契约 4.6） */
function logRequest(req, status, ms) {
  const ts = new Date().toISOString();
  console.log(`${ts} ${req.method} ${req.url} ${status} ${ms}`);
}

/** 适配器调用时的人为随机延迟，用于速率控制（min..max 毫秒） */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  nowISO,
  today,
  sha1Hex,
  charsetFromContentType,
  decodeBuffer,
  parseBody,
  isSafeInside,
  logRequest,
  sleep,
};