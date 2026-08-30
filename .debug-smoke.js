const http = require("http");
const base = "http://127.0.0.1:7788";
const req = (m, p, body) => new Promise((res, rej) => {
  const data = body ? JSON.stringify(body) : null;
  const r = http.request(new URL(p, base), { method: m, headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {} }, (x) => {
    const c = [];
    x.on("data", (k) => c.push(k));
    x.on("end", () => {
      const t = Buffer.concat(c).toString("utf8");
      try { res({ s: x.statusCode, h: x.headers, j: JSON.parse(t), t }); }
      catch { res({ s: x.statusCode, h: x.headers, j: null, t }); }
    });
  });
  r.on("error", rej);
  if (data) r.write(data);
  r.end();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const checks = [];
  const h = await req("GET", "/health");
  checks.push(["health", h.s === 200 && h.j.ok === true && h.j.data.service === "cozy-reader-as"]);
  const pre = await req("OPTIONS", "/api/search");
  checks.push(["preflight 204+CORS", pre.s === 204 && pre.h["access-control-allow-origin"] === "*"]);
  const s = await req("GET", "/api/sources");
  checks.push(["sources has fanqie", s.s === 200 && s.j.data.some((x) => x.id === "fanqie")]);
  // 搜索
  const search = await req("POST", "/api/search", { keyword: "斗破", source: "placeholder" });
  checks.push(["search placeholder", search.s === 200 && search.j.data.results.length > 0]);
  // 下载（默认配置 128 章约 13s，轮询 40s）
  const d = await req("POST", "/api/download", { source: "placeholder", sourceId: "smoke2" });
  const jid = d.j.data.jobId;
  let job = null;
  for (let i = 0; i < 200; i++) {
    const poll = await req("GET", "/api/jobs/" + encodeURIComponent(jid));
    job = poll.j.data;
    if (job.status === "done" || job.status === "failed") break;
    await sleep(200);
  }
  checks.push(["download->poll->done", job && job.status === "done" && !!job.epubUrl]);
  const epub = await req("GET", job.epubUrl);
  checks.push(["epub 200+ct", epub.s === 200 && epub.h["content-type"] === "application/epub+zip" && epub.t.length > 100]);
  // 缓存命中：二次下载立即 done
  const d2 = await req("POST", "/api/download", { source: "placeholder", sourceId: "smoke2" });
  const j2 = (await req("GET", "/api/jobs/" + encodeURIComponent(d2.j.data.jobId))).j.data;
  checks.push(["cache hit done", j2.status === "done" && j2.epubUrl !== null]);
  // 错误信封
  const bad = await req("POST", "/api/download", { source: "placeholder", sourceId: "a:b" });
  checks.push(["sourceId colon 400", bad.s === 400 && bad.j.error.code === "BAD_REQUEST"]);
  const nj = await req("GET", "/api/jobs/nope.nope.0000");
  checks.push(["job not found 404", nj.s === 404 && nj.j.error.code === "JOB_NOT_FOUND"]);
  const nf = await req("GET", "/static/books/placeholder/missing.epub");
  checks.push(["book not found 404", nf.s === 404 && nf.j.error.code === "BOOK_NOT_FOUND"]);
  let ok = 0;
  for (const [n, r] of checks) { console.log((r ? "PASS" : "FAIL") + " " + n); if (r) ok++; }
  console.log("== " + ok + "/" + checks.length + " smoke passed ==");
})();