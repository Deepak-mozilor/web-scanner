# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

All commands run from the repo root:

```bash
npm run build      # tsc → dist/
npm run start      # node dist/index.js        (API server, requires build first)
npm run dev        # ts-node index.ts           (API server, no build needed)
node dist/worker.js  # BullMQ worker process   (requires build first)
ts-node worker.ts    # BullMQ worker process   (no build needed)
```

There are no tests or a linter configured.

Redis must be running locally (`redis://localhost:6379`) or set via `REDIS_URL`.

## Architecture

Two independent Node.js processes share a BullMQ queue backed by Redis:

```
POST /scan  →  Express API (index.ts)
                  └── enqueues 'crawl' job in BullMQ → Redis

BullMQ Worker (worker.ts)
  ├── 'crawl' job: Puppeteer crawls root URL → discovers up to N pages
  │                → enqueues one 'scan' job per page
  └── 'scan' job:  Puppeteer + Lighthouse audits one page
                   → POSTs result to callback_url
                   → when all pages done, POSTs { event:'complete' } callback
```

### Process entry points

- `index.ts` — starts the HTTP API only (no worker)
- `worker.ts` — starts the BullMQ worker only (no HTTP server)

Both must run simultaneously for the system to function.

### Key files

| File | Responsibility |
|---|---|
| `src/server.ts` | Express routes: `POST /scan`, `POST /scan/:id/cancel`, `GET /health` |
| `src/queue.ts` | BullMQ queue + Redis connection factory; `CrawlJobData` / `ScanJobData` types |
| `src/crawler.ts` | Puppeteer-based link extractor; two-phase: nav/header links first, then all `<a>` |
| `src/scanner.ts` | Runs Lighthouse via Puppeteer; global mutex serialises concurrent scans |
| `src/parser.ts` | Transforms raw `RunnerResult` into structured `ParsedResult` |
| `src/worker.ts` | BullMQ processor: `processCrawlJob` and `processScanJob` |
| `src/callback.ts` | Shared `postCallback()` used by both worker and server |

### Lighthouse mutex

`scanner.ts` chains all Lighthouse runs through a single `lighthouseQueue` promise so only one Chrome instance runs at a time. This is required because Lighthouse uses the global `performance` namespace and crashes when two instances run concurrently in the same process. The `shouldCancel` hook is checked immediately after acquiring the mutex, before Chrome launches.

### Redis keys used at runtime

| Key | Purpose |
|---|---|
| `completion:{scan_job_id}` | Hash: `total`, `done`, `succeeded`, `failed` — tracks multi-page progress |
| `completing:{scan_job_id}` | SET NX guard — ensures only one job fires the `complete` callback |
| `cancelled:{scan_job_id}` | Cancel flag (TTL 24h) — checked by worker before and after each scan |
| `meta:{scan_job_id}:callback_url` | Stored at crawl time so the cancel endpoint can fire a `cancelled` callback |
| `backup:{scan_job_id}` | List of reserve URLs (crawl discovers 2× `crawl_limit`) — `LPOP`ped to replace a failed scan |
| `replaceseq:{scan_job_id}` | Counter for unique replacement scan job IDs |
| `failed_urls:{scan_job_id}` | List of URLs whose slot finalised as failed — reported in the `complete` callback |

### Callback contract

The worker POSTs to `callback_url` when processing starts, at crawl time, once per URL, and once at the end:

- **Started** (once, first thing): `{ event:'started', scan_job_id, url }` — the worker picked up the job (queued → running), before crawling
- **Crawled** (once, before any scan): `{ event:'crawled', scan_job_id, total_urls, urls, backup_urls }` — the discovered pages (`urls` = the ones that will be scanned, `backup_urls` = reserves)
- **Per-URL** (one per discovered URL): `{ scan_job_id, url, total_urls, success, results }`
  where `results` is keyed by strategy, e.g. `{ desktop: { success, data | error+code }, mobile: { ... } }`.
  When S3 offloading is enabled (`S3_BUCKET` set), a **successful** per-URL callback replaces
  `results` with `results_url` — a **private** presigned GET URL (default 1h) the backend fetches
  to obtain the same `results` object. Failed per-URL callbacks always send `results` inline (small).
  Inside `results`, each strategy's `data.screenshots` has a `storage` discriminator: when S3 is on
  it is `'s3'` and `final`/`fullPage`/`filmstrip[].data` are **permanent public https URLs**; when
  off it is `'inline'` base64 data URIs. If one strategy's screenshot upload fails it falls back to
  `'inline'`, so a single callback may **mix** `'s3'` and `'inline'` — branch on the per-object
  `storage` field.
