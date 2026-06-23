# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

All commands run from the repo root:

```bash
npm run build      # tsc → dist/
npm run start      # node dist/index.js  (requires build first)
npm run dev        # ts-node index.ts    (no build needed)
```

There are no tests or a linter configured.

## Architecture

This is a single Express API that wraps [Lighthouse](https://github.com/GoogleChrome/lighthouse) to scan URLs and return structured audit results.

**Request flow:**
1. `POST /scan` in `src/server.ts` validates the request body and calls `runScan()`
2. `src/scanner.ts` launches Chrome via Puppeteer (bundled Chromium), runs Lighthouse, then closes the browser
3. `src/parser.ts` transforms the raw `RunnerResult` into a structured `ParsedResult`
4. `src/server.ts` returns the parsed result as JSON

**Key design details:**
- Lighthouse 10+ is ESM-only; it is dynamically imported inside `runScan()` to avoid CJS/ESM conflict with the rest of the codebase (which is compiled as CommonJS per `tsconfig.json`).
- `parser.ts` classifies audits into `critical` (score === 0), `nonCritical` (0 < score < 0.9), and `passed` (score ≥ 0.9), then groups them again by Lighthouse category (`byCategory`). The flat lists and the per-category breakdown both reference the same `AuditItem` objects.
- `src/scanner.ts` emits a `RunnerResult`; `src/parser.ts` owns all interpretation. The entry point `index.ts` only starts the HTTP listener.

**Security measures in place (`src/server.ts`):**
- Rate limiting: `POST /scan` is capped at 3 requests/min per IP via `express-rate-limit`
- SSRF protection: URLs are rejected if they use non-http(s) schemes or resolve to private/internal IP ranges (`10.x`, `192.168.x`, `172.16–31.x`, `169.254.x`, `localhost`, IPv6 loopback)
- Input validation: `categories` is checked against an allowlist (`performance`, `accessibility`, `best-practices`, `seo`, `pwa`); `timeout` is bounded to 5,000–300,000ms
- Error sanitization: scan errors return a generic message to callers; full error detail is logged server-side only
