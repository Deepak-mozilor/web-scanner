import { Worker, Job, UnrecoverableError } from 'bullmq';
import { runScan, ScanError } from './scanner';
import { parseResults } from './parser';
import { crawlUrls } from './crawler';
import { postCallback } from './callback';
import { createRedisConnection, scanQueue, CrawlJobData, ScanJobData, AnyJobData, QUEUE_NAME } from './queue';

async function isCancelled(scanJobId: string): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const redis: any = await (scanQueue as any).client;
  return (await redis.exists(`cancelled:${scanJobId}`)) === 1;
}


async function processCrawlJob(job: Job<CrawlJobData>): Promise<void> {
  const { url, scan_job_id, callback_url, strategy, categories, timeout, crawl_limit } = job.data;

  if (!url || !scan_job_id || !callback_url) {
    throw new UnrecoverableError(`[crawl:${scan_job_id}] malformed payload`);
  }

  console.log(`[crawl:${scan_job_id}] crawling ${url} (limit=${crawl_limit})`);

  let urls: string[];
  try {
    urls = await crawlUrls(url, crawl_limit);
  } catch (err) {
    console.warn(`[crawl:${scan_job_id}] crawl failed — falling back to root URL: ${(err as Error).message}`);
    urls = [url];
  }

  console.log(`[crawl:${scan_job_id}] discovered ${urls.length} url(s):`);
  urls.forEach((u, i) => console.log(`  ${i + 1}. ${u}`));

  // A cancel may have arrived during the crawl fetch — don't enqueue any scans.
  if (await isCancelled(scan_job_id)) {
    console.log(`[crawl:${scan_job_id}] cancelled before enqueueing scans — aborting`);
    return;
  }

  // Initialise Redis completion counter + store callback_url for the cancel endpoint
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const redis: any = await (scanQueue as any).client;
  await redis.hset(`completion:${scan_job_id}`, 'total', String(urls.length), 'done', '0', 'succeeded', '0', 'failed', '0');
  await redis.expire(`completion:${scan_job_id}`, 86400);
  await redis.set(`meta:${scan_job_id}:callback_url`, callback_url, 'EX', 86400);

  // Enqueue one scan job per discovered URL
  for (let i = 0; i < urls.length; i++) {
    const pageUrl = urls[i];
    const scanJobId = `${scan_job_id}-page-${i}`;
    await scanQueue.add('scan', {
      url: pageUrl,
      scan_job_id,
      callback_url,
      strategy,
      categories,
      timeout,
      total_pages: urls.length,
    } as ScanJobData, { jobId: scanJobId });
    console.log(`[crawl:${scan_job_id}] queued scan job ${i + 1}/${urls.length} → ${pageUrl}`);
  }

  console.log(`[crawl:${scan_job_id}] all ${urls.length} scan jobs enqueued`);
}

async function processScanJob(job: Job<ScanJobData>): Promise<void> {
  const { url, scan_job_id, callback_url, strategy, categories, timeout, total_pages } = job.data;

  if (!url || !scan_job_id || !callback_url) {
    throw new UnrecoverableError(`[scan:${scan_job_id}] malformed payload`);
  }

  // Cancelled before this job even started — skip without scanning or counting.
  if (await isCancelled(scan_job_id)) {
    console.log(`[scan:${scan_job_id}] cancelled — skipping (not started) ${url}`);
    return;
  }

  console.log(`[scan:${scan_job_id}] attempt=${job.attemptsMade + 1} scanning ${url}`);

  let success = false;
  try {
    const raw = await runScan({ url, strategy, categories, timeout, shouldCancel: () => isCancelled(scan_job_id) });
    // Cancel may have landed while Lighthouse was running — throw the result away.
    if (await isCancelled(scan_job_id)) {
      console.log(`[scan:${scan_job_id}] cancelled mid-scan — discarding result for ${url}`);
      return;
    }
    const data = parseResults(raw, strategy);
    success = true;
    await postCallback(callback_url, { scan_job_id, url, success: true, data });
  } catch (err) {
    if (err instanceof ScanError && err.code === 'CANCELLED') {
      console.log(`[scan:${scan_job_id}] cancelled — skipped ${url}`);
      return;
    }
    // In-flight scan that errored/timed out after a cancel landed — swallow it,
    // don't send a spurious failure callback for a job the caller cancelled.
    if (await isCancelled(scan_job_id)) {
      console.log(`[scan:${scan_job_id}] cancelled during scan — discarding error for ${url}`);
      return;
    }
    console.error(`[scan:${scan_job_id}] failed for ${url}:`, err);
    const detail = err instanceof ScanError
      ? { error: err.message, code: err.code }
      : { error: (err as Error).message ?? 'Scan failed', code: 'CHROME_ERROR' };
    await postCallback(callback_url, { scan_job_id, url, success: false, ...detail });
  }

  // Atomically increment the completion counter
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const redis: any = await (scanQueue as any).client;
  await redis.hincrby(`completion:${scan_job_id}`, success ? 'succeeded' : 'failed', 1);
  const done: number = parseInt(await redis.hincrby(`completion:${scan_job_id}`, 'done', 1), 10);

  console.log(`[scan] done (${done}/${total_pages}) — ${url}`);

  if (done === total_pages) {
    const [succeededStr, failedStr] = await Promise.all([
      redis.hget(`completion:${scan_job_id}`, 'succeeded'),
      redis.hget(`completion:${scan_job_id}`, 'failed'),
    ]);
    const succeeded = parseInt(succeededStr ?? '0', 10);
    const failed = parseInt(failedStr ?? '0', 10);

    console.log(`[scan:${scan_job_id}] ✓ all ${total_pages} complete — succeeded=${succeeded} failed=${failed}`);

    await postCallback(callback_url, {
      event: 'complete',
      scan_job_id,
      total_urls: total_pages,
      succeeded,
      failed,
    });

    await redis.del(`completion:${scan_job_id}`);
  }
}

export function startWorker(): Worker<AnyJobData, void, 'crawl' | 'scan'> {
  console.log('[worker] starting');

  const worker = new Worker<AnyJobData, void, 'crawl' | 'scan'>(QUEUE_NAME, async (job) => {
    if (job.name === 'crawl') return processCrawlJob(job as Job<CrawlJobData>);
    if (job.name === 'scan') return processScanJob(job as Job<ScanJobData>);
    throw new UnrecoverableError(`Unknown job type: ${job.name}`);
  }, {
    connection: createRedisConnection(),
    concurrency: 5,
    lockDuration: 300_000,
    lockRenewTime: 100_000,
  });

  worker.on('completed', (job) =>
    console.log(`[worker] job ${job.id} (${job.name}) completed`));
  worker.on('failed', (job, err) =>
    console.error(`[worker] job ${job?.id} (${job?.name}) failed attempt=${job?.attemptsMade}: ${err.message}`));
  worker.on('error', (err) =>
    console.error('[worker] connection error:', err));

  return worker;
}