- **Complete** (once): `{ event:'complete', scan_job_id, total_urls, succeeded, failed, failed_urls }` (`failed_urls` lists the URLs of slots that finalised as failed; its length equals `failed`)
- **Cancelled** (if cancelled): `{ event:'cancelled', scan_job_id, succeeded, failed, removed_pending }`

`strategy` defaults to `'both'` — each URL is scanned for desktop AND mobile, and the two
results are **merged into one callback** (`results.desktop`, `results.mobile`). One scan job
and one callback per URL; `total_urls` is the URL count. `success` is true only if every
requested strategy succeeded. Pass `strategy: 'mobile'` or `'desktop'` to scan just one
(then `results` has a single key).

### Failed-scan replacement

The crawler discovers up to **2× `crawl_limit`** URLs: the first `crawl_limit` are scanned
(the "slots"), the rest are held in `backup:{id}`. When a scan isn't fully successful (any
strategy failed), the worker `LPOP`s a backup URL and enqueues a **replacement** scan
(`isReplacement: true`) for that slot.

**The submitted root URL (slot 0, `isRoot: true`) is never replaced** — if it fails, that's
the slot's outcome. Only the other discovered pages are eligible for backup replacement.

Callback rules on failure:
- **Any scan fails** (original OR backup) → send a `success:false` callback, then (for
  non-root slots with backups remaining) try a backup.
- **Any scan fully succeeds** → send a `success:true` callback; slot finalised.
- **Backups exhausted** → slot finalised as failed.

A slot finalises (ticks the completion counter) on a fully successful scan, or when
backups run out. Because every failed attempt fires a callback, **the backend may receive
many more than `total_urls` per-URL callbacks** — it should treat the `complete` event as
the authoritative "all done" signal, not a callback count.

### Cancel flow

`POST /scan/:id/cancel` sets the `cancelled:{id}` Redis flag, removes any still-pending BullMQ jobs, reads partial completion counts, deletes the counter, responds `200`, then fires the `cancelled` callback. Active (locked) jobs can't be removed — the flag stops them at the next checkpoint.

### Security measures (`src/server.ts`)

- Rate limiting: `POST /scan` capped at 20 req/min per IP
- SSRF protection: rejects non-http(s) schemes and private IP ranges (`10.x`, `192.168.x`, `172.16–31.x`, `169.254.x`, `localhost`, IPv6 loopback)
- Input validation: `categories` allowlist; `timeout` bounded 5,000–300,000ms; `crawl_limit` bounded 1–20
- `SCANNER_SECRET` env var: when set, all inbound requests and outbound callbacks must carry `X-Scanner-Secret` header

### S3 storage layout (`src/storage.ts`)

Enabled when `S3_BUCKET` is set (else results + base64 screenshots are inlined — local-dev default).

- `payloads/{scan_job_id}/{job.id}.json` — **private** result JSON; delivered as a presigned GET
  URL (`S3_URL_TTL_SECONDS`, default 1h). Fetched once by the backend on callback receipt.
- `screenshots/{scan_job_id}/{uuid}/{strategy}/{final.jpg|fullpage.webp|filmstrip-N.jpg}` —
  **public** binary images; delivered as permanent direct S3 URLs (`S3_PUBLIC_BASE_URL` or the
  derived `https://<bucket>.s3.<region>.amazonaws.com`). The random `{uuid}` makes URLs
  non-enumerable. Uploaded by the worker via `offloadScreenshots()` before the payload upload;
  per-strategy failures fall back to inline base64.

Requires a **bucket policy granting anonymous `s3:GetObject` on `screenshots/*` only** — `payloads/`
must stay private. Lifecycle rules: `payloads/` short (~1 day), `screenshots/` longer (e.g. 30 days,
and never shorter than how long the backend keeps the scan's screenshot URLs — there is no re-sign
fallback for public URLs).

### ESM/CJS note

Lighthouse 10+ is ESM-only. It is dynamically imported inside `runScan()` to avoid a CJS/ESM conflict — the rest of the codebase compiles to CommonJS per `tsconfig.json`. Do not move the `import('lighthouse')` call to a top-level import.
