const SKIP_EXTENSIONS = /\.(css|js|jsx|ts|tsx|png|jpg|jpeg|gif|svg|ico|webp|woff|woff2|ttf|eot|pdf|zip|mp4|mp3|mov|avi|json|xml|txt|csv|webmanifest|rss|atom|feed)$/i;
const SKIP_PATH_PREFIXES = ['/api/', '/static/', '/_next/', '/assets/', '/wp-content/', '/wp-admin/', '/cdn-cgi/'];

// Matches /ae/, /ae-ar/, /en-us/, /zh-hant/ (locale-only paths)
const LOCALE_ONLY_RE = /^\/[a-z]{2,3}(-[a-z]{2,4})?\/?$/i;
// Matches /en-us/anything, /zh-cn/anything (locale-prefixed paths)
const LOCALE_PREFIX_RE = /^\/[a-z]{2}-[a-z]{2,4}\//i;

// Auth/gated page paths
const AUTH_PATH_RE = /\/(login|signin|sign-in|log-in|signup|sign-up|register|logout|sign-out|forgot-password|reset-password|oauth|auth)\b/i;

function extractTagContent(html: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi');
  const sections: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    sections.push(match[1]);
  }
  return sections;
}

function extractHrefs(html: string): string[] {
  const re = /href=["']([^"']+)["']/gi;
  const hrefs: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    hrefs.push(match[1]);
  }
  return hrefs;
}

function isValidPagePath(path: string): boolean {
  if (SKIP_EXTENSIONS.test(path)) return false;
  if (SKIP_PATH_PREFIXES.some(p => path.startsWith(p))) return false;
  if (LOCALE_ONLY_RE.test(path)) return false;
  if (LOCALE_PREFIX_RE.test(path)) return false;
  if (AUTH_PATH_RE.test(path)) return false;
  return true;
}

function collectLinks(
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
    if (trimmed.startsWith('#') || trimmed.startsWith('javascript:') || trimmed.startsWith('mailto:') || trimmed.startsWith('tel:')) continue;

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

  let html: string;
  try {
    const res = await fetch(rootUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WebYes/1.0)' },
      signal: AbortSignal.timeout(10_000),
      redirect: 'follow',
    });
    if (!res.ok) return results;
    html = await res.text();
  } catch (err) {
    console.warn(`[crawler] fetch failed for ${rootUrl}: ${(err as Error).message}`);
    return results;
  }

  // Phase 1: prefer links from <nav> and <header> sections
  const navSections = [
    ...extractTagContent(html, 'nav'),
    ...extractTagContent(html, 'header'),
  ];

  for (const section of navSections) {
    collectLinks(extractHrefs(section), rootUrl, origin, seen, results, limit);
    if (results.length >= limit) break;
  }

  // Phase 2: fall back to all links on the page if nav didn't fill the quota
  if (results.length < limit) {
    collectLinks(extractHrefs(html), rootUrl, origin, seen, results, limit);
  }

  return results;
}
