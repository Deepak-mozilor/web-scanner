/**
 * load-test.js — Find the limits of the web-scanner API
 *
 * Usage: node load-test.js
 *
 * Starts a local callback receiver on port 4001, then fires waves of
 * concurrent POST /scan requests with increasing concurrency:
 *   1 → 2 → 3 → 5 → 10 simultaneous jobs
 *
 * Prints a summary table after each wave showing 202s, 429s, 500s,
 * response latency, and callback completion rate.
 */

const http = require('http');

const SCANNER_URL = 'http://localhost:3000/scan';
const CALLBACK_PORT = 4001;
const CALLBACK_URL = `http://localhost:${CALLBACK_PORT}/results`;
const WAVES = [90];
const WAVE_TIMEOUT_MS = 3 * 60 * 1000; // 3 min max per wave

// Heavy site to actually stress Chrome instances
const TEST_URLS = ['https://www.apple.com'];

// ─── Callback receiver ────────────────────────────────────────────────────────

/** Map of scan_job_id → { resolve, timer } for pending "complete" events */
const pendingJobs = new Map();

const callbackServer = http.createServer((req, res) => {
  if (req.method !== 'POST') { res.end(); return; }

  let body = '';
  req.on('data', chunk => (body += chunk));
  req.on('end', () => {
    res.writeHead(200);
    res.end('ok');
    try {
      const payload = JSON.parse(body);
      if (payload.event === 'complete') {
        const pending = pendingJobs.get(payload.scan_job_id);
        if (pending) {
          clearTimeout(pending.timer);
          pendingJobs.delete(payload.scan_job_id);
          pending.resolve(payload);
        }
      }
    } catch { /* ignore parse errors */ }
  });
});

function waitForComplete(jobId, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingJobs.delete(jobId);
      resolve({ timed_out: true, scan_job_id: jobId });
    }, timeoutMs);
    pendingJobs.set(jobId, { resolve, timer });
  });
}

// ─── Single request ───────────────────────────────────────────────────────────

let jobCounter = 0;

async function sendScanRequest(waveIndex, jobIndex) {
  const jobId = `wave${waveIndex}-job${jobIndex}-${++jobCounter}`;
  const start = Date.now();

  const completePromise = waitForComplete(jobId, WAVE_TIMEOUT_MS);

  let status, accepted;
  try {
    const res = await fetch(SCANNER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urls: TEST_URLS,
        scan_job_id: jobId,
        callback_url: CALLBACK_URL,
        strategy: 'desktop',
        categories: ['performance'],
        timeout: 60000,
      }),
    });
    status = res.status;
    accepted = status === 202;
  } catch (err) {
    return { jobId, status: 'network_error', latencyMs: Date.now() - start, accepted: false, completed: false };
  }

  const latencyMs = Date.now() - start;

  let completed = false;
  if (accepted) {
    const result = await completePromise;
    completed = !result.timed_out;
  } else {
    // Not accepted — cancel the pending wait
    const pending = pendingJobs.get(jobId);
    if (pending) { clearTimeout(pending.timer); pendingJobs.delete(jobId); }
  }

  return { jobId, status, latencyMs, accepted, completed };
}

// ─── Wave runner ─────────────────────────────────────────────────────────────

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function runWave(waveIndex, concurrency) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Wave ${waveIndex}: ${concurrency} concurrent job(s)`);
  console.log(`${'─'.repeat(60)}`);

  const jobs = Array.from({ length: concurrency }, (_, i) =>
    sendScanRequest(waveIndex, i + 1)
  );

  const results = await Promise.all(jobs);

  const statuses = {};
  const latencies = [];
  let completedCount = 0;
  let acceptedCount = 0;

  for (const r of results) {
    const key = String(r.status);
    statuses[key] = (statuses[key] || 0) + 1;
    latencies.push(r.latencyMs);
    if (r.accepted) acceptedCount++;
    if (r.completed) completedCount++;
  }

  const sorted = [...latencies].sort((a, b) => a - b);

  console.log(`  Responses:`);
  for (const [code, count] of Object.entries(statuses)) {
    const label = code === '202' ? '✅ 202 Accepted' : code === '429' ? '⛔ 429 Too Many' : `❌ ${code}`;
    console.log(`    ${label}: ${count}/${concurrency}`);
  }
  console.log(`  Latency (time to 202/4xx):`);
  console.log(`    p50=${percentile(sorted, 50)}ms  p95=${percentile(sorted, 95)}ms  max=${sorted[sorted.length - 1]}ms`);
  console.log(`  Callbacks:  ${completedCount}/${acceptedCount} jobs completed (${acceptedCount - completedCount} timed out)`);

  return { concurrency, statuses, acceptedCount, completedCount };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  await new Promise(resolve => callbackServer.listen(CALLBACK_PORT, resolve));
  console.log(`Callback receiver listening on port ${CALLBACK_PORT}`);
  console.log(`Scanner target: ${SCANNER_URL}`);
  console.log(`Test URLs per job: ${JSON.stringify(TEST_URLS)}`);

  const summary = [];

  for (let i = 0; i < WAVES.length; i++) {
    const result = await runWave(i + 1, WAVES[i]);
    summary.push(result);

    // Pause between waves to let Chrome instances clean up
    if (i < WAVES.length - 1) {
      console.log(`\nPausing 10s before next wave...`);
      await new Promise(r => setTimeout(r, 10_000));
    }
  }

  // ── Summary table ──────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(60)}`);
  console.log('SUMMARY');
  console.log(`${'═'.repeat(60)}`);
  console.log(`${'Concurrency'.padEnd(14)} ${'202'.padEnd(6)} ${'429'.padEnd(6)} ${'500'.padEnd(6)} ${'Completed'.padEnd(12)}`);
  console.log(`${'─'.repeat(60)}`);
  for (const r of summary) {
    const s = r.statuses;
    console.log(
      `${String(r.concurrency).padEnd(14)} ` +
      `${String(s['202'] || 0).padEnd(6)} ` +
      `${String(s['429'] || 0).padEnd(6)} ` +
      `${String(s['500'] || 0).padEnd(6)} ` +
      `${r.completedCount}/${r.acceptedCount}`
    );
  }
  console.log(`${'═'.repeat(60)}`);
  console.log('Done.');

  callbackServer.close();
  process.exit(0);
}

main().catch(err => {
  console.error('Load test failed:', err);
  process.exit(1);
});
