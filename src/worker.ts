import { Worker, Job, UnrecoverableError } from 'bullmq';
import { runScan, ScanError, Strategy } from './scanner';
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

  console.log(`[crawl:${scan_job_id}] crawling ${url} (limit=${crawl_limit}, strategy=${strategy})`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const redis: any = await (scanQueue as any).client;

  // Initialise the counter BEFORE crawling so no scan job that gets picked up
  // during enqueueing can race against an uninitialised counter.
  // We use crawl_limit as a temporary ceiling; we update 'total' once the real
  // URL count is known. 'done' starts at 0 and is only incremented by scan jobs,
  // so initialising early is safe.
  await redis.hset(`completion:${scan_job_id}`, 'total', String(crawl_limit), 'done', '0', 'succeeded', '0', 'failed', '0');
  await redis.expire(`completion:${scan_job_id}`, 86400);

  // Discover up to 2× the requested pages: the first crawl_limit are scanned,
  // the rest become a backup pool to swap in when a scan fails.
  let discovered: string[];
  try {
    discovered = await crawlUrls(url, crawl_limit * 2);
  } catch (err) {
    console.warn(`[crawl:${scan_job_id}] crawl failed — falling back to root URL: ${(err as Error).message}`);
    discovered = [url];
  }

  const primary = discovered.slice(0, crawl_limit);   // scanned now (the "slots")
  const backups = discovered.slice(crawl_limit);      // reserve for replacements

  // One slot (= one combined callback) per primary URL. 'total' is the slot count;
  // each slot is finalised by a successful scan, or by a failure once backups run out.
  await redis.hset(`completion:${scan_job_id}`, 'total', String(primary.length));

  // Stash the backup URLs so a failing scan can pull a replacement (LPOP).
  if (backups.length > 0) {
    await redis.rpush(`backup:${scan_job_id}`, ...backups);
    await redis.expire(`backup:${scan_job_id}`, 86400);
  }

  console.log(`[crawl:${scan_job_id}] discovered ${discovered.length} url(s) — ${primary.length} to scan, ${backups.length} backup(s):`);
  primary.forEach((u, i) => console.log(`  ${i + 1}. ${u}`));

  // A cancel may have arrived during the crawl — don't enqueue any scans.
  if (await isCancelled(scan_job_id)) {
    console.log(`[crawl:${scan_job_id}] cancelled before enqueueing scans — aborting`);
    return;
  }

  // Store callback_url so the cancel endpoint can fire it without job.data access.
  await redis.set(`meta:${scan_job_id}:callback_url`, callback_url, 'EX', 86400);

  // Enqueue one scan job per primary URL. Slot 0 is the submitted root URL
  // (crawlUrls always returns it first) — flag it so it's never replaced.
  for (let i = 0; i < primary.length; i++) {
    const pageUrl = primary[i];
    const scanJobId = `${scan_job_id}-page-${i}`;
    await scanQueue.add('scan', {
      url: pageUrl,
      scan_job_id,
      callback_url,
      strategy,
      categories,
      timeout,
      total_pages: primary.length,
      isRoot: i === 0,
    } as ScanJobData, { jobId: scanJobId });
    console.log(`[crawl:${scan_job_id}] queued scan job ${i + 1}/${primary.length}${i === 0 ? ' [root]' : ''} → ${pageUrl}`);
  }

  console.log(`[crawl:${scan_job_id}] all ${primary.length} scan jobs enqueued (${backups.length} backup url(s) held)`);
}

