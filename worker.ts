import 'dotenv/config';
import { startWorker } from './src/worker';

const worker = startWorker();

async function shutdown(signal: string): Promise<void> {
  console.log(`[worker] ${signal} — shutting down`);
  try {
    await worker.close();
    console.log('[worker] shutdown complete');
    process.exit(0);
  } catch (err) {
    console.error('[worker] shutdown error:', err);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
