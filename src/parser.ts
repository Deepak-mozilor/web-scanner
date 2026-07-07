// parser.ts — transforms Lighthouse's huge raw report (RunnerResult) into a
// compact, structured ParsedResult that the backend can store and display.
// Lighthouse output is verbose and deeply nested; this file picks out only the
// fields we care about and groups audits by category and severity.

import type { RunnerResult } from 'lighthouse';

// A single performance metric (e.g. Largest Contentful Paint).
export interface MetricValue {
  value: number | null;      // raw numeric value, e.g. 2100 (ms)
  displayValue: string;      // human-readable, e.g. "2.1 s"
  score: number | null;      // 0–100 contribution to the category score
  numericUnit?: string;      // unit of `value`, e.g. "millisecond"
}

// The headline score for a whole category (performance, accessibility, etc.).
export interface CategoryScore {
  score: number | null;      // 0–100, or null if the category didn't run
  title: string;             // e.g. "Performance"
  description: string;
}

// A single audit result (one check Lighthouse ran), e.g. "render-blocking resources".
export interface AuditItem {
  id: string;                // Lighthouse audit id, e.g. "render-blocking-resources"
  title: string;
  description: string;       // with the trailing "[Learn more](url)" link stripped out
  learnMoreUrl?: string;     // the URL pulled out of that link
  displayValue: string;      // audit-specific summary, e.g. "Potential savings of 450 ms"
  score: number | null;      // 0–100 (0 = critical, <90 = needs work, ≥90 = passed)
  detailsType: string;       // shape of `details`, e.g. "table", "opportunity"
  itemCount?: number;        // how many rows/items the audit flagged
  wastedBytes?: number;      // potential byte savings (performance audits)
  wastedMs?: number;         // potential time savings (performance audits)
  items?: Record<string, unknown>[];  // the raw flagged rows (e.g. each bad image)
  impact?: string;       // axe-core severity: "critical" | "serious" | "moderate" | "minor" (failures only)
  tags?: string[];       // WCAG tags, e.g. ["wcag2a", "wcag143"] (from debugData or the static map)
  level?: string;        // derived WCAG conformance level: "A" | "AA" | "AAA"
  wcagCriterion?: string; // derived success criterion, e.g. "1.1.1" (from the tags)
  wcagVersion?: string;  // derived WCAG version that introduced it, e.g. "2.0"
  affects?: string[];    // user groups impacted, e.g. ["blind", "low vision"] (a11y audits only)
  responsibility?: string; // who typically fixes it: "Development" | "Design" | "Content"
  weight?: number;       // this audit's weight in its category score (0 = diagnostic-only, no score impact)
}

// One row of a Lighthouse "checklist"-style audit (used by insights).
export interface ChecklistItem {
  label: string;
  passed: boolean;
}

// A Lighthouse "insight" — a richer audit with guidance + a checklist breakdown.
export interface InsightItem {
  id: string;
  title: string;
  description: string;
  learnMoreUrl?: string;
  displayValue: string;
  score: number | null;
  guidanceLevel: number;
  metricSavings?: Record<string, number>;
  checklist: Record<string, ChecklistItem>;
}

// A passed audit (score ≥ 0.9). Lighter than AuditItem — no need for the
// flagged-rows detail since nothing failed, but we keep description + link.
export interface PassedAudit {
  id: string;
  title: string;
  description: string;
  learnMoreUrl?: string;
  tags?: string[];       // WCAG tags from the static map (LHR has none on passed audits)
  level?: string;        // derived WCAG conformance level: "A" | "AA" | "AAA"
  wcagCriterion?: string; // derived success criterion, e.g. "1.1.1"
  wcagVersion?: string;  // derived WCAG version, e.g. "2.0"
  weight?: number;       // this audit's weight in its category score (0 = diagnostic-only, no score impact)
}

// Counts across all scoreable audits for the page.
export interface Summary {
  total: number;
  passed: number;
  critical: number;
  nonCritical: number;
}

// An audit Lighthouse can't score automatically — a human must check it.
export interface ManualAudit {
  id: string;
  title: string;
  description: string;
}

// An audit that didn't apply to this page (no matching elements found).
export interface NotApplicableAudit {
  id: string;
  title: string;
}

