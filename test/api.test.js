"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");

const JSZip = require("jszip");
const { loadConfig } = require("../lib/config");
const { buildApp } = require("../server");

let server;
let base;
let dataDir;
let jobs;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cozyreader-as-"));
  const cfg = loadConfig();
  // 加速占位书抓取，避免 128 章 * 200ms 的长时间等待
  cfg.dataDir = dataDir;
  cfg.port = 0;
  cfg.crawl = {
    chapterConcurrency: 8,
    chapterIntervalMs: 1,
    chapterTimeoutMs: 15000,
    chapterRetries: 1,
    perSourceRate: 500,
  };
  const { app, jobs: jm } = buildApp(cfg);
  jobs = jm;
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** 小请求助手 */
function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const u = new URL(p, base);
    const r = http.request(
      u,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          let json = null;
          try { json = JSON.parse(text); } catch { /* 非 JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitDone(jobId, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await req("GET", `/api/jobs/${encodeURIComponent(jobId)}`);
    assert.strictEqual(r.status, 200, `poll job ${jobId} -> ${r.text}`);
    const job = r.json.data;
    if (job.status === "done" || job.status === "failed") return job;
    assert.ok(Date.now() < deadline, "job 超时未完成");
    await sleep(300);
  }
}

// ---- 1. /health ----
test("GET /health 返回服务信息与源列表", async () => {
  const r = await req("GET", "/health");
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual(r.json.data.service, "cozy-reader-as");
  assert.strictEqual(r.json.data.version, "0.1.0");
  const ids = r.json.data.sources.map((s) => s.id);
  assert.ok(ids.includes("fanqie"), "应包含 fanqie");
  assert.ok(ids.includes("placeholder"), "应包含 placeholder");
});

// ---- 2. OPTIONS 预检 ----
test("OPTIONS 预检返回 204 + CORS 头", async () => {
  const r = await req("OPTIONS", "/api/search");
  assert.strictEqual(r.status, 204);
  assert.strictEqual(r.headers["access-control-allow-origin"], "*");
  assert.strictEqual(r.headers["access-control-allow-methods"], "GET, POST, OPTIONS");
  assert.strictEqual(r.headers["access-control-allow-headers"], "Content-Type");
});

// ---- 3. /api/sources ----
test("GET /api/sources 返回源列表且带 enabled", async () => {
  const r = await req("GET", "/api/sources");
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ok, true);
  assert.ok(Array.isArray(r.json.data));
  const fanqie = r.json.data.find((s) => s.id === "fanqie");
  assert.ok(fanqie);
  assert.strictEqual(fanqie.enabled, true);
  assert.strictEqual(fanqie.name, "番茄小说");
});

// ---- 4. 搜索校验 ----
test("POST /api/search 缺 keyword 返回 400", async () => {
  const r = await req("POST", "/api/search", {});
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.error.code, "BAD_REQUEST");
});

test("POST /api/search 指定不存在的 source 返回 404", async () => {
  const r = await req("POST", "/api/search", { keyword: "斗破", source: "nope" });
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.json.error.code, "SOURCE_NOT_FOUND");
});

test("POST /api/search 走 placeholder 返回结果", async () => {
  const r = await req("POST", "/api/search", { keyword: "斗破", source: "placeholder" });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ok, true);
  const d = r.json.data;
  assert.strictEqual(d.keyword, "斗破");
  assert.strictEqual(d.page, 1);
  assert.strictEqual(d.hasMore, false);
  assert.ok(Array.isArray(d.results) && d.results.length > 0);
  const item = d.results[0];
  for (const k of ["bookId", "source", "sourceId", "title", "author", "intro", "category", "status", "lastUpdate", "totalChapters", "words"]) {
    assert.ok(k in item, `结果缺少字段 ${k}`);
  }
  assert.ok(item.bookId.startsWith("placeholder:"));
});

// ---- 5/6/7. 下载 → 轮询 → 拉回 EPUB 并校验 ----
test("placeholder 全链路：download → job 轮询 → 合法 EPUB", async () => {
  const d = await req("POST", "/api/download", { source: "placeholder", sourceId: "p1_0" });
  assert.strictEqual(d.status, 200, d.text);
  assert.strictEqual(d.json.ok, true);
  const jobId = d.json.data.jobId;
  assert.ok(jobId.startsWith("placeholder.p1_0."));

  const job = await waitDone(jobId);
  assert.ok(job.epubUrl, "done 任务应有 epubUrl");
  assert.ok(job.epubUrl.startsWith("/static/books/"));

  // 拉回 EPUB（用 http.get 拿 Buffer）
  const epubBuf = await new Promise((resolve, reject) => {
    const u = new URL(job.epubUrl, base);
    http.get(u, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
  assert.strictEqual(epubBuf.length > 100, true, "EPUB 有内容");
  // 解压校验（契约 3）
  const zip = await JSZip.loadAsync(epubBuf);
  const entryNames = Object.keys(zip.files);
  assert.strictEqual(entryNames[0], "mimetype", "mimetype 必须是第一个条目");
  const mime = zip.file("mimetype");
  assert.strictEqual(mime._data.compression.magic.charCodeAt(0), 0, "mimetype 必须 STORED");
  assert.strictEqual(await mime.async("string"), "application/epub+zip");
  const opf = await zip.file("OEBPS/content.opf").async("string");
  assert.ok(opf.includes(">placeholder:p1_0<"), "dc:identifier 应为 bookId");
  const spineCount = (opf.match(/<itemref/g) || []).length;
  assert.strictEqual(spineCount, 129, "spine = titles + 128 章");
});

test("EPUB 结构校验：mimetype 首个 STORED、totalChapters 与 spine 一致、章纯文本", async () => {
  // 直接调 buildEpub 验证（HTTP 侧已验过下载 200）
  const { buildEpub } = require("../lib/epub");
  const chapters = Array.from({ length: 5 }, (_, i) => ({
    title: `第 ${i + 1} 章`,
    text: `第 ${i + 1} 章的正文第一段。\n\n第二段 <script>alert(1)</script> 已转义。`,
  }));
  const meta = {
    bookId: "placeholder:p1_0", title: "测试书", author: "示例作者",
    date: "2026-08-29", source: "placeholder", sourceId: "p1_0",
    totalChapters: 5, status: "连载中", category: "测试", words: "5000",
  };
  const buf = await buildEpub(meta, chapters);
  const zip = await JSZip.loadAsync(buf);
  const entryNames = Object.keys(zip.files);
  assert.strictEqual(entryNames[0], "mimetype", "mimetype 必须是第一个条目");
  const mime = zip.file("mimetype");
  assert.strictEqual(mime._data.compression.magic.charCodeAt(0), 0, "mimetype 必须 STORED");
  assert.strictEqual(await mime.async("string"), "application/epub+zip");

  const opf = await zip.file("OEBPS/content.opf").async("string");
  assert.ok(opf.includes(">placeholder:p1_0<"), "dc:identifier 应为 bookId");
  assert.ok(opf.includes('property="totalChapters"'), "含 totalChapters meta");
  assert.ok(opf.includes(">5<"), "totalChapters 应为 5");
  // spine 顺序 = 章节顺序，共 6 项（titles + 5 章）
  const spineItems = [...opf.matchAll(/<itemref idref="ch(\d{4})"\/>/g)].map((m) => m[1]);
  assert.deepStrictEqual(spineItems, ["0001", "0002", "0003", "0004", "0005"]);
  // manifest id 命名 ch{index+1:04d}
  assert.ok(opf.includes('id="ch0001" href="chapters/0001.xhtml"'));
  assert.ok(opf.includes('id="ch0005" href="chapters/0005.xhtml"'));

  const ch1 = await zip.file("OEBPS/chapters/0001.xhtml").async("string");
  assert.ok(ch1.includes("<h1>第 1 章</h1>"), "章含 h1 标题");
  const pCount = (ch1.match(/<p>/g) || []).length;
  assert.strictEqual(pCount, 2, "两段正文 = 两个 <p>");
  assert.ok(ch1.includes("&lt;script&gt;"), "正文标签已转义");
  assert.ok(!/<script>/.test(ch1.replace("&lt;script&gt;", "")), "无原始 script 标签");

  const ncx = await zip.file("OEBPS/toc.ncx").async("string");
  const navPoints = (ncx.match(/<navPoint/g) || []).length;
  assert.strictEqual(navPoints, 5, "toc.ncx 应有 5 个 navPoint");

  const titles = await zip.file("OEBPS/titles.xhtml").async("string");
  assert.ok(titles.includes("测试书"), "书名页含书名");
});

// ---- 8. 缓存命中 ----
test("第二次 download 同书直接 done（命中缓存）", async () => {
  await waitDone((await req("POST", "/api/download", { source: "placeholder", sourceId: "p1_0" })).json.data.jobId);
  // 上面已完成 p1_0，这里再下一次：create 异步跑 _run，增量比对命中缓存 → done
  const d = await req("POST", "/api/download", { source: "placeholder", sourceId: "p1_0" });
  assert.strictEqual(d.status, 200, d.text);
  const job = await waitDone(d.json.data.jobId);
  assert.strictEqual(job.status, "done", "缓存命中应直接 done");
  assert.strictEqual(job.updated, false, "命中缓存 updated=false");
  assert.ok(job.epubUrl.endsWith("books/placeholder/p1_0.epub"));
  const file = path.join(dataDir, "books", "placeholder", "p1_0.epub");
  assert.ok(fs.existsSync(file), "EPUB 文件已落盘");
});

// ---- 9. 错误信封 ----
test("sourceId 含冒号被 400 拒绝", async () => {
  const r = await req("POST", "/api/download", { source: "placeholder", sourceId: "a:b" });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.error.code, "BAD_REQUEST");
});

test("下载不存在的 source 返回 404 SOURCE_NOT_FOUND", async () => {
  const r = await req("POST", "/api/download", { source: "nope", sourceId: "x" });
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.json.error.code, "SOURCE_NOT_FOUND");
});

test("查询不存在的 job 返回 404 JOB_NOT_FOUND", async () => {
  const r = await req("GET", "/api/jobs/foo.bar.deadbeef");
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.json.error.code, "JOB_NOT_FOUND");
});

test("静态 book 不存在返回 404 BOOK_NOT_FOUND", async () => {
  const r = await req("GET", "/static/books/placeholder/missing.epub");
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.json.error.code, "BOOK_NOT_FOUND");
});

// ---- 10. 抓取中断 → failed ----
test("抓取中断：目录为空 → job failed + SOURCE_ERROR", async () => {
  // 用 fanqie 的 getCatalog 强制抛错：临时替换 registry 里的 adapter
  const orig = jobs.adapters.get("placeholder");
  jobs.adapters.set("placeholder", {
    ...orig,
    async getCatalog() { throw new Error("目录解析失败(测试)"); },
  });
  try {
    const d = await req("POST", "/api/download", { source: "placeholder", sourceId: "failcase" });
    assert.strictEqual(d.status, 200, d.text);
    const j = await waitDone(d.json.data.jobId);
    // waitDone 遇 failed 会返回 job 本身（不再抛错）
    assert.strictEqual(j.status, "failed");
    assert.strictEqual(j.error.code, "SOURCE_ERROR");
  } finally {
    jobs.adapters.set("placeholder", orig);
  }
});

// ---- 11. 增量更新 ----
// 先用固定 128 章跑完一本，再覆盖 placeholder adapter 以可控地改变章数并记录 getChapter 调用。
async function downloadAndWait(source, sourceId, body) {
  const d = await req("POST", "/api/download", { source, sourceId, ...body });
  assert.strictEqual(d.status, 200, d.text);
  return waitDone(d.json.data.jobId);
}

test("增量更新：章节数相同 → 命中缓存 updated=false，不调 getChapter", async () => {
  // 先全量下载一本占位书（128 章）
  const first = await downloadAndWait("placeholder", "incr_same", { refresh: false });
  assert.strictEqual(first.status, "done");
  assert.strictEqual(first.updated, true, "首次下载应真抓");

  // 覆盖 adapter 记录 getChapter 调用，getCatalog 仍返回 128 章
  const orig = jobs.adapters.get("placeholder");
  let chapterCalls = 0;
  jobs.adapters.set("placeholder", {
    ...orig,
    async getChapter() { chapterCalls += 1; return "正文"; },
  });
  try {
    const second = await downloadAndWait("placeholder", "incr_same", { refresh: false });
    assert.strictEqual(second.status, "done");
    assert.strictEqual(second.updated, false, "章数相同应命中缓存");
    assert.strictEqual(chapterCalls, 0, "命中缓存不应调用 getChapter");
    assert.ok(second.epubUrl.endsWith("books/placeholder/incr_same.epub"));
  } finally {
    jobs.adapters.set("placeholder", orig);
  }
});

test("增量更新：章节数不同 → 全量重抓 updated=true", async () => {
  const first = await downloadAndWait("placeholder", "incr_diff", { refresh: false });
  assert.strictEqual(first.status, "done");
  assert.strictEqual(first.updated, true);

  // getCatalog 现在返回 130 章（比缓存多 2 章）→ 应重抓
  const orig = jobs.adapters.get("placeholder");
  jobs.adapters.set("placeholder", {
    ...orig,
    async getCatalog() {
      return Array.from({ length: 130 }, (_, i) => ({ index: i, title: `第 ${i + 1} 章` }));
    },
  });
  try {
    const second = await downloadAndWait("placeholder", "incr_diff", { refresh: false });
    assert.strictEqual(second.status, "done");
    assert.strictEqual(second.updated, true, "章数不同应重抓");
    assert.strictEqual(second.progress.total, 130, "重抓后的章数应为 130");
    // 新 EPUB 已落盘且 totalChapters 更新为 130
    const file = path.join(dataDir, "books", "placeholder", "incr_diff.epub");
    assert.ok(fs.existsSync(file), "新 EPUB 已落盘");
    const JSZip2 = require("jszip");
    const zip = await JSZip2.loadAsync(fs.readFileSync(file));
    const opf = await zip.file("OEBPS/content.opf").async("string");
    assert.ok(opf.includes('property="totalChapters">130<'), "重抓后 totalChapters=130");
  } finally {
    jobs.adapters.set("placeholder", orig);
  }
});

test("增量更新：强制刷新(refresh=true)即使章数相同也全量重抓 updated=true", async () => {
  const first = await downloadAndWait("placeholder", "incr_force", { refresh: false });
  assert.strictEqual(first.updated, true);

  // 章数不变（128），但 refresh=true → 强制重抓
  const orig = jobs.adapters.get("placeholder");
  let chapterCalls = 0;
  jobs.adapters.set("placeholder", {
    ...orig,
    async getChapter() { chapterCalls += 1; return "正文"; },
  });
try {
    const forced = await downloadAndWait("placeholder", "incr_force", { refresh: true });
    assert.strictEqual(forced.status, "done");
    assert.strictEqual(forced.updated, true, "ǿ��ˢ��Ӧ��ץ");
    assert.ok(chapterCalls >= 128, "ǿ��ˢ��Ӧ����ץȡȫ���½�");
  } finally {
    jobs.adapters.set("placeholder", orig);
  }
});

// ---- 增量：8. 按书源名搜索（前端书源标签传 name 而非 id） ----
test("POST /api/search 按书源名(source.name)筛选也能命中", async () => {
  // placeholder 的 name 是「占位书源」，id 是「placeholder」；前端标签传 name
  const r = await req("POST", "/api/search", { keyword: "斗破", source: "占位书源" });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.json.ok, true);
  assert.ok(Array.isArray(r.json.data.results) && r.json.data.results.length > 0);
  assert.strictEqual(r.json.data.results[0].source, "placeholder");
});

// ---- 增量：9. ranwen8 书源 @js: base64 混淆正文解码（用真实规则 DSL） ----
test("ranwen8 正文 @js: DSL 解 base64 混淆(document.writeln) 为纯文本", async () => {
  const { runJsDsl, cleanContent } = require("../lib/ruleadapter");
  const cheerio = require("cheerio");
  // 从 main.json 取 ranwen8 的真实规则，跑它真正的 @js: 程序
  const main = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "so-novel", "bundle", "rules", "main.json"), "utf-8")
  );
  const rule = main.find((r) => r.url.includes("ranwen8"));
  assert.ok(rule, "main.json 应含 ranwen8 规则");
  const dslMatch = String(rule.chapter.content).match(/@js:([\s\S]+)$/);
  assert.ok(dslMatch && dslMatch[1], "ranwen8 content 应带 @js: DSL");

  // 真实一章开头 base64 载荷：`<br />&nbsp;&nbsp;&nbsp;&nbsp;四人...`（含中文）
  const b64 =
    "PGJyIC8+Jm5ic3A7Jm5ic3A7Jm5ic3A7Jm5ic3A75Zub5Liq5Lq65pyA57uI5Zyo55Cq5Lqa5aic5Y+r5Zqj552A6KaB6L+95LiK5Y6755q";
  const innerHtml = "<br><script>document.writeln(qsbs.bb('" + b64 + "'));</script>";

  // 跑 ranwen8 真实 @js: 程序（内置 qsbs 解码器 + replace）
  const decoded = runJsDsl(dslMatch[1], innerHtml);
  assert.equal(decoded.includes("document.writeln"), false, "raw JS 应被解码掉");
  assert.equal(decoded.includes("qsbs.bb"), false, "base64 载荷应被解码");
  assert.ok(/[\u4e00-\u9fff]/.test(decoded), "解码后含中文正文");

  // 再经 cleanContent 用规则的 paragraphTag 切段，应只剩干净中文（无 <script>/&nbsp;）
  const text = cleanContent(decoded, rule.chapter);
  assert.equal(text.includes("<script"), false, "无 <script 残留");
  assert.equal(text.includes("&nbsp;"), false, "无裸 &nbsp; 实体");
  assert.match(text, /[\u4e00-\u9fff]/, "切段后为中文正文");
});

// ---- 12. 部分下载：目录接口 + 章节范围下载 ----
test("GET /api/catalog 返回目录章节列表（供部分下载弹窗）", async () => {
  const r = await req("GET", "/api/catalog?source=placeholder&sourceId=p1_0");
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.json.ok, true);
  const d = r.json.data;
  assert.strictEqual(d.source, "placeholder");
  assert.strictEqual(d.sourceId, "p1_0");
  assert.strictEqual(d.totalChapters, 128);
  assert.ok(Array.isArray(d.chapters) && d.chapters.length === 128);
  assert.strictEqual(d.chapters[0].index, 0);
  assert.ok(d.chapters[0].title, "章节应有标题");
});

test("部分下载：from/to 范围只抓该切片，EPUB 章数=切片长度", async () => {
  // 占位书目录 128 章，请求 [0..4] 共 5 章
  const job = await downloadAndWait("placeholder", "range_1", { from: 0, to: 4 });
  assert.strictEqual(job.status, "done");
  assert.strictEqual(job.from, 0, "job 应记录 from");
  assert.strictEqual(job.to, 4, "job 应记录 to");

  const epubBuf = await new Promise((resolve, reject) => {
    const u = new URL(job.epubUrl, base);
    http.get(u, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
  const zip = await JSZip.loadAsync(epubBuf);
  const opf = await zip.file("OEBPS/content.opf").async("string");
  const spineCount = (opf.match(/<itemref/g) || []).length;
  // titles.xhtml + 5 章 = 6
  assert.strictEqual(spineCount, 6, "spine = titles + 5 切片章");
  const tm = opf.match(/<meta property="totalChapters">(\d+)<\/meta>/);
  assert.strictEqual(tm ? Number(tm[1]) : 0, 5, "totalChapters 应为切片长度 5");
});

// ---- 13. 部分下载不得覆盖已缓存全书（数据丢失修复） ----
test("部分下载：全书已缓存时拒绝切片，且不覆盖已有全书", async () => {
  // 先全量下载一本占位书（128 章），落盘全书
  const full = await downloadAndWait("placeholder", "range_clobber", { refresh: false });
  assert.strictEqual(full.status, "done");
  assert.strictEqual(full.updated, true, "首次应真抓全书");
  const file = path.join(dataDir, "books", "placeholder", "range_clobber.epub");
  assert.ok(fs.existsSync(file), "全书已落盘");
  const before = fs.readFileSync(file);

  // 对同一 source/sourceId 发起部分下载 [0..4] → 应被拒绝，不得覆盖全书
  const partial = await downloadAndWait("placeholder", "range_clobber", { from: 0, to: 4 });
  assert.strictEqual(partial.status, "failed", "全书已缓存时部分下载应被拒绝");
  assert.strictEqual(partial.error.code, "BAD_REQUEST", "拒绝错误码应为 BAD_REQUEST");
  assert.ok(/全书|整本|增量/.test(partial.error.message), "错误信息应提示全书已缓存，请用整本/增量更新");

  // 全书文件必须未被覆盖（字节不变）
  const after = fs.readFileSync(file);
  assert.ok(before.equals(after), "已有全书不得被切片覆盖");
  const JSZip3 = require("jszip");
  const zip = await JSZip3.loadAsync(after);
  const opf = await zip.file("OEBPS/content.opf").async("string");
  const tm = opf.match(/<meta property="totalChapters">(\d+)<\/meta>/);
  assert.strictEqual(tm ? Number(tm[1]) : 0, 128, "全书 totalChapters 仍为 128");
});