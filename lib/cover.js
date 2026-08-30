"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { sha1Hex } = require("./util");
const { fetchWithTimeout } = require("./http");

/**
 * 封面转存（契约 4.5）：
 *   - 源给封面 URL → 抓取 → data/imgs/{sha1(url)}.{ext} → 返回 AS 地址
 *   - 失败不阻断：返回空串，前端占位图
 */

function extFromUrl(url) {
  try {
    const p = new URL(url).pathname.toLowerCase();
    const m = p.match(/\.(jpe?g|png|webp|gif|avif|bmp)$/);
    return m ? m[1] : "jpg";
  } catch {
    return "jpg";
  }
}

function extFromBuffer(buf) {
  if (!buf || buf.length < 4) return "jpg";
  // magic bytes 嗅探
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return "webp";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "gif";
  return "jpg";
}

/** 转存封面 URL → AS 地址；已存在直接返回 */
async function mirrorCover(cfg, url) {
  if (!url) return "";
  const hash = sha1Hex(url);
  const ext = extFromUrl(url);
  const asPath = `/static/imgs/${hash}.${ext}`;
  const file = path.join(cfg.dataDir, "imgs", `${hash}.${ext}`);
  if (fs.existsSync(file)) return asPath;
  try {
    const res = await fetchWithTimeout(url, {
      timeout: cfg.coverTimeoutMs || 10000,
      retries: 0,
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) return "";
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf || buf.length === 0) return "";
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, buf);
    return asPath;
  } catch {
    return "";
  }
}

/** 保存已抓到的封面 Buffer（getCover 返回的字节）→ AS 地址 */
async function saveCoverBuffer(cfg, buf, salt) {
  if (!buf || buf.length === 0) return "";
  const ext = extFromBuffer(buf);
  const hash = sha1Hex(salt || buf.subarray(0, 4096));
  const asPath = `/static/imgs/${hash}.${ext}`;
  const file = path.join(cfg.dataDir, "imgs", `${hash}.${ext}`);
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, buf);
    return asPath;
  } catch {
    return "";
  }
}

module.exports = { mirrorCover, saveCoverBuffer, extFromUrl, extFromBuffer };