// All audits for one category, bucketed by outcome. This is the main structure
// the backend uses to render a category's report.
export interface CategoryGroup {
  score: number | null;
  title: string;
  critical: AuditItem[];               // score === 0
  nonCritical: AuditItem[];            // 0 < score < 0.9
  passed: PassedAudit[];               // score ≥ 0.9
  needsReview: ManualAudit[];          // scoreDisplayMode === 'manual'
  notApplicable: NotApplicableAudit[]; // scoreDisplayMode === 'notApplicable'
}

export interface FilmstripFrame {
  timing: number;
  data: string;   // inline: "data:image/...;base64,..."  |  s3: public https URL
}

export interface Screenshots {
  storage: 'inline' | 's3';   // 'inline' = base64 data URIs; 's3' = public https URLs
  final: string | null;       // inline: data URI | s3: public URL | null
  fullPage: string | null;    // inline: data URI | s3: public URL | null
  filmstrip: FilmstripFrame[];
}

// The final object the worker sends to the backend as the per-page scan result.
export interface ParsedResult {
  url: string;
  pageTitle: string;                           // the audited page's <title>
  fetchTime: string;
  strategy: string;                            // "mobile" | "desktop"
  scores: Record<string, CategoryScore>;       // headline score per category
  metrics: Record<string, MetricValue>;        // core web vitals etc.
  insights: InsightItem[];                      // richer guidance audits
  summary: Summary;                             // total/passed/critical counts
  byCategory: Record<string, CategoryGroup>;    // audits grouped per category (each has its own `passed`)
  screenshots: Screenshots;
}

// The six metrics we surface (the Core Web Vitals + a few extras). Lighthouse
// reports these as audits too, so we treat them separately from pass/fail audits.
const METRIC_IDS = new Set([
  'first-contentful-paint',
  'largest-contentful-paint',
  'total-blocking-time',
  'cumulative-layout-shift',
  'interactive',
  'speed-index',
]);

// Lighthouse descriptions end with a markdown link like "... [Learn more](https://...).".
// This regex captures that trailing link so we can split the URL from the prose.
const LEARN_MORE_RE = /\[.*?\]\((https?:\/\/[^)]+)\)\.?\s*$/;

// Pull the "Learn more" URL out of a description (undefined if there isn't one).
function extractLearnMoreUrl(description: string): string | undefined {
  return LEARN_MORE_RE.exec(description)?.[1];
}

// Remove the trailing "Learn more" link so the description reads cleanly.
function stripLearnMoreLink(description: string): string {
  return description.replace(LEARN_MORE_RE, '').trim();
}

// Convert Lighthouse's 0–1 score to a 0–100 integer (null stays null).
function pct(score: number | null | undefined): number | null {
  return score != null ? Math.round(score * 100) : null;
}

// Static map: Lighthouse accessibility audit id → WCAG tags.
// Lighthouse a11y audits map 1:1 to axe-core rules and these tags are stable.
// Needed because Lighthouse only emits tags (via debugData) on FAILING audits —
// passed audits carry none, so we look them up here to attach a WCAG level.
// Audits not listed are "best-practice" (no WCAG level) — e.g. heading-order, tabindex.
const A11Y_WCAG_TAGS: Record<string, string[]> = {
  'aria-allowed-attr': ['wcag2a', 'wcag412'],
  'aria-command-name': ['wcag2a', 'wcag412'],
  'aria-dialog-name': ['wcag2a', 'wcag412'],
  'aria-hidden-body': ['wcag2a', 'wcag412'],
  'aria-hidden-focus': ['wcag2a', 'wcag412'],
  'aria-input-field-name': ['wcag2a', 'wcag412'],
  'aria-meter-name': ['wcag2a', 'wcag111'],
  'aria-progressbar-name': ['wcag2a', 'wcag111'],
  'aria-required-attr': ['wcag2a', 'wcag412'],
  'aria-required-children': ['wcag2a', 'wcag131'],
  'aria-required-parent': ['wcag2a', 'wcag131'],
  'aria-roles': ['wcag2a', 'wcag412'],
  'aria-toggle-field-name': ['wcag2a', 'wcag412'],
  'aria-tooltip-name': ['wcag2a', 'wcag412'],
  'aria-valid-attr-value': ['wcag2a', 'wcag412'],
  'aria-valid-attr': ['wcag2a', 'wcag412'],
  'button-name': ['wcag2a', 'wcag412'],
  'bypass': ['wcag2a', 'wcag241'],
  'color-contrast': ['wcag2aa', 'wcag143'],
  'definition-list': ['wcag2a', 'wcag131'],
  'dlitem': ['wcag2a', 'wcag131'],
  'document-title': ['wcag2a', 'wcag242'],
  'duplicate-id-active': ['wcag2a', 'wcag411'],
  'duplicate-id-aria': ['wcag2a', 'wcag411'],
  'form-field-multiple-labels': ['wcag2a', 'wcag332'],
  'frame-title': ['wcag2a', 'wcag241', 'wcag412'],
  'html-has-lang': ['wcag2a', 'wcag311'],
  'html-lang-valid': ['wcag2a', 'wcag311'],
  'html-xml-lang-mismatch': ['wcag2a', 'wcag311'],
  'image-alt': ['wcag2a', 'wcag111'],
  'input-button-name': ['wcag2a', 'wcag412'],
  'input-image-alt': ['wcag2a', 'wcag111'],
  'label': ['wcag2a', 'wcag131', 'wcag412'],
  'link-name': ['wcag2a', 'wcag244', 'wcag412'],
  'list': ['wcag2a', 'wcag131'],
  'listitem': ['wcag2a', 'wcag131'],
  'meta-refresh': ['wcag2a', 'wcag221'],
  'meta-viewport': ['wcag2aa', 'wcag144'],
  'object-alt': ['wcag2a', 'wcag111'],
  'select-name': ['wcag2a', 'wcag412'],
  'table-fake-caption': ['wcag2a', 'wcag131'],
  'td-has-header': ['wcag2a', 'wcag131'],
  'td-headers-attr': ['wcag2a', 'wcag131'],
  'th-has-data-cells': ['wcag2a', 'wcag131'],
  'valid-lang': ['wcag2aa', 'wcag312'],
  'video-caption': ['wcag2a', 'wcag122'],
};

