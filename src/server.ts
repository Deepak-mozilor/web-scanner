import express, { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { Strategy } from './scanner';
import { scanQueue, CrawlJobData } from './queue';
import { postCallback } from './callback';

const app = express();
app.use(express.json({ limit: '10mb' }));

// Rate limiter applied only to scan creation, not to cancel (cancels must always get through).
const noopLimiter: express.RequestHandler = (_req, _res, next) => next();
const scanLimiter: express.RequestHandler =
  process.env.LOAD_TEST_MODE === 'true'
    ? noopLimiter
    : rateLimit({
        windowMs: 60_000,
        max: 3,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Too many scan requests, please try again later' },
      });

if (process.env.LOAD_TEST_MODE === 'true') {
  console.warn('[server] LOAD_TEST_MODE=true — rate limiter disabled');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function requireScannerSecret(req: Request<any, any, any>, res: Response): boolean {
  const secret = process.env.SCANNER_SECRET;
  if (secret && req.headers['x-scanner-secret'] !== secret) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const ALLOWED_CATEGORIES = new Set(['performance', 'accessibility', 'best-practices', 'seo', 'pwa']);
const PRIVATE_IP_RE =
  /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.0\.0\.0|::1$|fc00:|fe80:)/i;

function isSsrfUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return true;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return true;
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || PRIVATE_IP_RE.test(host)) return true;
  return false;
}

interface ScanBody {
  url: string;
  scan_job_id: string;
  callback_url: string;
  strategy?: Strategy;
  categories?: string[];
  timeout?: number;
  crawl_limit?: number;
}

app.post('/scan', scanLimiter, async (req: Request<object, object, ScanBody>, res: Response) => {
  if (!requireScannerSecret(req, res)) return;

  const {
    url,
    scan_job_id,
    callback_url,
    strategy = 'desktop',
    categories = ['performance', 'accessibility', 'best-practices', 'seo'],
    timeout = 60_000,
    crawl_limit = 5,
  } = req.body;

  if (!url || typeof url !== 'string' || isSsrfUrl(url)) {
    res.status(400).json({ error: 'url is required and must be a valid http/https URL' });
    return;
  }

  if (!scan_job_id || typeof scan_job_id !== 'string') {
    res.status(400).json({ error: 'scan_job_id is required and must be a string' });
    return;
  }

  if (!callback_url) {
    res.status(400).json({ error: 'callback_url is required' });
    return;
  }
  let parsedCallback: URL;
  try {
    parsedCallback = new URL(callback_url);
  } catch {
    res.status(400).json({ error: 'invalid callback_url' });
    return;
  }
  if (!['http:', 'https:'].includes(parsedCallback.protocol)) {
    res.status(400).json({ error: 'callback_url must use http or https' });
    return;
  }
  if (process.env.STRICT_CALLBACK_SSRF === 'true' && isSsrfUrl(callback_url)) {
    res.status(400).json({ error: 'invalid callback_url' });
    return;
  }

  if (strategy && !['mobile', 'desktop'].includes(strategy)) {
    res.status(400).json({ error: 'strategy must be "mobile" or "desktop"' });
    return;
  }

  if (!Array.isArray(categories) || categories.some(c => !ALLOWED_CATEGORIES.has(c))) {
    res.status(400).json({ error: `categories must be an array of: ${[...ALLOWED_CATEGORIES].join(', ')}` });
    return;
  }

  if (typeof timeout !== 'number' || timeout < 5_000 || timeout > 300_000) {
    res.status(400).json({ error: 'timeout must be a number between 5000 and 300000' });
    return;
  }

  if (typeof crawl_limit !== 'number' || crawl_limit < 1 || crawl_limit > 20) {
    res.status(400).json({ error: 'crawl_limit must be a number between 1 and 20' });
    return;
  }

  const jobData: CrawlJobData = { url, scan_job_id, callback_url, strategy, categories, timeout, crawl_limit };

  try {
    await scanQueue.add('crawl', jobData, { jobId: scan_job_id });
  } catch (err) {
    console.error(`[job:${scan_job_id}] failed to enqueue:`, err);
    res.status(503).json({ error: 'Queue temporarily unavailable, please retry' });
    return;
  }

  console.log(`[job:${scan_job_id}] enqueued url=${url} strategy=${strategy} crawl_limit=${crawl_limit}`);
  res.status(202).json({ scan_job_id, message: 'Scan queued', url });
});

// Cancel a scan: stop the crawl + all its page scans. The server keeps running.
app.post('/scan/:scan_job_id/cancel', async (req: Request, res: Response) => {
  if (!requireScannerSecret(req, res)) return;

  const scanJobId = req.params.scan_job_id;
  if (!scanJobId) {
    res.status(400).json({ error: 'scan_job_id is required' });
    return;
  }

  try {
    // 1. Raise the cancel flag first so any job that starts mid-cancel sees it.
    //    24h TTL so the flag self-cleans even if nothing ever reads it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const redis: any = await (scanQueue as any).client;
    await redis.set(`cancelled:${scanJobId}`, '1', 'EX', 86_400);

    // 2. Remove every still-pending job (the crawl job + any queued page scans).
    //    Active jobs can't be removed (locked) — the flag stops those instead.
    const pending = await scanQueue.getJobs(['waiting', 'delayed', 'prioritized', 'paused', 'wait']);
    let removed = 0;
    for (const job of pending) {
      if (job?.data?.scan_job_id === scanJobId) {
        await job.remove().then(() => { removed++; }).catch(() => { /* became active; flag handles it */ });
      }
    }

    // 3. Snapshot partial completion counts and callback URL before cleaning up.
    const [callbackUrl, succeededStr, failedStr] = await Promise.all([
      redis.get(`meta:${scanJobId}:callback_url`),
      redis.hget(`completion:${scanJobId}`, 'succeeded'),
      redis.hget(`completion:${scanJobId}`, 'failed'),
    ]);
    const succeeded = parseInt(succeededStr ?? '0', 10);
    const failed = parseInt(failedStr ?? '0', 10);

    // 4. Drop the completion counter so no stray 'complete' callback fires.
    await Promise.all([
      redis.del(`completion:${scanJobId}`),
      redis.del(`meta:${scanJobId}:callback_url`),
    ]);

    console.log(`[job:${scanJobId}] cancelled — removed ${removed} pending job(s); active scans will stop`);
    res.status(200).json({ scan_job_id: scanJobId, cancelled: true, removed_pending: removed });

    // 5. Fire cancelled callback after responding (non-blocking for the caller).
    if (callbackUrl) {
      await postCallback(callbackUrl, {
        event: 'cancelled',
        scan_job_id: scanJobId,
        succeeded,
        failed,
        removed_pending: removed,
      });
    }
  } catch (err) {
    console.error(`[job:${scanJobId}] cancel failed:`, err);
    res.status(503).json({ error: 'Cancel failed, please retry' });
  }
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

export default app;
