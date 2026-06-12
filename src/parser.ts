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

export interface NetworkRequest {
  url: string;
  protocol: string;
  resourceType: string;
  mimeType: string;
  statusCode: number;
  transferSize: number;
  resourceSize: number;
  startTime: number;
  endTime: number;
  entity?: string;
}

export interface ResourceSummaryItem {
  resourceType: string;
  label: string;
  requestCount: number;
  transferSize: number;
}

export interface ThirdPartyEntity {
  name: string;
  homepage?: string;
  category?: string;
  isFirstParty: boolean;
  origins: string[];
}

export interface ParsedResult {
  url: string;
  fetchTime: string;
  lighthouseVersion: string;
  strategy: string;
  runWarnings: string[];
  scores: Record<string, CategoryScore>;
  metrics: Record<string, MetricValue>;
  summary: Summary;
  passed: PassedAudit[];
  byCategory: Record<string, CategoryGroup>;
  networkRequests: NetworkRequest[];
  resourceSummary: ResourceSummaryItem[];
  entities: ThirdPartyEntity[];
  screenshots: Screenshots;
}

function resolveStr(val: unknown): string {
  if (typeof val === 'string') return val;
  if (val && typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    if (typeof obj.value === 'string') return obj.value;
  }
  return '';
}

function resolveNum(val: unknown): number {
  if (typeof val === 'number') return val;
  if (typeof val === 'string') return parseFloat(val) || 0;
  if (val && typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    if (typeof obj.value === 'number') return obj.value;
  }
  return 0;
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

function toAuditItem(a: { id: string; title: string; description: string; displayValue?: string; score: number | null; details?: unknown }): AuditItem {
  const details = a.details as {
    type?: string;
    items?: Record<string, unknown>[];
    overallSavingsBytes?: number;
    overallSavingsMs?: number;
  } | undefined;
  const learnMoreUrl = extractLearnMoreUrl(a.description);
  return {
    id: a.id,
    title: a.title,
    description: stripLearnMoreLink(a.description),
    learnMoreUrl,
    displayValue: a.displayValue ?? '',
    score: pct(a.score),
    detailsType: details?.type ?? 'n/a',
    itemCount: Array.isArray(details?.items) ? details.items.length : undefined,
    wastedBytes: details?.overallSavingsBytes,
    wastedMs: details?.overallSavingsMs,
    items: Array.isArray(details?.items) && details.items.length > 0 ? details.items : undefined,
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

  const networkAuditItems = ((lhr.audits['network-requests']?.details as { items?: Record<string, unknown>[] } | undefined)?.items ?? []);
  const networkRequests: NetworkRequest[] = networkAuditItems.map(item => ({
    url: resolveStr(item.url),
    protocol: resolveStr(item.protocol),
    resourceType: resolveStr(item.resourceType),
    mimeType: resolveStr(item.mimeType),
    statusCode: resolveNum(item.statusCode),
    transferSize: resolveNum(item.transferSize),
    resourceSize: resolveNum(item.resourceSize),
    startTime: resolveNum(item.networkRequestTime),
    endTime: resolveNum(item.networkEndTime),
    ...(item.entity != null ? { entity: resolveStr(item.entity) } : {}),
  }));

  const resourceAuditItems = ((lhr.audits['resource-summary']?.details as { items?: Record<string, unknown>[] } | undefined)?.items ?? []);
  const resourceSummary: ResourceSummaryItem[] = resourceAuditItems.map(item => ({
    resourceType: resolveStr(item.resourceType ?? item.label),
    label: resolveStr(item.label),
    requestCount: resolveNum(item.requestCount),
    transferSize: resolveNum(item.transferSize),
  }));

  const entities: ThirdPartyEntity[] = (lhr.entities ?? []).map(e => ({
    name: e.name,
    ...(e.homepage ? { homepage: e.homepage } : {}),
    ...(e.category ? { category: e.category } : {}),
    isFirstParty: e.isFirstParty ?? false,
    origins: e.origins,
  }));

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
    lighthouseVersion: lhr.lighthouseVersion,
    strategy,
    runWarnings: lhr.runWarnings,
    scores,
    metrics,
    summary: {
      total: critical.length + nonCritical.length + passed.length,
      passed: passed.length,
      critical: critical.length,
      nonCritical: nonCritical.length,
    },
    passed,
    byCategory,
    networkRequests,
    resourceSummary,
    entities,
    screenshots,
  };
}