// Derive the WCAG conformance level (A / AA / AAA) from a set of WCAG tags.
function wcagLevel(tags: string[] | undefined): string | undefined {
  if (!tags) return undefined;
  if (tags.some((t) => t === 'wcag2aaa' || t === 'wcag21aaa' || t === 'wcag22aaa')) return 'AAA';
  if (tags.some((t) => t === 'wcag2aa' || t === 'wcag21aa' || t === 'wcag22aa')) return 'AA';
  if (tags.some((t) => t === 'wcag2a' || t === 'wcag21a' || t === 'wcag22a')) return 'A';
  return undefined;
}

// Extract the WCAG success criterion (e.g. "1.4.3") from a numeric tag like "wcag143".
// Format: wcag<principle><guideline><criterion> → "principle.guideline.criterion".
function wcagCriterion(tags: string[] | undefined): string | undefined {
  if (!tags) return undefined;
  for (const t of tags) {
    const m = /^wcag(\d)(\d)(\d+)$/.exec(t);
    if (m) return `${m[1]}.${m[2]}.${m[3]}`;
  }
  return undefined;
}

// Extract the WCAG version that introduced the criterion (e.g. "2.0") from a level
// tag like "wcag2aa" (2.0), "wcag21aa" (2.1), "wcag22aa" (2.2).
function wcagVersion(tags: string[] | undefined): string | undefined {
  if (!tags) return undefined;
  for (const t of tags) {
    const m = /^wcag(2\d?)a+$/.exec(t);
    if (m) return { '2': '2.0', '21': '2.1', '22': '2.2' }[m[1]];
  }
  return undefined;
}

