import puppeteer from 'puppeteer';
import type { RunnerResult } from 'lighthouse';

export type Strategy = 'mobile' | 'desktop';

export interface ScanOptions {
  url: string;
  strategy?: Strategy;
  categories?: string[];
  timeout?: number;
}

const DESKTOP_SCREEN = {
  mobile: false,
  width: 1350,
  height: 940,
  deviceScaleFactor: 1,
  disabled: false,
};

export async function runScan(options: ScanOptions): Promise<RunnerResult> {
  const {
    url,
    strategy = 'desktop',
    categories = ['performance', 'accessibility', 'best-practices', 'seo'],
    timeout = 60_000,
  } = options;

  // Dynamic import because lighthouse 10+ is ESM-only
  const { default: lighthouse } = await import('lighthouse');

  console.log(`[scanner] launching Chrome`);
  const browser = await puppeteer.launch({
    headless: 'shell',
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--enable-features=NetworkService,NetworkServiceInProcess',
    ],
  });
  const port = new URL(browser.wsEndpoint()).port;
  console.log(`[scanner] Chrome ready on port ${port}`);

  const flags = {
    port: Number(port),
    output: 'json' as const,
    logLevel: 'error' as const,
    onlyCategories: categories,
    formFactor: strategy,
    ...(strategy === 'desktop' && { screenEmulation: DESKTOP_SCREEN }),
  };

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Scan timed out after ${timeout}ms`)), timeout)
  );

  try {
    console.log(`[scanner] running Lighthouse on ${url}`);
    const result = await Promise.race([lighthouse(url, flags), timeoutPromise]);
    if (!result) throw new Error('Lighthouse returned no result');
    console.log(`[scanner] Lighthouse finished`);
    return result;
  } finally {
    await browser.close();
    console.log(`[scanner] Chrome closed`);
  }
}
