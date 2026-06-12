import express, { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { runScan, Strategy } from './scanner';
import { parseResults } from './parser';

const app = express();
app.use(express.json());

app.use(
  '/scan',
  rateLimit({
    windowMs: 60_000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many scan requests, please try again later' },
  })
);

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
  strategy?: Strategy;
  categories?: string[];
  timeout?: number;
}

app.post('/scan', async (req: Request<object, object, ScanBody>, res: Response) => {
  const { url, strategy = 'desktop', categories, timeout } = req.body;

  if (!url) {
    res.status(400).json({ error: 'url is required' });
    return;
  }

  if (isSsrfUrl(url)) {
    res.status(400).json({ error: 'invalid url' });
    return;
  }

  if (strategy && !['mobile', 'desktop'].includes(strategy)) {
    res.status(400).json({ error: 'strategy must be "mobile" or "desktop"' });
    return;
  }

  if (categories !== undefined) {
    if (!Array.isArray(categories) || categories.some(c => !ALLOWED_CATEGORIES.has(c))) {
      res.status(400).json({ error: `categories must be an array of: ${[...ALLOWED_CATEGORIES].join(', ')}` });
      return;
    }
  }

  if (timeout !== undefined) {
    if (typeof timeout !== 'number' || timeout < 5_000 || timeout > 120_000) {
      res.status(400).json({ error: 'timeout must be a number between 5000 and 120000' });
      return;
    }
  }

  console.log(`[scan] start  url=${url} strategy=${strategy}`);
  const t0 = Date.now();
  try {
    const raw = await runScan({ url, strategy, categories, timeout });
    const data = parseResults(raw, strategy);
    console.log(`[scan] done   url=${url} elapsed=${Date.now() - t0}ms`);
    res.json({ success: true, data });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[scan] error  url=${url} elapsed=${Date.now() - t0}ms error=${message}`);
    res.status(500).json({ success: false, error: 'Scan failed' });
  }
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

export default app;
