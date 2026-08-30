# CozyReader · AS 后端契约 v1

> 本文件是聚合服务器（AS，Node.js）的完整实现约定，内嵌与前端共享的 HTTP/JSON 契约，后端单独按本文件实现即可。
> 前端对应文件：`READER-CONTRACT.md`。

## 0. 角色与范围

- 职责：搜索聚合、抓全文、打包 EPUB、静态托管、磁盘缓存。
- 前端单 HTML 只会访问 AS；前端永远不直连第三方书源。
- 所有抓源出口都在 AS 侧，用 adapter 隔离。

## 1. 通用约定

- 编码 UTF-8；API 返回 `Content-Type: application/json; charset=utf-8`。
- **CORS**（所有响应含错误与预检）：
  - `Access-Control-Allow-Origin: *`
  - `Access-Control-Allow-Methods: GET, POST, OPTIONS`
  - `Access-Control-Allow-Headers: Content-Type`
  - OPTIONS → 204，不经过业务逻辑。
- 时间：`lastUpdate` 用 `YYYY-MM-DD` 字符串。
- 数字：章节 index 0 起始、整数、连续。
- 无全局状态依赖前端；任务在内存，重启丢任务 → 返回 `JOB_NOT_FOUND` 可接受。

## 2. HTTP 接口

### 2.1 GET /health
```json
{"ok":true,"data":{"service":"cozy-reader-as","version":"0.1.0","time":"2026-08-29T00:00:00Z","sources":[{"id":"fanqie","name":"番茄小说","enabled":true}]}}
```

### 2.2 GET /api/sources
```json
{"ok":true,"data":[{"id":"fanqie","name":"番茄小说","enabled":true}]}
```
`enabled=false` 的源不出现在搜索聚合里，但仍可下载已缓存的。

### 2.3 POST /api/search
请求：`{"keyword":"斗破", "source":"fanqie", "page":1}`
- `keyword` 必填，≤200 字符；`source` 可选（缺省=全部启用源）；`page` 1 起始，默认 1。

响应：
```json
{"ok":true,"data":{
  "keyword":"斗破","page":1,"hasMore":false,
  "results":[
    {"bookId":"fanqie:7542602438201576472",
     "source":"fanqie","sourceId":"7542602438201576472",
     "title":"斗破苍穹：炎上攻略","author":"天蚕土豆",
     "intro":"……","cover":"https://as.example/static/imgs/abc.jpg",
     "category":"玄幻脑洞","status":"连载中",
     "lastUpdate":"2026-08-29","totalChapters":422,"words":1234567}
  ]}}
```
- `results` 可为空数组。
- 元数据在搜索时尽量取全；取不到的可为 null/空串，前端允许后补。
- `cover` 必须是 AS 转存后的地址（懒转存，见 4.5）。

### 2.4 POST /api/download
请求：`{"source":"fanqie","sourceId":"7542602438201576472","refresh":false}`
- `refresh=false`：有缓存 → 任务直接 done 返回现有 epubUrl。
- `refresh=true`：强制重抓并重打 EPUB。

响应：`{"ok":true,"data":{"jobId":"fanqie.7542602438201576472.a1b2"}}`

### 2.5 GET /api/jobs/{jobId}
```json
{"ok":true,"data":{
  "jobId":"fanqie.7542602438201576472.a1b2",
  "status":"running",
  "progress":{"crawled":120,"total":422},
  "epubUrl":null,
  "error":null}}
```
- `done` 时 `epubUrl` 必须非空。
- `failed` 时 `error` = `{code, message}`。
- jobId 至少存活 24h；过期返回 `JOB_NOT_FOUND`。
- 同 bookId 并发去重：返回同一 jobId。

### 2.6 GET /static/books/{source}/{sourceId}.epub
- EPUB 文件，`Content-Type: application/epub+zip`。
- 不存在 → 404（信封 `BOOK_NOT_FOUND`）。

### 2.7 GET /static/imgs/{hash}.{ext}
- 封面图，带缓存头。不存在 404。

### 2.8 错误信封与状态码
```json
{"ok":false,"error":{"code":"SOURCE_ERROR","message":"书源请求失败","detail":{}}}
```
| code | HTTP | 场景 |
|---|---|---|
| BAD_REQUEST | 400 | 参数缺失/非法 |
| SOURCE_NOT_FOUND | 404 | source 不在适配器里 |
| JOB_NOT_FOUND | 404 | jobId 不存在或过期 |
| BOOK_NOT_FOUND | 404 | 静态文件不存在 |
| SOURCE_ERROR | 502 | 第三方书源报错/解析失败 |
| TIMEOUT | 504 | 抓源超时（15s/次，重试 1 次仍失败） |
| INTERNAL | 500 | 兜底 |

## 3. EPUB 生成规范（AS 负责产出）

AS 把抓到的全文打包为**标准 EPUB 3**，前端用内联解析器离线读取。

```
{sourceId}.epub
├─ mimetype                     (固定: application/epub+zip, 存储方式 STORED)
├─ META-INF/container.xml
├─ OEBPS/content.opf            (metadata + manifest + spine)
├─ OEBPS/toc.ncx                (目录)
├─ OEBPS/titles.xhtml           (封面/书名页)
└─ OEBPS/chapters/{0001..N}.xhtml
```

### content.opf 要求
- `<dc:identifier>` = `bookId`（`source:sourceId`）。
- `<dc:title>` / `<dc:creator>` / `<dc:language>zh-CN` / `<dc:date>` = lastUpdate。
- spine 顺序 = 章节顺序；每章 manifest id = `ch{index+1:04d}`。
- metadata 增加自定义扩展（XHTML 里不用，供前端解析校验）：
  - `meta property="source"` = 适配器 id
  - `meta property="sourceId"`
  - `meta property="totalChapters"` = 章数
  - `meta property="status"` / `category` / `words`

