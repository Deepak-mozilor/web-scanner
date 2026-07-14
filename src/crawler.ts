import puppeteer from 'puppeteer';
import { PUPPETEER_ARGS, DESKTOP_UA } from './scanner';

const SKIP_EXTENSIONS = /\.(css|js|jsx|ts|tsx|png|jpg|jpeg|gif|svg|ico|webp|woff|woff2|ttf|eot|pdf|zip|mp4|mp3|mov|avi|json|xml|txt|csv|webmanifest|rss|atom|feed)$/i;
const SKIP_PATH_PREFIXES = ['/api/', '/static/', '/_next/', '/assets/', '/wp-content/', '/wp-admin/', '/cdn-cgi/'];

// Matches /ae/, /ae-ar/, /en-us/, /zh-hant/ (locale-only paths)
const LOCALE_ONLY_RE = /^\/[a-z]{2,3}(-[a-z]{2,4})?\/?$/i;
// Matches /en-us/anything, /zh-cn/anything (locale-prefixed paths)
const LOCALE_PREFIX_RE = /^\/[a-z]{2}-[a-z]{2,4}\//i;

// Auth/gated/transactional page paths. These are login-walled or empty when
// unauthenticated, so they never paint real content (NO_FCP → null performance)
// and aren't useful scan targets — skip them during discovery.
const AUTH_PATH_RE = /\/(login|signin|sign-in|log-in|signup|sign-up|register|logout|sign-out|forgot-password|reset-password|oauth|auth|account|profile|settings|dashboard|wishlist|cart|checkout|orders?|payments?)\b/i;

function isValidPagePath(path: string): boolean {
  if (SKIP_EXTENSIONS.test(path)) return false;
  if (SKIP_PATH_PREFIXES.some(p => path.startsWith(p))) return false;
  if (LOCALE_ONLY_RE.test(path)) return false;
  if (LOCALE_PREFIX_RE.test(path)) return false;
  if (AUTH_PATH_RE.test(path)) return false;
  return true;
}

function filterLinks(
  hrefs: string[],
  rootUrl: string,
  origin: string,
  seen: Set<string>,
  results: string[],
  limit: number,
): void {
  for (const raw of hrefs) {
    if (results.length >= limit) break;
    if (!raw) continue;
    const trimmed = raw.trim();
    if (
      trimmed.startsWith('#') ||
      trimmed.startsWith('javascript:') ||
      trimmed.startsWith('mailto:') ||
      trimmed.startsWith('tel:')
    ) continue;

    let resolved: URL;
    try {
      resolved = new URL(trimmed, rootUrl);
    } catch {
      continue;
    }

    if (resolved.origin !== origin) continue;

    const path = resolved.pathname;
    if (!isValidPagePath(path)) continue;

    const normalized = origin + path;
    if (seen.has(normalized)) continue;

    seen.add(normalized);
    results.push(normalized);
  }
}

export async function crawlUrls(rootUrl: string, limit = 5): Promise<string[]> {
  const base = new URL(rootUrl);
  const origin = base.origin;
  const seen = new Set<string>();
  const results: string[] = [];

  const normRoot = origin + base.pathname;
  seen.add(normRoot);
  results.push(normRoot);

  // Single-page scan: no link discovery needed. Skip the browser launch + page
  // navigation entirely — the scan step will load the page anyway.
  if (limit <= 1) return results;

  const browser = await puppeteer.launch({
    headless: true,
    // Use a realistic Chrome user-agent (not "WebScanner/1.0") so sites don't
    // serve the crawler a bot-blocked/degraded page. Set at launch instead of page.setUserAgent()
    // (the latter's signature is deprecated in newer Puppeteer).
    args: [...PUPPETEER_ARGS, `--user-agent=${DESKTOP_UA}`],
  });

  try {
    const page = await browser.newPage();

    // 'domcontentloaded' fires once the HTML is parsed — it does NOT wait for
    // network silence, so sites that never go idle (analytics, long-polling,
    // websockets) no longer time out the crawl.
    const response = await page.goto(rootUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    if (!response || !response.ok()) return results;

    // domcontentloaded can fire before JS-rendered nav links exist, so give the
    // page a brief moment for anchors to appear (never throws if none show up).
    await page.waitForSelector('a[href]', { timeout: 3_000 }).catch(() => { /* no anchors yet — proceed anyway */ });

    // Phase 1: links from <nav> and <header> — querySelectorAll handles nested elements correctly
    const navHrefs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('nav a[href], header a[href]'))
        .map(a => (a as HTMLAnchorElement).getAttribute('href') ?? '')
    );
    filterLinks(navHrefs, rootUrl, origin, seen, results, limit);

    // Phase 2: all <a href> links if nav/header didn't fill the quota
    if (results.length < limit) {
      const allHrefs = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a[href]'))
          .map(a => (a as HTMLAnchorElement).getAttribute('href') ?? '')
      );
      filterLinks(allHrefs, rootUrl, origin, seen, results, limit);
    }
  } finally {
    await browser.close();
  }

  return results;
}
