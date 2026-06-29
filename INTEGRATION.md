# Web Scanner — Integration Guide

## Base URL

```
http://54.211.124.136:3000
```

---

## Endpoints

### POST /scan
Enqueue a scan. Returns immediately (202). Results are delivered via callback.

**Request**
```json
{
  "url": "https://example.com",
  "scan_job_id": "your-unique-job-id",
  "callback_url": "https://your-backend.com/internal/scan-callback",
  "strategy": "desktop",
  "categories": ["performance", "accessibility", "best-practices", "seo"],
  "timeout": 60000,
  "crawl_limit": 1
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `url` | string | yes | URL to scan |
| `scan_job_id` | string | yes | Your unique ID for this scan |
| `callback_url` | string | yes | Scanner will POST results here |
| `strategy` | string | yes | `"desktop"` or `"mobile"` |
| `categories` | string[] | yes | Any of: `performance`, `accessibility`, `best-practices`, `seo` |
| `timeout` | number | no | Per-page timeout in ms. Min 5000, max 300000. Default 60000 |
| `crawl_limit` | number | no | **Set to `1` to scan only the given URL (no crawling).** Max 20. Default 5 |

> **Note:** The scanner supports multi-page crawling, but is currently configured for single-URL scans.
> Always pass `crawl_limit: 1` — the scanner will scan only the provided `url` and fire exactly
> one per-page callback followed by one `complete` callback.

**Response**
```json
{ "scan_job_id": "your-unique-job-id", "message": "Scan queued", "url": "https://example.com" }
```

---

### POST /scan/:id/cancel
Cancel an in-progress scan.

```
POST /scan/your-unique-job-id/cancel
```

**Response**
```json
{ "message": "Cancelled", "removed_pending": 0 }
```

A `cancelled` callback is fired to `callback_url` after this returns.

---

### GET /health
```json
{ "status": "ok" }
```

---

## Callback Contract

The scanner POSTs to your `callback_url` for each page and once at the end.

With `crawl_limit: 1` you will always receive exactly **2 callbacks**: one per-page result, then one completion event.

### Per-page result

**Success**
```json
{
  "scan_job_id": "your-unique-job-id",
  "url": "https://example.com",
  "total_urls": 1,
  "success": true,
  "data": {
    "scores": {
      "performance": 87,
      "accessibility": 92,
      "best-practices": 100,
      "seo": 95
    },
    "metrics": {
      "fcp_ms": 1200,
      "lcp_ms": 2100,
      "tbt_ms": 80,
      "cls": 0.02,
      "speed_index_ms": 1800,
      "tti_ms": 2400
    },
    "issues": {
      "critical": [...],
      "nonCritical": [...],
      "passed": [...]
    },
    "screenshots": {
      "final": "<base64>",
      "full": "<base64>"
    }
  }
}
```

**Failure**
```json
{
  "scan_job_id": "your-unique-job-id",
  "url": "https://example.com",
  "total_urls": 1,
  "success": false,
  "error": "Navigation timeout",
  "code": "TIMEOUT"
}
```

Error codes: `TIMEOUT`, `CHROME_ERROR`, `CANCELLED`

---

### Completion event (always fires once)
```json
{
  "event": "complete",
  "scan_job_id": "your-unique-job-id",
  "total_urls": 1,
  "succeeded": 1,
  "failed": 0
}
```

### Cancelled event (fires if scan was cancelled)
```json
{
  "event": "cancelled",
  "scan_job_id": "your-unique-job-id",
  "succeeded": 0,
  "failed": 0,
  "removed_pending": 0
}
```

---

## Issue Object Structure

Each issue in `critical`, `nonCritical`, or `passed` arrays:

```json
{
  "id": "render-blocking-resources",
  "title": "Eliminate render-blocking resources",
  "category": "performance",
  "score": 0.3,
  "severity": "nonCritical",
  "wasted_ms": 450,
  "wasted_bytes": null,
  "details": {}
}
```

Severity mapping:
- `score === 0` → `critical`
- `0 < score < 0.9` → `nonCritical`
- `score >= 0.9` → `passed`

---

## Security

If a `SCANNER_SECRET` is configured on the scanner, all requests must include:

```
X-Scanner-Secret: <secret>
```

And all callbacks from the scanner will include the same header — verify it on your `/internal/scan-callback` endpoint.

---

## Rate Limits & Constraints

- `POST /scan`: 20 requests/min per IP
- `timeout`: 5,000–300,000 ms
- BullMQ retries each scan up to 3 times on failure

---

## Recommended Flow

```
1. User triggers scan
      → POST /scan with crawl_limit: 1
      → Scanner returns 202
      → Store scan_job_id, set status = "running"

2. Scanner fires the per-page callback when the scan finishes
      → Store scan_result + issues rows

3. Scanner fires { event: "complete" }
      → Set status = "completed"

4. If user cancels
      → POST /scan/:id/cancel
      → Scanner fires { event: "cancelled" } callback
      → Set status = "cancelled"
```
