# Web Scanner

Express API that wraps Lighthouse to scan URLs and return structured audit results. Single-file-per-concern: server validates, scanner runs Chrome, parser transforms output.

## Commands

```bash
npm run dev        # ts-node index.ts (no build needed)
npm run build      # tsc → dist/
npm run start      # node dist/index.js (requires build first)
```

No tests or linter configured.

## Architecture

```
index.ts          → starts HTTP listener on $PORT (default 3000)
src/server.ts     → Express app, input validation, rate limiting, SSRF guard
src/scanner.ts    → launches Chrome via chrome-launcher, runs Lighthouse, kills Chrome
src/parser.ts     → transforms RunnerResult into ParsedResult
```

**Request flow:** `POST /scan` → `runScan()` → `parseResults()` → JSON response

## Key Design Constraints

- **ESM/CJS conflict**: Lighthouse 10+ is ESM-only. It is dynamically imported inside `runScan()` to avoid a CJS/ESM module conflict — the rest of the codebase compiles as CommonJS (`tsconfig.json`). Do not move the import to the top of the file.
- **Audit classification**: `parser.ts` classifies audits as `critical` (score === 0), `nonCritical` (0 < score < 0.9), or `passed` (score ≥ 0.9). Only `binary`, `numeric`, and `metricSavings` score modes are included — `informative`, `manual`, and `notApplicable` audits are excluded from the scored lists.
- **Informative audits accessed directly**: `network-requests` and `resource-summary` are `informative`-mode (no score) and are pulled directly from `lhr.audits[id]` rather than through the scoreable filter.
- **`byCategory` shares references**: The flat `critical`/`nonCritical`/`passed` lists and the per-category breakdown reference the same `AuditItem` objects — do not deep-clone them.

## API

### `POST /scan`

```json
{
  "url": "https://example.com",       // required — must be public http/https
  "strategy": "desktop",              // optional — "desktop" | "mobile" (default: "desktop")
  "categories": ["performance"],      // optional — subset of allowed list below
  "timeout": 60000                    // optional — ms, 5000–120000 (default: 60000)
}
```

Allowed categories: `performance`, `accessibility`, `best-practices`, `seo`, `pwa`

### `GET /health`

Returns `{ status: "ok", timestamp: "..." }`

## Response Shape (`ParsedResult`)

```typescript
{
  url: string                         // final displayed URL after redirects
  fetchTime: string                   // ISO-8601 timestamp
  lighthouseVersion: string
  strategy: string
  runWarnings: string[]               // scan-level warnings from Lighthouse

  scores: {                           // per-category score 0–100
    [category]: { score, title, description }
  }

  metrics: {                          // core web vitals + perf metrics
    "first-contentful-paint": { value, displayValue, score, numericUnit }
    "largest-contentful-paint": { ... }
    "total-blocking-time": { ... }
    "cumulative-layout-shift": { ... }
    "interactive": { ... }
    "speed-index": { ... }
  }

  summary: { total, passed, critical, nonCritical }

  passed: [{ id, title }]            // audits with score ≥ 0.9

  byCategory: {                       // audits grouped by Lighthouse category
    [category]: {
      score, title,
      critical: AuditItem[],
      nonCritical: AuditItem[],
      passed: [{ id, title }]
    }
  }

  networkRequests: [{                 // every URL loaded by the page
    url, protocol, resourceType, mimeType,
    statusCode, transferSize, resourceSize,
    startTime, endTime,              // ms from navigation start
    entity?                          // third-party name if known
  }]

  resourceSummary: [{                 // totals per resource type
    resourceType, label, requestCount, transferSize
  }]
  // resourceType values: total, document, script, stylesheet,
  //                      image, media, font, other, third-party

  entities: [{                        // third-party services detected
    name, isFirstParty, origins,
    homepage?, category?
  }]

  screenshots: {
    final: string | null             // base64 data URL
    fullPage: string | null          // base64 data URL
    filmstrip: [{ timing, data }]    // frames as base64 data URLs
  }
}
```

### `AuditItem` shape

```typescript
{
  id, title, description,
  learnMoreUrl?,                      // extracted from Lighthouse description markdown
  displayValue,                       // human-readable string e.g. "1.2 s"
  score,                              // 0–100
  detailsType,                        // "table" | "opportunity" | "list" | etc.
  itemCount?,
  wastedBytes?,
  wastedMs?,
  items?                              // raw Lighthouse detail rows — shape varies by audit
}
```

## Security

All validation is in `src/server.ts`:

- **Rate limit**: `POST /scan` capped at 10 req/min per IP (`express-rate-limit`)
- **SSRF**: rejects non-http/https schemes and private IP ranges — `10.x`, `192.168.x`, `172.16–31.x`, `169.254.x` (AWS metadata), `localhost`, IPv6 loopback
- **Input allowlist**: `categories` validated against fixed set; `timeout` bounded to 5,000–120,000 ms
- **Error sanitization**: scan errors return `"Scan failed"` to callers; full detail in server logs only

## Environment

```bash
PORT=3000   # HTTP port (default: 3000)
```
