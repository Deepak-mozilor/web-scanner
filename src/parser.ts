import type { RunnerResult } from 'lighthouse';

export interface MetricValue {
  value: number | null;
  displayValue: string;
  score: number | null;
  numericUnit?: string;
}

export interface CategoryScore {
  score: number | null;
  title: string;
  description: string;
}

export interface AuditItem {
  id: string;
  title: string;
  description: string;
  learnMoreUrl?: string;
  displayValue: string;
  score: number | null;
  detailsType: string;
  itemCount?: number;
  wastedBytes?: number;
  wastedMs?: number;
  items?: Record<string, unknown>[];
}

export interface ChecklistItem {
  label: string;
  passed: boolean;
}

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

export interface PassedAudit {
  id: string;
  title: string;
}

export interface Summary {
  total: number;
  passed: number;
  critical: number;
  nonCritical: number;
}

export interface CategoryGroup {
  score: number | null;
  title: string;
  critical: AuditItem[];
  nonCritical: AuditItem[];
  passed: PassedAudit[];
}

export interface FilmstripFrame {
  timing: number;
  data: string;
}

export interface Screenshots {
  final: string | null;
  fullPage: string | null;
  filmstrip: FilmstripFrame[];
}

export interface ParsedResult {
  url: string;
  fetchTime: string;
  strategy: string;
  scores: Record<string, CategoryScore>;
  metrics: Record<string, MetricValue>;
  insights: InsightItem[];
  summary: Summary;
  passed: PassedAudit[];
  byCategory: Record<string, CategoryGroup>;
  screenshots: Screenshots;
}

const METRIC_IDS = new Set([
  'first-contentful-paint',
  'largest-contentful-paint',
  'total-blocking-time',
  'cumulative-layout-shift',
  'interactive',
  'speed-index',
]);

const LEARN_MORE_RE = /\[.*?\]\((https?:\/\/[^)]+)\)\.?\s*$/;

function extractLearnMoreUrl(description: string): string | undefined {
  return LEARN_MORE_RE.exec(description)?.[1];
}

function stripLearnMoreLink(description: string): string {
  return description.replace(LEARN_MORE_RE, '').trim();
}

function pct(score: number | null | undefined): number | null {
  return score != null ? Math.round(score * 100) : null;
}

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

  const checklist: Record<string, ChecklistItem> = {};
  if (details?.type === 'checklist' && details.items) {
    for (const [key, item] of Object.entries(details.items)) {
      checklist[key] = { label: String(item.label), passed: item.value };
    }
  }

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

function toAuditItem(a: { id: string; title: string; description: string; displayValue?: string; score: number | null; details?: unknown }): AuditItem {
  const details = a.details as {
    type?: string;
    items?: Record<string, unknown>[] | Record<string, unknown>;
    overallSavingsBytes?: number;
    overallSavingsMs?: number;
  } | undefined;
  const learnMoreUrl = extractLearnMoreUrl(a.description);

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
  };
}

export function parseResults(result: RunnerResult, strategy: string): ParsedResult {
  const { lhr } = result;

  const scores: Record<string, CategoryScore> = {};
  for (const [key, cat] of Object.entries(lhr.categories)) {
    scores[key] = {
      score: pct(cat.score),
      title: cat.title,
      description: cat.description ?? '',
    };
  }

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

  const insights: InsightItem[] = Object.values(lhr.audits)
    .filter((a) => a.guidanceLevel != null && (a.details as { type?: string } | undefined)?.type === 'checklist')
    .map(toInsightItem);

  const scoreable = Object.values(lhr.audits).filter(
    (a) =>
      !METRIC_IDS.has(a.id) &&
      (a.scoreDisplayMode === 'binary' || a.scoreDisplayMode === 'numeric' || a.scoreDisplayMode === 'metricSavings') &&
      a.score != null
  );

  const critical: AuditItem[] = scoreable
    .filter((a) => (a.score as number) === 0)
    .map(toAuditItem);

  const nonCritical: AuditItem[] = scoreable
    .filter((a) => (a.score as number) > 0 && (a.score as number) < 0.9)
    .map(toAuditItem)
    .sort((a, b) => (a.score ?? 0) - (b.score ?? 0));

  const passed: PassedAudit[] = scoreable
    .filter((a) => (a.score as number) >= 0.9)
    .map((a) => ({ id: a.id, title: a.title }));

  const criticalById = new Map(critical.map((a) => [a.id, a]));
  const nonCriticalById = new Map(nonCritical.map((a) => [a.id, a]));
  const passedById = new Map(passed.map((a) => [a.id, a]));

  const byCategory: Record<string, CategoryGroup> = {};
  for (const [key, cat] of Object.entries(lhr.categories)) {
    const catCritical: AuditItem[] = [];
    const catNonCritical: AuditItem[] = [];
    const catPassed: PassedAudit[] = [];

    for (const ref of cat.auditRefs) {
      if (criticalById.has(ref.id)) catCritical.push(criticalById.get(ref.id)!);
      else if (nonCriticalById.has(ref.id)) catNonCritical.push(nonCriticalById.get(ref.id)!);
      else if (passedById.has(ref.id)) catPassed.push(passedById.get(ref.id)!);
    }

    byCategory[key] = {
      score: pct(cat.score),
      title: cat.title,
      critical: catCritical,
      nonCritical: catNonCritical.sort((a, b) => (a.score ?? 0) - (b.score ?? 0)),
      passed: catPassed,
    };
  }

  const finalScreenshot = lhr.audits['final-screenshot'];
  const filmstripAudit = lhr.audits['screenshot-thumbnails'];
  const fullPage = lhr.fullPageScreenshot;

  const screenshots: Screenshots = {
    final: (finalScreenshot?.details as { data?: string } | undefined)?.data ?? null,
    fullPage: fullPage?.screenshot?.data ?? null,
    filmstrip: ((filmstripAudit?.details as { items?: { timing: number; data: string }[] } | undefined)?.items ?? [])
      .map((frame) => ({ timing: frame.timing, data: frame.data })),
  };

  return {
    url: lhr.finalDisplayedUrl,
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
    passed,
    byCategory,
    screenshots,
  };
}