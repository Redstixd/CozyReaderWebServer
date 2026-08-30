# CozyReader WebServer — Guidelines

Node.js aggregation server: search aggregation, full-text crawl, EPUB 3 packaging, static hosting, disk cache.
Implements `../AS-CONTRACT.md`; the client contract lives in `../READER-CONTRACT.md`.

## Project Structure

- `server.js` — HTTP routing, CORS (`*`), error envelope `{ok:false,error:{code,message,detail?}}`, per-request logging
- `lib/`
  - `config.js` — config load (config.json env overrides)
  - `errors.js` — error-code→HTTP-status table (BAD_REQUEST 400 / SOURCE_NOT_FOUND 404 / JOB_NOT_FOUND 404 / BOOK_NOT_FOUND 404 / SOURCE_ERROR 502 / TIMEOUT 504 / INTERNAL 500)
  - `http.js` — fetch with timeout/retry/429 exponential backoff
  - `ratelimiter.js` — token-bucket rate limiter + per-source limiter table
  - `registry.js` — adapter registry (map id → adapter)
  - `cover.js` — cover mirroring (`sha1(url)`-named files in `imgs/`)
  - `epub.js` — EPUB 3 generation via jszip; `mimetype` must be the first STORED entry
  - `jobs.js` — job manager (in-memory, dedup by bookId, crawl concurrency 2, 200ms interval, 15s/chapter timeout+1 retry, 24h TTL, progress)
  - `search.js` — multi-source search aggregation with per-source budget
  - `ruleadapter.js` — compiles `so-novel/bundle/rules/main.json` (CSS-selector DSL) into standard adapters; handles `@js:`/`@java:base64.decode()` content decode (base64-obfuscated bodies like ranwen8) and strips `&nbsp;`/`&#160;`/NBSP paragraph indent (decodeEntities:false leaves the entity literal)
- `adapters/` — `placeholder.js` (contract 5.4), `fanqie.js` (contract §6 + `../FANQIE_API.md`)
- `so-novel/` — reused rule repo (read-only reference)
- `test/api.test.js` — end-to-end contract tests
- `data/` — `books/{source}/{sourceId}.epub`, `imgs/{hash}.{ext}` (gitignored)

## Commands

```bash
npm install
npm start    # 0.0.0.0:7765 (AS_PORT overrides); serve aggregation backend
npm test     # node --test test/*.test.js — end-to-end contract suite
```

Verify before every commit: `npm test` green (currently 17 tests).

## Adapter Interface (contract 5.1)

```js
module.exports = {
  id: "fanqie",                  // must match filename, [a-z0-9_]
  name: "番茄小说",
  enabled: true,
  async search({ keyword, page }) {},
  async getBookInfo(sourceId) {},     // may return null
  async getCatalog(sourceId) {},      // [{index, title}], 0-based
  async getChapter(sourceId, index, title) {}, // plain text string
  async getCover(sourceId) {},        // Buffer | null
};
```

## Download / Incremental Update Semantics

- `POST /api/download {source, sourceId, refresh}`:
  - `refresh=false` (default, INCREMENTAL): fetch live catalog, compare its length to the cached EPUB's `totalChapters`; equal → job `done` immediately with existing `epubUrl` and `updated=false` (no re-crawl); differ or no/corrupt cache → full re-crawl with `updated=true`.
  - `refresh=true`: force full re-crawl and re-pack, always `updated=true`.
- `GET /api/jobs/{jobId}` returns `{jobId, status, progress, epubUrl, error, updated}`; on `failed`, `error` is `{code, message}` (an OBJECT, not a string — the client must flatten it).
- Job: `getBookInfo → getCatalog → cover mirror → crawl chapters (concurrency 2) → buildEpub → write file`; failure discards partial chapters (no half-written EPUB).

## Conventions

- CommonJS, 2-space indent, no trailing semicolons, terse Chinese comments, template literals, `const`/`let`.
- Keep files under 250 LOC; split logic into `lib/`.
- Tests are written BEFORE code for new server features (RED→GREEN); every behavior change needs a failing test first.
- Do not delete failing tests to make the build pass — fix the code.

## Notes

- Some third-party sources are dead upstream (e.g. 笔趣阁22's `/ss/` 404) — not fixable in code; treat as source-site drift.
- This repo does NOT use GPG/SSH signing: pass `-c commit.gpgsign=false` per invocation (repo is configured to sign, which fails in non-interactive shells).