// Static map: Lighthouse accessibility audit id → the user groups the issue affects.
// Not provided by Lighthouse — this is curated reference data. Groups:
// "blind" (screen-reader users), "low vision", "color blind", "deaf" (deaf/hard of
// hearing), "motor" (mobility/keyboard-only), "cognitive" (learning/attention).
const A11Y_AFFECTED: Record<string, string[]> = {
  'accesskeys': ['motor', 'blind'],
  'aria-allowed-attr': ['blind'],
  'aria-command-name': ['blind'],
  'aria-dialog-name': ['blind'],
  'aria-hidden-body': ['blind'],
  'aria-hidden-focus': ['blind'],
  'aria-input-field-name': ['blind'],
  'aria-meter-name': ['blind'],
  'aria-progressbar-name': ['blind'],
  'aria-required-attr': ['blind'],
  'aria-required-children': ['blind'],
  'aria-required-parent': ['blind'],
  'aria-roles': ['blind'],
  'aria-toggle-field-name': ['blind'],
  'aria-tooltip-name': ['blind'],
  'aria-valid-attr-value': ['blind'],
  'aria-valid-attr': ['blind'],
  'button-name': ['blind'],
  'bypass': ['blind', 'motor'],
  'color-contrast': ['low vision', 'color blind'],
  'definition-list': ['blind'],
  'dlitem': ['blind'],
  'document-title': ['blind', 'cognitive'],
  'duplicate-id-active': ['blind'],
  'duplicate-id-aria': ['blind'],
  'form-field-multiple-labels': ['blind', 'cognitive'],
  'frame-title': ['blind'],
  'heading-order': ['blind', 'cognitive'],
  'html-has-lang': ['blind'],
  'html-lang-valid': ['blind'],
  'html-xml-lang-mismatch': ['blind'],
  'image-alt': ['blind'],
  'input-button-name': ['blind'],
  'input-image-alt': ['blind'],
  'label': ['blind', 'motor', 'cognitive'],
  'link-name': ['blind'],
  'list': ['blind'],
  'listitem': ['blind'],
  'meta-refresh': ['cognitive', 'blind'],
  'meta-viewport': ['low vision'],
  'object-alt': ['blind'],
  'select-name': ['blind'],
  'skip-link': ['blind', 'motor'],
  'tabindex': ['motor', 'blind'],
  'table-fake-caption': ['blind'],
  'td-has-header': ['blind'],
  'td-headers-attr': ['blind'],
  'th-has-data-cells': ['blind'],
  'valid-lang': ['blind'],
  'video-caption': ['deaf'],
};

// Which discipline typically owns the fix. Most audits are code fixes → "Development"
// is the default; these audits map to "Design" (visual/styling) or "Content" (copy/media).
const RESPONSIBILITY_OVERRIDES: Record<string, string> = {
  // Design — visual / styling / spacing / colour
  'color-contrast': 'Design',
  'meta-viewport': 'Design',
  'target-size': 'Design',
  'link-in-text-block': 'Design',   // links distinguished only by colour → styling fix
  // Content — copy / media / alt text / headings / link text
  'image-alt': 'Content',
  'input-image-alt': 'Content',
  'object-alt': 'Content',
  'svg-img-alt': 'Content',
  'image-redundant-alt': 'Content',
  'video-caption': 'Content',
  'document-title': 'Content',
  'meta-description': 'Content',
  'heading-order': 'Content',
  'empty-heading': 'Content',
  'identical-links-same-purpose': 'Content',
  // Everything else (ARIA, keyboard, landmarks, focus, semantics, autocomplete,
  // labels, tables, etc.) defaults to 'Development'.
};

function responsibilityFor(id: string): string {
  return RESPONSIBILITY_OVERRIDES[id] ?? 'Development';
}

// Convert one raw Lighthouse "insight" audit into our InsightItem shape.
function toInsightItem(a: {
  id: string;
  title: string;
  description: string;
  displayValue?: string;
  score: number | null;
  guidanceLevel?: number;
  metricSavings?: Record<string, number | undefined>;
  details?: unknown;
}): InsightItem {
  const details = a.details as {
    type?: string;
    items?: Record<string, { value: boolean; label: string }>;
  } | undefined;

  // Build the checklist (label → passed/failed) from the audit's details.
  const checklist: Record<string, ChecklistItem> = {};
  if (details?.type === 'checklist' && details.items) {
    for (const [key, item] of Object.entries(details.items)) {
      checklist[key] = { label: String(item.label), passed: item.value };
    }
  }

  // Copy over only the defined metric-savings entries (drop undefined values).
  const metricSavings: Record<string, number> = {};
  if (a.metricSavings) {
    for (const [key, val] of Object.entries(a.metricSavings)) {
      if (val != null) metricSavings[key] = val;
    }
  }

  const learnMoreUrl = extractLearnMoreUrl(a.description);
  return {
    id: a.id,
    title: a.title,
    description: stripLearnMoreLink(a.description),
    learnMoreUrl,
    displayValue: a.displayValue ?? '',
    score: pct(a.score),
    guidanceLevel: a.guidanceLevel ?? 1,
    ...(Object.keys(metricSavings).length > 0 && { metricSavings }),
    checklist,
  };
}

