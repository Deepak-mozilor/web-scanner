/**
 * lighthouse-runner.ts — standalone Lighthouse runner, invoked as a forked child
 * process (one per scan) by runScan() in scanner.ts.
 *
 * Why a separate process: Lighthouse uses Node's process-global `performance`
 * namespace, so two runs in the same process clobber each other's marks
 * ("performance mark has not been set"). Giving every run its own process makes
 * concurrent scans safe — the same approach unlighthouse uses.
 *
 * Contract:
 *   argv[2] = JSON spec { url, strategy, categories }
 *   argv[3] = output file path
 * Writes a JSON RunnerOutput to the output path, then exits 0.
 */
import puppeteer from 'puppeteer';
import { promises as fs } from 'fs';
import { PUPPETEER_ARGS, lighthouseFlags, type Strategy } from './scanner';

interface RunSpec {
  url: string;
  strategy: Strategy;
  categories: string[];
}

async function main(): Promise<void> {
  const spec = JSON.parse(process.argv[2]) as RunSpec;
  const outPath = process.argv[3];

  let output: unknown;
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;

  try {
    // Dynamic import because lighthouse 10+ is ESM-only.
    const { default: lighthouse } = await import('lighthouse');

    console.log('[runner] launching Chrome');
    browser = await puppeteer.launch({ headless: true, args: PUPPETEER_ARGS });
    const page = await browser.newPage();
    console.log(`[runner] running Lighthouse on ${spec.url} (${spec.strategy})`);

    const result = await lighthouse(spec.url, lighthouseFlags(spec.strategy, spec.categories), undefined, page);
    if (!result) throw Object.assign(new Error('Lighthouse returned no result'), { code: 'NO_RESULT' });

    const pageTitle = await page.title().catch(() => '');
    output = { ok: true, lhr: result.lhr, pageTitle };
  } catch (err) {
    output = {
      ok: false,
      code: (err as { code?: string }).code ?? null,
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (browser) await browser.close().catch(() => { /* already gone */ });
  }

  await fs.writeFile(outPath, JSON.stringify(output));
  process.exit(0);
}

main().catch(async (err) => {
  // Last-resort: still leave a readable failure for the parent.
  try {
    await fs.writeFile(process.argv[3], JSON.stringify({ ok: false, code: 'RUNNER_CRASH', message: String(err) }));
  } catch { /* nothing more we can do */ }
  process.exit(1);
});
