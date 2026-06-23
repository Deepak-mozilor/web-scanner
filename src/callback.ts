export async function postCallback(callbackUrl: string, body: unknown): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (process.env.SCANNER_SECRET) headers['X-Scanner-Secret'] = process.env.SCANNER_SECRET;
  try {
    const res = await fetch(callbackUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      console.log(`[callback] POST ${callbackUrl} → ${res.status}`);
    } else {
      const text = await res.text().catch(() => '');
      console.warn(`[callback] POST ${callbackUrl} → ${res.status}`, text);
    }
  } catch (err) {
    console.error(`[callback] POST ${callbackUrl} failed: ${(err as Error).message}`);
  }
}
