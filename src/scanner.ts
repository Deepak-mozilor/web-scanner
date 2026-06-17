import puppeteer from 'puppeteer';
import type { RunnerResult } from 'lighthouse';

export type Strategy = 'mobile' | 'desktop';

export class ScanError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
  ) {
    super(message);
    this.name = 'ScanError';
  }
}

// Lighthouse error codes that mean the URL itself is bad (caller error → 4xx)
const CLIENT_ERROR_CODES = new Set([
  'DNS_FAILURE',
  'FAILED_DOCUMENT_REQUEST',
  'ERRORED_DOCUMENT_REQUEST',
  'INSECURE_DOCUMENT_REQUEST',
  'NOT_HTML',
  'NO_FCP',
  'PAGE_HUNG',
  'PROTOCOL_TIMEOUT',
]);

const LH_ERROR_MESSAGES: Record<string, string> = {
  DNS_FAILURE: 'URL could not be reached: DNS lookup failed',
  FAILED_DOCUMENT_REQUEST: 'URL could not be loaded',
  ERRORED_DOCUMENT_REQUEST: 'URL returned an error response',
  INSECURE_DOCUMENT_REQUEST: 'URL has an SSL/TLS error',
  NOT_HTML: 'URL did not return an HTML page',
  NO_FCP: 'Page loaded but never rendered any content',
  PAGE_HUNG: 'Page became unresponsive',
  PROTOCOL_TIMEOUT: 'Browser timed out communicating with the page',
};

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

export const PUPPETEER_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--enable-features=NetworkService,NetworkServiceInProcess',
];

// Lighthouse uses the global performance namespace (performance.mark / clearMarks).
// Running two Lighthouse instances concurrently in the same Node process causes
// "performance mark has not been set" errors. This mutex ensures only one scan
// runs at a time across all jobs.
let lighthouseQueue: Promise<void> = Promise.resolve();

export async function runScan(options: ScanOptions): Promise<RunnerResult> {
  const {
    url,
    strategy = 'desktop',
    categories = ['performance', 'accessibility', 'best-practices', 'seo'],
    timeout = 60_000,
  } = options;

  // Wait for any in-flight Lighthouse scan to finish before starting this one
  let release!: () => void;
  const previous = lighthouseQueue;
  lighthouseQueue = new Promise<void>(resolve => (release = resolve));
  await previous;

  // Dynamic import because lighthouse 10+ is ESM-only
  const { default: lighthouse } = await import('lighthouse');

  console.log(`[scanner] launching Chrome`);
  const browser = await puppeteer.launch({
    headless: 'shell',
    args: PUPPETEER_ARGS,
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
    if (!result) throw new ScanError('Lighthouse returned no result', 'NO_RESULT', 500);
    console.log(`[scanner] Lighthouse finished`);
    return result;
  } catch (err) {
    if (err instanceof ScanError) throw err;

    const message = err instanceof Error ? err.message : String(err);
    const lhCode = (err as { code?: string }).code;

    if (message.includes('timed out')) {
      throw new ScanError(`Scan timed out after ${timeout}ms`, 'TIMEOUT', 504);
    }
    if (lhCode && CLIENT_ERROR_CODES.has(lhCode)) {
      throw new ScanError(LH_ERROR_MESSAGES[lhCode] ?? 'URL could not be loaded', lhCode, 400);
    }
    throw err;
  } finally {
    await browser.close();
    console.log(`[scanner] Chrome closed`);
    release();
  }
}
