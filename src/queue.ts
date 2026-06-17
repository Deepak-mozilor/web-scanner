import { Queue } from 'bullmq';
import { Strategy } from './scanner';

export interface ScanJobData {
  url: string;
  scan_job_id: string;
  callback_url: string;
  strategy: Strategy;
  categories: string[];
  timeout: number;
}

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

export const scanQueue = new Queue<ScanJobData, void, string>(QUEUE_NAME, {
  connection: createRedisConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { age: 3600 },
    removeOnFail: { count: 500 },
  },
});
