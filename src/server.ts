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

  try {
    const raw = await runScan({ url, strategy, categories, timeout });
    const data = parseResults(raw, strategy);
    res.json({ success: true, data });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: message });
  }
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

export default app;
