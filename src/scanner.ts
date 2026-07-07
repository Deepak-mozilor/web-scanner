import puppeteer, { Browser } from 'puppeteer';
import type { RunnerResult } from 'lighthouse';

// A single concrete strategy a Lighthouse run uses.
export type Strategy = 'mobile' | 'desktop';
// What the API accepts: a concrete strategy, or 'both' (scan mobile AND desktop).
// 'both' is expanded into two concrete scan jobs at crawl time — runScan itself
// always receives a concrete Strategy.
export type RequestStrategy = Strategy | 'both';

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
  // Checked after the Lighthouse mutex is acquired, just before Chrome launches.
  // Lets a cancelled job bail out instead of starting a scan it will throw away.
  shouldCancel?: () => boolean | Promise<boolean>;
}

const DESKTOP_SCREEN = {
  mobile: false,
  width: 1350,
  height: 940,
  deviceScaleFactor: 1,
  disabled: false,
};

// Lighthouse's default throttling presets, applied per form factor to keep each
// one's network + CPU throttling intact.
const MOBILE_THROTTLING = {
  rttMs: 150,
  throughputKbps: 1638.4,
  requestLatencyMs: 562.5,
  downloadThroughputKbps: 1474.5,
  uploadThroughputKbps: 675,
  cpuSlowdownMultiplier: 4,
};
const DESKTOP_THROTTLING = {
  rttMs: 40,
  throughputKbps: 10240,
  requestLatencyMs: 0,
  downloadThroughputKbps: 0,
  uploadThroughputKbps: 0,
  cpuSlowdownMultiplier: 1,
};

export const PUPPETEER_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--enable-features=NetworkService,NetworkServiceInProcess',
  // Force Chromium to test the third-party cookie deprecation.
  // This triggers the exact DevTools Protocol warnings and exclusions
  // that Lighthouse's third-party-cookies audit searches for.
  '--test-third-party-cookie-phaseout'
];

// Lighthouse uses the global performance namespace (performance.mark / clearMarks).
// Running two Lighthouse instances concurrently in the same Node process causes
// "performance mark has not been set" errors. This mutex ensures only one scan
// runs at a time across all jobs.
let lighthouseQueue: Promise<void> = Promise.resolve();

// Shared browser reused across scans to avoid relaunching Chrome for every page.
// Two safeguards keep it healthy:
//   1. Recycle: after MAX_SCANS_PER_BROWSER scans, close + relaunch to bound memory.
//   2. Crash recovery: if the browser died, relaunch on next use (one scan fails, rest recover).
// Safe because getBrowser() is only ever called inside the Lighthouse mutex — one scan
// touches the browser at a time, so there's no concurrent access.
let sharedBrowser: Browser | null = null;
let scansOnBrowser = 0;
const MAX_SCANS_PER_BROWSER = parseInt(process.env.MAX_SCANS_PER_BROWSER ?? '10', 10);

async function getBrowser(): Promise<Browser> {
  const dead = sharedBrowser != null && !sharedBrowser.connected;
  const stale = sharedBrowser != null && scansOnBrowser >= MAX_SCANS_PER_BROWSER;

  if (!sharedBrowser || dead || stale) {
    if (sharedBrowser) {
      console.log(`[scanner] recycling browser (scans=${scansOnBrowser}, dead=${dead})`);
      await sharedBrowser.close().catch(() => { /* already gone */ });
    }
    console.log('[scanner] launching Chrome');
    sharedBrowser = await puppeteer.launch({ headless: true, args: PUPPETEER_ARGS });
    scansOnBrowser = 0;
  }

  scansOnBrowser++;
  return sharedBrowser;
}

// Close the shared browser on process shutdown so Chrome doesn't linger.
export async function closeSharedBrowser(): Promise<void> {
  if (sharedBrowser) {
    await sharedBrowser.close().catch(() => { /* already gone */ });
    sharedBrowser = null;
    scansOnBrowser = 0;
  }
}

export interface ScanResult {
  result: RunnerResult;
  pageTitle: string;    // the audited page's <title>, captured via Puppeteer
}

export async function runScan(options: ScanOptions): Promise<ScanResult> {
  const {
    url,
    strategy = 'desktop',
    categories = ['performance', 'accessibility', 'best-practices', 'seo'],
    timeout = 60_000,
    shouldCancel,
  } = options;

  // Wait for any in-flight Lighthouse scan to finish before starting this one
  let release!: () => void;
  const previous = lighthouseQueue;
  lighthouseQueue = new Promise<void>(resolve => (release = resolve));
  await previous;

  try {
    // The job may have been cancelled while parked behind the mutex. Bail before
    // spending the cost of launching Chrome and running a scan we'd discard.
    if (shouldCancel && (await shouldCancel())) {
      throw new ScanError('Scan cancelled', 'CANCELLED', 499);
    }

    // Dynamic import because lighthouse 10+ is ESM-only
    const { default: lighthouse } = await import('lighthouse');

    // Reuse the shared browser (relaunched periodically / on crash by getBrowser).
    const browser = await getBrowser();
    // Each scan runs in its own isolated context (separate cookies/cache/storage),
    // so reusing the browser doesn't bleed state between pages. Lighthouse audits
    // this Puppeteer-controlled page via the page-based API (4th argument).
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    console.log(`[scanner] Chrome ready (scan ${scansOnBrowser}/${MAX_SCANS_PER_BROWSER})`);

    const flags = {
      output: 'json' as const,
      logLevel: 'error' as const,
      onlyCategories: categories,
      formFactor: strategy,
      ...(strategy === 'desktop' && { screenEmulation: DESKTOP_SCREEN }),
      // Always apply the form factor's throttling preset. Lighthouse's DEFAULT
      // throttling is mobile (slow 4G + 4× CPU), so a 'desktop' formFactor without
      // this silently gets mobile throttling — tanking desktop scores.
      throttling: strategy === 'desktop' ? DESKTOP_THROTTLING : MOBILE_THROTTLING,
    };

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Scan timed out after ${timeout}ms`)), timeout)
    );

    try {
      console.log(`[scanner] running Lighthouse on ${url}`);
      const result = await Promise.race([lighthouse(url, flags, undefined, page), timeoutPromise]);
      if (!result) throw new ScanError('Lighthouse returned no result', 'NO_RESULT', 500);
      // Capture the page <title> while the page is still open (empty string if unavailable).
      const pageTitle = await page.title().catch(() => '');
      const benchmarkIndex = (result.lhr as { environment?: { benchmarkIndex?: number } })?.environment?.benchmarkIndex;
      console.log(`[scanner] Lighthouse finished (benchmarkIndex=${benchmarkIndex ?? '?'})`);
      return { result, pageTitle };
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
      // Close only this scan's context — the browser stays alive for the next scan.
      await context.close().catch(() => { /* browser may have crashed; getBrowser relaunches */ });
      console.log(`[scanner] scan context closed`);
    }
  } finally {
    release();
  }
}
