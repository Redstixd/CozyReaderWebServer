

分析完了。结论先说：**完全可行，而且这个项目已经内置了 web 模式和 80% 的现成 API**——你描述的需求（搜索→返回；下载→托管→给链接）在这份代码里已经有对应实现，缺的是一层"异步任务 + 鉴权 + 静态托管"的包装。下面详细拆解。

## 一、现状：已经是半个 API 服务

项目用 Jetty 11 内嵌服务器，`-Dmode=web` 启动就是一个 HTTP 服务（`Main.java:70` → `WebServer`），已经注册了完整路由（`WebServer.java:41-57`）：

| 路由 | 功能 | 对应你的需求 |
|---|---|---|
| `GET /search/aggregated?kw=&searchLimit=` | 聚合搜索**全部书源**，相似度过滤+排序（`AggregatedSearchServlet`） | ✅ 搜索需求，现成 |
| `GET /book-fetch?url=&format=&language=` | 服务端爬书→生成 **epub/txt/html/pdf**→存到 `downloadPath`（`BookFetchServlet`） | ✅ 下载需求，现成 |
| `GET /book-download?filename=` | 从服务器下发文件，**带路径穿越防护**（`BookDownloadServlet.java:38`） | ✅ "给链接"，现成 |
| `GET /local-books` / `/book-delete` | 列出/删除已下载文件 | 配套 |
| `GET /download-progress` | SSE 全局下载进度推送 | 需要 task 化 |
| `GET /sources` `/sources/check` `/config` `/suggestion` | 书源列表/连通性/配置/联想词 | 配套 |

底层链路也全部可复用，是干净的类不是写死的逻辑：
- **搜索**：`AggregatedSearchAction.getSearchResults()` → 虚拟线程并发跑每个 `SearchParser(config).parse(kw)` → `SearchResultsHandler.filterAndSort()`（`SearchParser.java:52`）
- **下载**：`BookFetchServlet` → `new Crawler(cfg).crawl(url)` → `TocParser.parseAll`（目录）→ 虚拟线程并发 `ChapterParser.parse`（每章）→ `CrawlerPostHandler` → `EpubMergeHandler`（用 epub4j 生成，含封面/目录/元数据）→ `downloadPath/书名(作者).epub`（`EpubMergeHandler.java:73`）

也就是说，**"阅读器 → AS → 第三方书源"这条链路的爬取核心已经完全现成**，包一层 HTTP 任务接口即可。

## 二、差距与坑（包装成公共 API 真正要处理的问题）

按严重程度排：

1. **`/book-fetch` 是同步阻塞的**。一本 1000 章的书要爬几分钟，HTTP 客户端（阅读器）必然超时。**必须改成异步任务**：创建任务立刻返回 `taskId`，客户端轮询或 SSE 等结果。
2. **`/book-fetch` 成功时响应体是空的**（`BookFetchServlet.java:58-61`，成功分支什么都不写）。客户端不知道生成的文件名/URL，只能自己再去猜 `/local-books` 的最新项。要返回 `{filename, url, size}`。
3. **无鉴权**。部署到公网等于公开代理，任何人都能搜索、下载，甚至 `book-delete` 删文件（虽然只限 downloadPath 内）。必须加 token。
4. **SSE 进度是全局广播**。`DownloadProgressSseServlet` 用静态 Set，所有客户端收到所有下载的进度，多用户并发会串台（`DownloadProgressSseServlet.java:14`）。要按 `taskId` 订阅。
5. **"静态托管"语义不纯**。epub 在 `downloadPath`，不在 web 静态根下，靠 `/book-download` 动态流式下发，没有缓存头。你有两个干净做法：① 新增 `/files/*` 静态路由直接 serve `downloadPath`（加鉴权）；② 用 Nginx 把 `downloadPath` 直接暴露成静态目录 + `auth_basic`——这个最简单，连代码都不用改。

8. **搜索列表没有封面**。`SearchResult` 没有 `coverUrl` 字段（`SearchResult.java:12-25`），阅读器搜索页显示不了封面。可选加一个 `/cover?url=` 代理接口来缓解。

好消息：`BookContext` 是 `InheritableThreadLocal`（`BookContext.java:11`），并发下载时书信息不会串；配置隔离也做得对——`BookFetchServlet` 用 `BeanUtil.copyProperties` 复制一份 config 再改，不污染全局单例（`BookFetchServlet.java:69`）。

## 三、推荐的 API 形态

在现有基础上**增量改造**，不动现有 WebUI：

```
GET  /search/aggregated?kw=xxx&searchLimit=N     # 已有，加鉴权即可

POST /v1/books                                   # 创建下载任务
     body: { "url": "<详情页URL>", "format": "epub", "language": "zh-cn" }
     → 202 { "taskId": "uuid" }

GET  /v1/books/{taskId}                          # 轮询
     → { "status": "pending|running|done|failed",
         "progress": {index, total},
         "result": { "filename", "url": "/files/xxx.epub", "size" } }

GET  /files/{filename}                            # 静态托管下载（鉴权 or 短期签名 URL）
```

改造量评估（约 4-6 个新类，复用 Crawler）：
1. `DownloadTaskManager`——单例任务表 + 限流执行队列
2. `BookTaskServlet`——`POST /v1/books` + `GET /v1/books/{id}`（复用 `Crawler`）
3. 鉴权 `Filter`——token 放 `config.ini` 的 `[web] api-token`
4. `/files/*` 静态路由——复用现有 canonical-path 防穿越逻辑 + 缓存头
5. 任务清理定时器——完成 24h 后删文件清任务

部署形态直接用现有 Dockerfile（README 里 docker-compose 示例），`JAVA_OPTS=-Dmode=web`，暴露 7765 端口，Nginx 前置挂 SSL。

## 四、提醒一点

项目自带免责声明（仅供交流、不得商用），作为第三方书源聚合 + 电子书托管服务对外提供，涉及版权内容分发风险，发布前需要你自己评估合规性。

---

需要的话，我可以接着把改造方案做成具体实施计划（新类清单 + 每个类的接口定义），或者直接开始写代码。你倾向哪种？