// Convert one raw Lighthouse audit into our AuditItem shape (used for failing audits).
function toAuditItem(a: { id: string; title: string; description: string; displayValue?: string; score: number | null; details?: unknown }): AuditItem {
  const details = a.details as {
    type?: string;
    items?: Record<string, unknown>[] | Record<string, unknown>;
    overallSavingsBytes?: number;
    overallSavingsMs?: number;
    debugData?: { impact?: string; tags?: string[] };  // axe-core impact + WCAG tags
  } | undefined;
  const learnMoreUrl = extractLearnMoreUrl(a.description);
  const debugData = details?.debugData;
  // Prefer the runtime tags axe emitted on failure; fall back to the static map.
  const tags = debugData?.tags ?? A11Y_WCAG_TAGS[a.id];
  const level = wcagLevel(tags);
  const criterion = wcagCriterion(tags);
  const version = wcagVersion(tags);
  const affects = A11Y_AFFECTED[a.id];

  // Extract the flagged rows. Most audits put them in an `items` array; checklist
  // audits store them as an object, which we wrap into a single-element array.
  let items: Record<string, unknown>[] | undefined;
  if (Array.isArray(details?.items) && (details.items as Record<string, unknown>[]).length > 0) {
    items = details.items as Record<string, unknown>[];
  } else if (
    details?.type === 'checklist' &&
    details.items != null &&
    !Array.isArray(details.items) &&
    typeof details.items === 'object'
  ) {
    items = [{ type: 'checklist', items: details.items }];
  }

  return {
    id: a.id,
    title: a.title,
    description: stripLearnMoreLink(a.description),
    learnMoreUrl,
    displayValue: a.displayValue ?? '',
    score: pct(a.score),
    detailsType: details?.type ?? 'n/a',
    itemCount: items?.length,
    wastedBytes: details?.overallSavingsBytes,
    wastedMs: details?.overallSavingsMs,
    items,
    ...(debugData?.impact && { impact: debugData.impact }),
    ...(tags && { tags }),
    ...(level && { level }),
    ...(criterion && { wcagCriterion: criterion }),
    ...(version && { wcagVersion: version }),
    ...(affects && { affects }),
    responsibility: responsibilityFor(a.id),
  };
}