### 章内容 XHTML
- 每章一个 XHTML：`<h1>章节标题</h1>` + 若干 `<p>` 段落。
- **正文只放纯文本**，不做任何富文本/内联样式，防 XSS 也简化前端解析。
- 段落用 `<p>`，空段落丢弃；章内 `\n\n` 合并成 `<p>`。

### 打包工具
- Node 侧用 `jszip`（devDependency，仅 AS 用，不影响单 HTML）。
- 约束：`mimetype` 文件必须 STORED 且为第一个条目（否则部分 EPUB 解析器拒绝）。

## 4. 服务端行为规范

### 4.1 bookId 规则
- `bookId = source + ":" + sourceId`；`source` 仅 `[a-z0-9_]`；`sourceId` 禁止含 `:`（AS 校验并 400）。

### 4.2 目录结构
```
data/
  books/{source}/{sourceId}.epub
  imgs/{hash}.{ext}
  jobs.json          # 可选：任务状态持久化（不持久则重启丢任务）
```

### 4.3 抓书流程（download 任务）
1. 校验 source/sourceId。
2. 有缓存 && !refresh → 任务直接 done，返回 epubUrl。
3. `getBookInfo(sourceId)` 拿元信息；失败降级用 search 时带的信息。
4. `getCatalog(sourceId)` 拿目录。
5. 封面转存：`getCover` 或 getBookInfo.cover URL → 存 `imgs/` → meta 用 AS 地址。
6. 逐章 `getChapter`：并发 2、间隔 200ms、单次 15s 超时、失败重试 1 次；更新 progress。
7. 全部抓完 → 按第 3 节打 EPUB → 写 `data/books/{source}/{sourceId}.epub`。
8. refresh：重抓全部并重打 EPUB（EPUB 是整包，追更=整包重下，前端按 version 判断是否需要更新）。
9. 失败 → job failed；已抓正文丢弃，不产生半成品 EPUB。

### 4.4 并发与限速
- 同 bookId 同时只允许一个 running 任务。
- 单源抓书并发 ≤2；源级令牌桶限速（默认 5 req/s）。

### 4.5 封面转存
- 源给封面 URL → 抓取 → `data/imgs/{sha1(url)}.{ext}` → 返回 AS 地址。
- 失败不阻断：返回空串，前端占位图。

### 4.6 日志
每请求一行：`ts method path status ms`；adapter 出错记 error 字段。

## 5. 适配器接口（实现契约）

### 5.1 定义（CommonJS，每个源一个文件）
```js
// adapters/{id}.js
module.exports = {
  id: "fanqie",            // 必须与文件名一致，[a-z0-9_]
  name: "番茄小说",
  enabled: true,

  // 搜索。入参 {keyword, page}。返回 SearchResult[]
  async search({ keyword, page }) {},

  // 元信息补全。可返回 null
  async getBookInfo(sourceId) {},

  // 目录 [{index, title}]，0 起始连续
  async getCatalog(sourceId) {},

  // 单章正文，返回纯文本 string
  async getChapter(sourceId, index, title) {},

  // 封面二进制 Buffer | null
  async getCover(sourceId) {},
};
```

### 5.2 SearchResult / BookInfo 规范（AS 消费前校验）
```js
// SearchResult
{ sourceId, title, author, intro, cover, category,
  status, lastUpdate, totalChapters, words }

// BookInfo（字段都可选，缺失用 search 值补齐）
{ title, author, intro, cover, category,
  status, lastUpdate, totalChapters, words }
```

### 5.3 适配器错误约定
- 抛普通 `Error(message)` → AS 记日志 → `SOURCE_ERROR`(502)。
- 抛 `{code:"TIMEOUT"}` → 504。
- AS 兜底：每个方法外层套 15s 超时（AbortController）。

### 5.4 占位实现 `adapters/placeholder.js`
```js
module.exports = {
  id: "placeholder",
  name: "占位书源",
  enabled: true,

  async search({ keyword, page }) {
    return [0, 1, 2].map(i => ({
      sourceId: `p${page}_${i}`,
      title: `${keyword} · 示例书 ${i + 1}`,
      author: "示例作者",
      intro: "占位书源生成的假书，用于全链路联调。",
      category: "测试",
      status: "连载中",
      lastUpdate: new Date().toISOString().slice(0, 10),
      totalChapters: 128,
      words: 128 * 500,
    }));
  },

  async getBookInfo(sourceId) { return null; },

  async getCatalog(sourceId) {
    const n = 128; // 固定 128 章
    return Array.from({ length: n }, (_, i) => ({ index: i, title: `第 ${i + 1} 章 示例章节` }));
  },

  async getChapter(sourceId, index) {
    return `这是 ${sourceId} 的第 ${index + 1} 章正文。\n\n段落二……`;
  },

  async getCover(sourceId) { return null; },
};
```


## 7. 实现验收清单（后端自测）

- [ ] `GET /health`、OPTIONS 预检（204 + CORS 头）正常
- [ ] placeholder 源走通：search → download → job 轮询 → 拉回合法 EPUB（可被解析器打开）
- [ ] 第二次 download 同书直接 done（命中缓存）
- [ ] 抓取中断 → job failed，错误码 SOURCE_ERROR/TIMEOUT
- [ ] 生成的 EPUB：mimetype 为第一个 STORED 条目、`totalChapters` 与 spine 一致、每章纯文本无标签残留
- [ ] sourceId 含 `:` 被 400 拒绝