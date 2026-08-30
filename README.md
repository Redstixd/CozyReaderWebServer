# CozyReader · 聚合服务器 (AS)

CozyReader 的后端聚合服务：搜索聚合、抓全文、打包 EPUB 3、静态托管、磁盘缓存。
严格按 [`AS-CONTRACT.md`](../AS-CONTRACT.md) 实现，前端对应契约见
[`READER-CONTRACT.md`](../READER-CONTRACT.md)。

> ⚠️ **克隆后必须手动补齐书源规则（否则只剩 2 个书源）**
>
> 绝大多数书源来自 `so-novel/bundle/rules/*.json`（编译自 so-novel 规则仓库）。
> 该目录是**被复用的上游仓库，已 .gitignore，** **不上传到 GitHub**。因此从
> GitHub 克隆本仓库后，`so-novel/bundle/rules/` 是**空的**，服务器只会加载
> `adapters/` 下的 2 个书源（`fanqie` + `placeholder`），聚合搜索缺 11 个规则书源。
>
> 补齐步骤：把本机/上游的 `so-novel` 仓库拷回 `WebServer/so-novel`，使
> `WebServer/so-novel/bundle/rules/main.json` 存在即可（`config.json` 默认
> `ruleFiles: ["main.json"]` 加载其中 11 个大陆可用源）。补齐后重启 `npm start`，
> `GET /api/sources` 应返回全部 13 个书源。

## 快速开始

```bash
npm install
npm start        # 默认 0.0.0.0:7765，可用 AS_PORT 覆盖
```

## 目录结构

```
WebServer/
  server.js            # 入口：HTTP 路由 + CORS + 错误信封 + 日志
  lib/
    config.js          # 配置加载（config.json / 环境变量）
    errors.js          # 错误码→状态码表（契约 2.8）
    http.js            # 带超时/重试/429 退避的 fetch 封装
    ratelimiter.js     # 令牌桶限速（契约 4.4）
    registry.js        # 适配器注册表
    cover.js           # 封面转存（契约 4.5）
    epub.js            # EPUB 3 生成（jszip，mimetype 首个 STORED）
    jobs.js            # 任务管理（去重、并发 2、间隔 200ms、进度、24h TTL）
    search.js          # 多源搜索聚合
    ruleadapter.js     # so-novel 规则编译器（复用其 rules/*.json）
  adapters/
    placeholder.js     # 占位书源（契约 5.4）
    fanqie.js          # 番茄小说（契约第 6 节 + doc/FANQIE_API.md）
  so-novel/            # 被复用的书源规则仓库（rules/main.json 等）
  data/
    books/{source}/{sourceId}.epub
    imgs/{hash}.{ext}
```

## 适配器

每个书源一个 CommonJS 文件，实现契约 5.1 接口：

```js
module.exports = {
  id: "fanqie",            // 与文件名一致，[a-z0-9_]
  name: "番茄小说",
  enabled: true,
  async search({ keyword, page }) {},
  async getBookInfo(sourceId) {},   // 可返回 null
  async getCatalog(sourceId) {},    // [{index, title}]
  async getChapter(sourceId, index, title) {}, // 纯文本
  async getCover(sourceId) {},      // Buffer | null
};
```

**复用 so-novel 规则**：`lib/ruleadapter.js` 把 `so-novel/bundle/rules/main.json`
（CSS 选择器 DSL）编译成标准 adapter，默认启用大陆 IP 可用的 11 个书源。
需要额外规则文件（如 `rate-limit.json`、`proxy-required.json`）时，在
`config.json` 的 `ruleFiles` 里显式列出。可用 `config.json` 的 `sources` 覆盖
单个源的 enabled。

## API

| 方法/路径 | 说明 |
|---|---|
| `GET /health` | 在线探测 |
| `GET /api/sources` | 书源列表 |
| `POST /api/search` | `{keyword, source?, page?}` → 聚合搜索 |
| `POST /api/download` | `{source, sourceId, refresh?}` → `{jobId}` |
| `GET /api/jobs/{jobId}` | 轮询任务（queued/running/done/failed） |
| `GET /static/books/{source}/{sourceId}.epub` | 下载 EPUB |
| `GET /static/imgs/{hash}.{ext}` | 封面图 |

错误信封 `{ok:false, error:{code, message, detail?}}`，状态码见契约 2.8。

## 验收

```bash
npm test   # 端到端：启动服务，逐个验证契约第 7 节清单
```

清单：health、OPTIONS 预检、placeholder 搜索→下载→轮询→拉回合法 EPUB、
二次下载缓存命中、抓取失败 job failed、EPUB 结构校验、sourceId 含 `:` 400。