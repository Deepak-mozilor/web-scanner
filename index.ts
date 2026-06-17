import app from './src/server';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

const server = app.listen(PORT, () => {
  console.log(`Lighthouse scanner running on http://localhost:${PORT}`);
  console.log('POST /scan  { urls, scan_job_id, callback_url, strategy?, categories?, timeout? }');
  console.log('GET  /health');
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[api] ${signal} — shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
