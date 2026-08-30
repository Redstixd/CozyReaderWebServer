"use strict";

const path = require("node:path");
const fs = require("node:fs");

/**
 * AS 配置：环境变量 > config.json > 默认值。
 * 默认 data 目录、端口、限速等，对齐 AS-CONTRACT.md。
 */
const DEFAULT_CONFIG = {
  port: 7765,
  host: "0.0.0.0",
  dataDir: path.join(__dirname, "..", "data"),
  // 契约 4.4：源级令牌桶默认 5 req/s；单书抓章并发 2、间隔 200ms
  crawl: {
    chapterConcurrency: 2,
    chapterIntervalMs: 200,
    chapterTimeoutMs: 15000,
    chapterRetries: 1,
    perSourceRate: 5,
  },
  // 任务存活时间（契约 2.5：至少 24h）
  jobTtlMs: 24 * 60 * 60 * 1000,
  // 封面转存目录 hash 命名
  coverTimeoutMs: 10000,
  // 单源搜索预算（聚合搜索时超时的源跳过）
  searchTimeoutMs: 8000,
};

function loadConfig() {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  const configPath = path.join(__dirname, "..", "config.json");
  if (fs.existsSync(configPath)) {
    try {
      const user = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      Object.assign(cfg, user);
      cfg.crawl = Object.assign({}, DEFAULT_CONFIG.crawl, user.crawl || {});
    } catch (e) {
      console.warn("[config] 解析 config.json 失败，使用默认配置:", e.message);
    }
  }
  if (process.env.AS_PORT) cfg.port = Number(process.env.AS_PORT);
  if (process.env.AS_DATA_DIR) cfg.dataDir = process.env.AS_DATA_DIR;
  cfg.dataDir = path.resolve(cfg.dataDir);
  return cfg;
}

module.exports = { loadConfig, DEFAULT_CONFIG };