async function processScanJob(job: Job<ScanJobData>): Promise<void> {
  const { url, scan_job_id, callback_url, strategy, categories, timeout, total_pages, isRoot } = job.data;

  if (!url || !scan_job_id || !callback_url) {
    throw new UnrecoverableError(`[scan:${scan_job_id}] malformed payload`);
  }

  // Cancelled before this job even started — skip without scanning or counting.
  if (await isCancelled(scan_job_id)) {
    console.log(`[scan:${scan_job_id}] cancelled — skipping (not started) ${url}`);
    return;
  }

  // 'both' runs desktop + mobile for this URL; otherwise just the one strategy.
  const strategies: Strategy[] = strategy === 'both' ? ['desktop', 'mobile'] : [strategy];

  console.log(`[scan:${scan_job_id}] attempt=${job.attemptsMade + 1} scanning ${url} (${strategies.join('+')})`);

  // Run each strategy and collect its outcome. The results are merged into a
  // single callback for this URL — keyed by strategy ("desktop" / "mobile").
  const results: Record<string, unknown> = {};
  let allSucceeded = true;

  for (const strat of strategies) {
    try {
      const raw = await runScan({ url, strategy: strat, categories, timeout, shouldCancel: () => isCancelled(scan_job_id) });
      // Cancel may have landed while Lighthouse was running — abandon the whole job.
      if (await isCancelled(scan_job_id)) {
        console.log(`[scan:${scan_job_id}] cancelled mid-scan — discarding ${url}`);
        return;
      }
      results[strat] = { success: true, data: parseResults(raw, strat) };
      console.log(`[scan:${scan_job_id}] [${strat}] ok — ${url}`);
    } catch (err) {
      if (err instanceof ScanError && err.code === 'CANCELLED') {
        console.log(`[scan:${scan_job_id}] cancelled — skipped ${url}`);
        return;
      }
      // In-flight scan that errored/timed out after a cancel landed — abandon silently.
      if (await isCancelled(scan_job_id)) {
        console.log(`[scan:${scan_job_id}] cancelled during scan — discarding ${url}`);
        return;
      }
      console.error(`[scan:${scan_job_id}] [${strat}] failed for ${url}:`, err);
      const detail = err instanceof ScanError
        ? { error: err.message, code: err.code }
        : { error: (err as Error).message ?? 'Scan failed', code: 'CHROME_ERROR' };
      results[strat] = { success: false, ...detail };
      allSucceeded = false;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const redis: any = await (scanQueue as any).client;

  // `done` is set when this slot is finalised; left null while we hand off to a backup.
  let done: number | null = null;

  if (allSucceeded) {
    // Fully successful (original or recovered backup) → finalise the slot as success.
    await postCallback(callback_url, { scan_job_id, url, total_urls: total_pages, success: true, results });
    await redis.hincrby(`completion:${scan_job_id}`, 'succeeded', 1);
    done = parseInt(await redis.hincrby(`completion:${scan_job_id}`, 'done', 1), 10);
    console.log(`[scan] done (${done}/${total_pages}) ✓ — ${url}`);
  } else {
    // A scan failed — send a failed callback for EVERY failure (original or backup).
    await postCallback(callback_url, { scan_job_id, url, total_urls: total_pages, success: false, results });
    console.log(`[scan:${scan_job_id}] failed — sent failed callback for ${url}`);

    // The submitted root URL is never replaced — if it fails, that's the slot's
    // outcome. Other slots try to recover with a backup URL.
    if (!isRoot) {
      const backupUrl: string | null = await redis.lpop(`backup:${scan_job_id}`);
      if (backupUrl) {
        const seq = await redis.incr(`replaceseq:${scan_job_id}`);
        const replacementJobId = `${scan_job_id}-page-replace-${seq}`;
        await scanQueue.add('scan', {
          url: backupUrl,
          scan_job_id,
          callback_url,
          strategy,
          categories,
          timeout,
          total_pages,
          isReplacement: true,
        } as ScanJobData, { jobId: replacementJobId });
        console.log(`[scan:${scan_job_id}] trying backup ${backupUrl}`);
        return;   // slot not finalised; the backup scan will finalise it
      }
    }

    // Root failure, or a non-root slot with no backups left → finalise as failed
    // (the failed callback was already sent above for the original attempt).
    // Record the URL so the 'complete' callback can report the failed list.
    await redis.rpush(`failed_urls:${scan_job_id}`, url);
    await redis.expire(`failed_urls:${scan_job_id}`, 86400);
    await redis.hincrby(`completion:${scan_job_id}`, 'failed', 1);
    done = parseInt(await redis.hincrby(`completion:${scan_job_id}`, 'done', 1), 10);
    console.log(`[scan] done (${done}/${total_pages}) ✗ ${isRoot ? 'root not replaced' : 'no backups left'} — ${url}`);
  }

  // Use >= to handle BullMQ retries that can push done past total_pages.
  // The NX flag ensures only one job fires the complete event even when
  // multiple scans reach the threshold in the same tick. (done is null when this
  // job handed off to a backup and didn't finalise — that path already returned.)
  if (done !== null && done >= total_pages) {
    const fired = await redis.set(`completing:${scan_job_id}`, '1', 'EX', 3600, 'NX');
    if (fired) {
      const [succeededStr, failedStr, failedUrls] = await Promise.all([
        redis.hget(`completion:${scan_job_id}`, 'succeeded'),
        redis.hget(`completion:${scan_job_id}`, 'failed'),
        redis.lrange(`failed_urls:${scan_job_id}`, 0, -1),
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
        failed_urls: failedUrls ?? [],
      });

      await redis.del(`completion:${scan_job_id}`, `backup:${scan_job_id}`, `replaceseq:${scan_job_id}`, `failed_urls:${scan_job_id}`);
    }
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
    concurrency: parseInt(process.env.WORKER_CONCURRENCY ?? '1', 10),
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
