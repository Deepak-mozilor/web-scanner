import { fork } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
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
  // Checked before the child process is forked. Lets a cancelled job bail out
  // instead of spending the cost of a scan it will throw away.
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
  '--test-third-party-cookie-phaseout',
];

// The Lighthouse flags for a given form factor. Shared with the child runner
// (lighthouse-runner.ts) so the flag logic lives in exactly one place.
export function lighthouseFlags(strategy: Strategy, categories: string[]) {
  return {
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
}

// No shared browser to close — each scan forks its own process which launches and
// closes its own Chrome. Kept as a no-op so worker.ts's shutdown import resolves.
export async function closeSharedBrowser(): Promise<void> {
  /* nothing to close — Chrome is owned by the per-scan child process */
}

export interface ScanResult {
  result: RunnerResult;
  pageTitle: string;    // the audited page's <title>, captured via Puppeteer
}

// What the child runner writes to its output file.
type RunnerOutput =
  | { ok: true; lhr: RunnerResult['lhr']; pageTitle: string }
  | { ok: false; code: string | null; message: string };

// Each scan runs Lighthouse in its OWN Node process (a forked child). Lighthouse
// uses the process-global `performance` namespace, so two runs in one process
// collide ("performance mark has not been set"). Forking gives every run its own
// global state, making concurrent scans safe without a mutex — this is how tools
// like unlighthouse parallelise. The child launches + closes its own Chrome and
// writes the result to a temp file, which we read back here.
export async function runScan(options: ScanOptions): Promise<ScanResult> {
  const {
    url,
    strategy = 'desktop',
    categories = ['performance', 'accessibility', 'best-practices', 'seo'],
    timeout = 60_000,
    shouldCancel,
  } = options;

  // Bail before forking if the job was already cancelled.
  if (shouldCancel && (await shouldCancel())) {
    throw new ScanError('Scan cancelled', 'CANCELLED', 499);
  }

  const spec = { url, strategy, categories };
  const outPath = path.join(os.tmpdir(), `lh-${randomUUID()}.json`);

  // In dev (ts-node) __filename is a .ts file → run the .ts runner via ts-node's
  // register hook. In prod it's the compiled .js → run it with plain node.
  const isTs = __filename.endsWith('.ts');
  const runnerPath = path.join(__dirname, isTs ? 'lighthouse-runner.ts' : 'lighthouse-runner.js');

  console.log(`[scanner] forking Lighthouse runner for ${url} (${strategy})`);
  const child = fork(runnerPath, [JSON.stringify(spec), outPath], {
    execArgv: isTs ? ['-r', 'ts-node/register'] : [],
  });

  let timer: NodeJS.Timeout | undefined;
  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      // Whole-run timeout: kill the child (and its Chrome) if it overruns.
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new ScanError(`Scan timed out after ${timeout}ms`, 'TIMEOUT', 504));
      }, timeout);
      child.on('exit', (code) => resolve(code ?? 0));
      child.on('error', (err) => reject(err));
    });

    const raw = await fs.readFile(outPath, 'utf8').catch(() => null);
    if (!raw) {
      throw new ScanError(`Lighthouse runner exited (code=${exitCode}) with no result`, 'RUNNER_FAILED', 500);
    }

    const out = JSON.parse(raw) as RunnerOutput;
    if (!out.ok) {
      if (out.code && CLIENT_ERROR_CODES.has(out.code)) {
        throw new ScanError(LH_ERROR_MESSAGES[out.code] ?? 'URL could not be loaded', out.code, 400);
      }
      throw new ScanError(out.message || 'Lighthouse failed', out.code ?? 'CHROME_ERROR', 500);
    }

    const benchmarkIndex = (out.lhr as { environment?: { benchmarkIndex?: number } })?.environment?.benchmarkIndex;
    console.log(`[scanner] Lighthouse finished (benchmarkIndex=${benchmarkIndex ?? '?'})`);
    // parseResults only reads result.lhr, so wrapping the lhr is sufficient.
    return { result: { lhr: out.lhr } as RunnerResult, pageTitle: out.pageTitle ?? '' };
  } finally {
    if (timer) clearTimeout(timer);
    // Ensure the child is dead even on an unexpected path.
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await fs.unlink(outPath).catch(() => { /* never written / already gone */ });
  }
}
