(async () => {
  const { loadConfig } = require(process.cwd() + "/lib/config");
  const { loadAdapters } = require(process.cwd() + "/lib/registry");
  const { JobManager } = require(process.cwd() + "/lib/jobs");
  const cfg = loadConfig();
  cfg.dataDir = require("os").tmpdir() + "/as-debug-" + Date.now();
  const adapters = loadAdapters(cfg);
  const jobs = new JobManager(cfg, adapters);
  const { jobId, job } = await jobs.create({ source: "placeholder", sourceId: "smoke1" });
  console.log("jobId:", jobId, "status:", job.status);
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    const j = jobs.get(jobId);
    if (j.status === "done" || j.status === "failed") break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const j = jobs.get(jobId);
  console.log("final status:", j.status, "progress:", JSON.stringify(j.progress), "epubUrl:", j.epubUrl, "error:", JSON.stringify(j.error));
  const fs = require("fs"), path = require("path");
  const f = path.join(cfg.dataDir, "books", "placeholder", "smoke1.epub");
  console.log("file exists:", fs.existsSync(f), "size:", fs.existsSync(f) ? fs.statSync(f).size : 0);
})();