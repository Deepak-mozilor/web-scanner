import { Queue } from 'bullmq';
import { RequestStrategy } from './scanner';

export interface CrawlJobData {
  url: string;
  scan_job_id: string;
  callback_url: string;
  strategy: RequestStrategy;   // may be 'both' — expanded into per-strategy scan jobs
  categories: string[];
  timeout: number;
  crawl_limit: number;
}

export interface ScanJobData {
  url: string;
  scan_job_id: string;
  callback_url: string;
  strategy: RequestStrategy;   // may be 'both' — the scan job runs each strategy and combines results
  categories: string[];
  timeout: number;
  total_pages: number;         // number of slots (= primary URL count)
  isReplacement?: boolean;     // true for backup URLs swapped in after a failure (failures stay silent)
  isRoot?: boolean;            // true for the submitted root URL — never replaced, even on failure
}

export type AnyJobData = CrawlJobData | ScanJobData;

export const QUEUE_NAME = 'scan';

// Plain connection options — avoids ioredis version conflicts with BullMQ's bundled ioredis
export function createRedisConnection() {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || '6379', 10),
    maxRetriesPerRequest: null as null,
    enableReadyCheck: false,
    retryStrategy: (times: number) => Math.min(times * 200, 10_000),
  };
}

export const scanQueue = new Queue<AnyJobData, void, 'crawl' | 'scan'>(QUEUE_NAME, {
  connection: createRedisConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { age: 3600 },
    removeOnFail: { count: 500 },
  },
});
