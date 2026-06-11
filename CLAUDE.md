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
2. `src/scanner.ts` launches Chrome via `chrome-launcher`, runs Lighthouse, then kills Chrome
3. `src/parser.ts` transforms the raw `RunnerResult` into a structured `ParsedResult`
4. `src/server.ts` returns the parsed result as JSON

**Key design details:**
- Lighthouse 10+ is ESM-only; it is dynamically imported inside `runScan()` to avoid CJS/ESM conflict with the rest of the codebase (which is compiled as CommonJS per `tsconfig.json`).
- `parser.ts` classifies audits into `critical` (score === 0), `nonCritical` (0 < score < 0.9), and `passed` (score ≥ 0.9), then groups them again by Lighthouse category (`byCategory`). The flat lists and the per-category breakdown both reference the same `AuditItem` objects.
- `src/scanner.ts` emits a `RunnerResult`; `src/parser.ts` owns all interpretation. The entry point `index.ts` only starts the HTTP listener.

**Known security gaps** (from prior review):
- SSRF: `url` destination is not validated beyond `new URL()` — internal IPs and cloud metadata endpoints are reachable
- No rate limiting on `POST /scan`
- `timeout` and `categories` inputs are not range/allowlist validated
- Raw `err.message` is returned to callers
