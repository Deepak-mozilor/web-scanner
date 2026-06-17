import express, { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { Strategy } from './scanner';
import { scanQueue, ScanJobData } from './queue';

const app = express();
app.use(express.json());

if (process.env.LOAD_TEST_MODE !== 'true') {
  app.use(
    '/scan',
    rateLimit({
      windowMs: 60_000,
      max: 3,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Too many scan requests, please try again later' },
    })
  );
} else {
  console.warn('[server] LOAD_TEST_MODE=true — rate limiter disabled');
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

app.post('/scan', async (req: Request<object, object, ScanBody>, res: Response) => {
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

  if (typeof crawl_limit !== 'number' || crawl_limit < 1 || crawl_limit > 20) {
    res.status(400).json({ error: 'crawl_limit must be a number between 1 and 20' });
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

  const jobData: ScanJobData = { url, scan_job_id, callback_url, strategy, categories, timeout, crawl_limit };

  try {
    await scanQueue.add('scan', jobData, { jobId: scan_job_id });
  } catch (err) {
    console.error(`[job:${scan_job_id}] failed to enqueue:`, err);
    res.status(503).json({ error: 'Queue temporarily unavailable, please retry' });
    return;
  }

  console.log(`[job:${scan_job_id}] enqueued url=${url} strategy=${strategy}`);
  res.status(202).json({ scan_job_id, message: 'Scan queued — crawling will discover pages', root_url: url });
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

export default app;
