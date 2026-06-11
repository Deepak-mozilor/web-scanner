import express, { Request, Response, NextFunction } from 'express';
import { runScan, Strategy } from './scanner';
import { parseResults } from './parser';

const app = express();
app.use(express.json());

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

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

  try {
    new URL(url);
  } catch {
    res.status(400).json({ error: 'invalid url' });
    return;
  }

  if (strategy && !['mobile', 'desktop'].includes(strategy)) {
    res.status(400).json({ error: 'strategy must be "mobile" or "desktop"' });
    return;
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
    res.status(500).json({ success: false, error: message });
  }
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

export default app;
