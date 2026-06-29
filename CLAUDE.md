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

### Callback contract

The worker POSTs to `callback_url` twice per page and once at the end:

- **Per-page** (N times): `{ scan_job_id, url, total_urls, success, data | error+code }`
- **Complete** (once): `{ event:'complete', scan_job_id, total_urls, succeeded, failed }`
- **Cancelled** (if cancelled): `{ event:'cancelled', scan_job_id, succeeded, failed, removed_pending }`

### Cancel flow

`POST /scan/:id/cancel` sets the `cancelled:{id}` Redis flag, removes any still-pending BullMQ jobs, reads partial completion counts, deletes the counter, responds `200`, then fires the `cancelled` callback. Active (locked) jobs can't be removed — the flag stops them at the next checkpoint.

### Security measures (`src/server.ts`)

- Rate limiting: `POST /scan` capped at 20 req/min per IP
- SSRF protection: rejects non-http(s) schemes and private IP ranges (`10.x`, `192.168.x`, `172.16–31.x`, `169.254.x`, `localhost`, IPv6 loopback)
- Input validation: `categories` allowlist; `timeout` bounded 5,000–300,000ms; `crawl_limit` bounded 1–20
- `SCANNER_SECRET` env var: when set, all inbound requests and outbound callbacks must carry `X-Scanner-Secret` header

### ESM/CJS note

Lighthouse 10+ is ESM-only. It is dynamically imported inside `runScan()` to avoid a CJS/ESM conflict — the rest of the codebase compiles to CommonJS per `tsconfig.json`. Do not move the `import('lighthouse')` call to a top-level import.