// Main entry point: turn a raw Lighthouse RunnerResult into our ParsedResult.
// `lhr` (Lighthouse Result) is the big object holding categories, audits, etc.
export function parseResults(result: RunnerResult, strategy: string, pageTitle = ''): ParsedResult {
  const { lhr } = result;

  // 1. Headline score per category (performance, accessibility, ...).
  const scores: Record<string, CategoryScore> = {};
  for (const [key, cat] of Object.entries(lhr.categories)) {
    scores[key] = {
      score: pct(cat.score),
      title: cat.title,
      description: cat.description ?? '',
    };
  }

  // 2. The six performance metrics we care about (Core Web Vitals + extras).
  const metrics: Record<string, MetricValue> = {};
  for (const id of METRIC_IDS) {
    const audit = lhr.audits[id];
    if (audit) {
      metrics[id] = {
        value: audit.numericValue ?? null,
        displayValue: audit.displayValue ?? '',
        score: pct(audit.score),
        numericUnit: audit.numericUnit,
      };
    }
  }

  // 3. Insights — audits that carry guidance + a checklist breakdown.
  const insights: InsightItem[] = Object.values(lhr.audits)
    .filter((a) => a.guidanceLevel != null && (a.details as { type?: string } | undefined)?.type === 'checklist')
    .map(toInsightItem);

  // 4. "Scoreable" audits — the pass/fail checks that actually have a score.
  //    Excludes the metrics (handled above) and manual/notApplicable audits.
  const scoreable = Object.values(lhr.audits).filter(
    (a) =>
      !METRIC_IDS.has(a.id) &&
      (a.scoreDisplayMode === 'binary' || a.scoreDisplayMode === 'numeric' || a.scoreDisplayMode === 'metricSavings') &&
      a.score != null
  );

  // 5. Bucket scoreable audits by severity using the 0 / <0.9 / ≥0.9 thresholds.
  const critical: AuditItem[] = scoreable
    .filter((a) => (a.score as number) === 0)        // outright failures
    .map(toAuditItem);

  const nonCritical: AuditItem[] = scoreable
    .filter((a) => (a.score as number) > 0 && (a.score as number) < 0.9)  // needs work
    .map(toAuditItem)
    .sort((a, b) => (a.score ?? 0) - (b.score ?? 0)); // worst (lowest score) first

  const passed: PassedAudit[] = scoreable
    .filter((a) => (a.score as number) >= 0.9)        // passing
    .map((a) => {
      const learnMoreUrl = extractLearnMoreUrl(a.description ?? '');
      const tags = A11Y_WCAG_TAGS[a.id];              // LHR has no tags on passed audits
      const level = wcagLevel(tags);
      const criterion = wcagCriterion(tags);
      const version = wcagVersion(tags);
      return {
        id: a.id,
        title: a.title,
        description: stripLearnMoreLink(a.description ?? ''),
        ...(learnMoreUrl && { learnMoreUrl }),
        ...(tags && { tags }),
        ...(level && { level }),
        ...(criterion && { wcagCriterion: criterion }),
        ...(version && { wcagVersion: version }),
      };
    });

  // Audits that require human testing (e.g. logical-tab-order, focus-traps).
  const manualById = new Map(
    Object.values(lhr.audits)
      .filter((a) => a.scoreDisplayMode === 'manual')
      .map((a) => [a.id, { id: a.id, title: a.title, description: stripLearnMoreLink(a.description ?? '') } as ManualAudit])
  );
  // Audits that didn't apply to this page (axe found no matching nodes).
  const naById = new Map(
    Object.values(lhr.audits)
      .filter((a) => a.scoreDisplayMode === 'notApplicable')
      .map((a) => [a.id, { id: a.id, title: a.title } as NotApplicableAudit])
  );

  // 6. Build id → item lookup maps so we can place each audit into its category
  //    in one pass below (instead of re-scanning the arrays per category).
  const criticalById = new Map(critical.map((a) => [a.id, a]));
  const nonCriticalById = new Map(nonCritical.map((a) => [a.id, a]));
  const passedById = new Map(passed.map((a) => [a.id, a]));

  // 7. Group every audit under its category. Lighthouse tells us which audits
  //    belong to a category via cat.auditRefs; we look each one up by id.
  const byCategory: Record<string, CategoryGroup> = {};
  for (const [key, cat] of Object.entries(lhr.categories)) {
    const catCritical: AuditItem[] = [];
    const catNonCritical: AuditItem[] = [];
    const catPassed: PassedAudit[] = [];
    const catNeedsReview: ManualAudit[] = [];
    const catNotApplicable: NotApplicableAudit[] = [];

    // Route each audit ref into the right bucket (first match wins). Attach the
    // audit's weight (from the category's auditRef) — it's category-specific, so
    // we copy the shared item rather than mutate it.
    for (const ref of cat.auditRefs) {
      if (criticalById.has(ref.id)) catCritical.push({ ...criticalById.get(ref.id)!, weight: ref.weight });
      else if (nonCriticalById.has(ref.id)) catNonCritical.push({ ...nonCriticalById.get(ref.id)!, weight: ref.weight });
      else if (passedById.has(ref.id)) catPassed.push({ ...passedById.get(ref.id)!, weight: ref.weight });
      else if (manualById.has(ref.id)) catNeedsReview.push(manualById.get(ref.id)!);
      else if (naById.has(ref.id)) catNotApplicable.push(naById.get(ref.id)!);
    }

    byCategory[key] = {
      score: pct(cat.score),
      title: cat.title,
      critical: catCritical,
      nonCritical: catNonCritical.sort((a, b) => (a.score ?? 0) - (b.score ?? 0)),
      passed: catPassed,
      needsReview: catNeedsReview,
      notApplicable: catNotApplicable,
    };
  }

  // 8. Pull out screenshots: the final rendered shot, the full-page capture,
  //    and the loading filmstrip (a series of frames over time).
  const finalScreenshot = lhr.audits['final-screenshot'];
  const filmstripAudit = lhr.audits['screenshot-thumbnails'];
  const fullPage = lhr.fullPageScreenshot;

  const screenshots: Screenshots = {
    storage: 'inline',   // base64 here; the worker rewrites to 's3' after uploading
    final: (finalScreenshot?.details as { data?: string } | undefined)?.data ?? null,
    fullPage: fullPage?.screenshot?.data ?? null,
    filmstrip: ((filmstripAudit?.details as { items?: { timing: number; data: string }[] } | undefined)?.items ?? [])
      .map((frame) => ({ timing: frame.timing, data: frame.data })),
  };

  // 9. Assemble the final result the worker POSTs to the backend.
  return {
    url: lhr.finalDisplayedUrl,   // the URL actually audited (after redirects)
    pageTitle,
    fetchTime: lhr.fetchTime,
    strategy,
    scores,
    metrics,
    insights,
    summary: {
      total: critical.length + nonCritical.length + passed.length,
      passed: passed.length,
      critical: critical.length,
      nonCritical: nonCritical.length,
    },
    byCategory,
    screenshots,
  };
}