import { Worker, Job, UnrecoverableError } from 'bullmq';
import { runScan, ScanError } from './scanner';
import { parseResults } from './parser';
import { createRedisConnection, ScanJobData, QUEUE_NAME } from './queue';

async function postCallback(callbackUrl: string, body: unknown): Promise<void> {
  try {
    const res = await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.warn(`[callback] POST ${callbackUrl} → ${res.status}`);
  } catch (err) {
    console.error(`[callback] POST ${callbackUrl} failed: ${(err as Error).message}`);
  }
}

async function processJob(job: Job<ScanJobData>): Promise<void> {
  const { url, scan_job_id, callback_url, strategy, categories, timeout } = job.data;

  if (!url || !scan_job_id || !callback_url) {
    throw new UnrecoverableError(`[job:${scan_job_id}] malformed payload`);
  }

  console.log(`[job:${scan_job_id}] attempt=${job.attemptsMade + 1} scanning ${url}`);

  try {
    const raw = await runScan({ url, strategy, categories, timeout });
    const data = parseResults(raw, strategy);
    await postCallback(callback_url, { scan_job_id, url, success: true, data });
  } catch (err) {
    console.error(`[job:${scan_job_id}] scan failed for ${url}:`, err);
    const detail = err instanceof ScanError
      ? { error: err.message, code: err.code }
      : { error: (err as Error).message ?? 'Scan failed', code: 'CHROME_ERROR' };
    await postCallback(callback_url, { scan_job_id, url, success: false, ...detail });
  }

  console.log(`[job:${scan_job_id}] done`);
}

export function startWorker(): Worker<ScanJobData> {
  console.log(`[worker] starting`);

  const worker = new Worker<ScanJobData>(QUEUE_NAME, processJob, {
    connection: createRedisConnection(),
    concurrency: 5,
    lockDuration: 300_000,
    lockRenewTime: 100_000,
  });

  worker.on('completed', (job) =>
    console.log(`[worker] job ${job.id} (${job.data.scan_job_id}) completed`));
  worker.on('failed', (job, err) =>
    console.error(`[worker] job ${job?.id} (${job?.data?.scan_job_id}) failed attempt=${job?.attemptsMade}: ${err.message}`));
  worker.on('error', (err) =>
    console.error('[worker] connection error:', err));

  return worker;
}
