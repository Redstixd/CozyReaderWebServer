"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { fail } = require("./errors");
const { compileRuleAdapter } = require("./ruleadapter");

/**
 * 适配器注册表：
 * 1. 加载 adapters/ 目录下每个 .js（契约 5.1：CommonJS，id 与文件名一致）
 * 2. 从 so-novel 的 bundle/rules/*.json 编译规则源（复用 so-novel 书源）
 *
 * enabled 可被 config.json 的 sources 覆盖（如 {"sources":{"fanqie":{"enabled":false}}}）
 */

function resolveDirs(cfg) {
  const root = path.join(__dirname, "..");
  return {
    adaptersDir: path.join(root, "adapters"),
    rulesDir: path.join(root, "so-novel", "bundle", "rules"),
  };
}

/** 规则 → adapter id：用域名主体（www.22biqu.com → 22biqu） */
function idFromUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host.replace(/[^a-z0-9]/g, "").slice(0, 32) || "rule";
  } catch {
    return "";
  }
}

function loadAdapters(cfg = {}) {
  const { adaptersDir, rulesDir } = resolveDirs(cfg);
  const map = new Map();

  // 1) adapters/ 目录
  if (fs.existsSync(adaptersDir)) {
    for (const f of fs.readdirSync(adaptersDir)) {
      if (!f.endsWith(".js")) continue;
      const file = path.join(adaptersDir, f);
      let mod;
      try {
        mod = require(file);
      } catch (e) {
        console.warn(`[registry] 加载适配器 ${f} 失败:`, e.message);
        continue;
      }
      const list = Array.isArray(mod) ? mod : [mod];
      for (const a of list) {
        register(map, a);
      }
    }
  }

  // 2) so-novel 规则源（复用 so-novel）
  // 默认只编译 main.json（大陆 IP 可用、无代理/CF 依赖的稳定源）；
  // 其余规则文件（proxy-required / rate-limit / no-search / cloudflare）需在 config.json
  // 的 `ruleFiles` 里显式开启，避免聚合搜索打到大量反爬源。
  const override = cfg.sources || {};
  // 默认只编译 main.json（大陆 IP 可用、无代理/CF 依赖的稳定源）；
  // 其余规则文件（proxy-required / rate-limit / no-search / cloudflare）需在 config.json
  // 的 `ruleFiles` 里显式开启，避免聚合搜索打到大量反爬源。
  const ruleFiles = Array.isArray(cfg.ruleFiles) ? cfg.ruleFiles : ["main.json"];
  for (const rf of ruleFiles) {
    let rules;
    try {
      rules = JSON.parse(fs.readFileSync(path.join(rulesDir, rf), "utf-8"));
    } catch {
      continue;
    }
    if (!Array.isArray(rules)) continue;
    for (const rule of rules) {
      if (!rule || rule.disabled) continue;
      const id = idFromUrl(rule.url);
      if (!id || map.has(id)) continue;
      const adapter = compileRuleAdapter(rule, id);
      if (override[id] && override[id].enabled === false) adapter.enabled = false;
      map.set(id, adapter);
    }
  }

  return map;
}

function register(map, adapter) {
  if (!adapter || typeof adapter !== "object") return;
  const id = String(adapter.id || "");
  if (!/^[a-z0-9_]+$/.test(id)) {
    console.warn(`[registry] 跳过非法 adapter id: ${JSON.stringify(adapter.id)}`);
    return;
  }
  if (map.has(id)) {
    console.warn(`[registry] 重复 adapter id: ${id}，跳过`);
    return;
  }
  // 校验契约 5.1 方法
  for (const m of ["search", "getBookInfo", "getCatalog", "getChapter"]) {
    if (typeof adapter[m] !== "function") {
      console.warn(`[registry] adapter ${id} 缺少方法 ${m}，仍注册（调用时兜底）`);
    }
  }
  map.set(id, adapter);
}

/** 聚合搜索用的启用源列表 */
function enabledSources(map) {
  return [...map.values()].filter((a) => a.enabled);
}

/** 列表（含 disabled，契约 2.2 返回 enabled 字段） */
function sourceList(map) {
  return [...map.values()].map((a) => ({ id: a.id, name: a.name || a.id, enabled: !!a.enabled }));
}

function getSource(map, source) {
  const a = map.get(String(source || ""));
  if (!a) throw fail("SOURCE_NOT_FOUND", "书源不存在");
  return a;
}

module.exports = { loadAdapters, enabledSources, sourceList, getSource, idFromUrl };