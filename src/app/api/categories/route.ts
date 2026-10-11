import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { cmsRequestHeaders, parseVodCategories } from '@/lib/cms-parser';
import { mergeSourceCategories } from '@/lib/browse-categories';
import { fetchUpstream, getCache, setCache } from '@/lib/fetch-utils';
import { checkUpstreamAllowed } from '@/lib/ssrf';
import type { CategoriesResponse, SourceCategoriesResult, SourceConfig } from '@/lib/types';

export const runtime = 'nodejs';

interface CategoriesBody {
  sources: SourceConfig[];
}

/** 单次最多取 30 个源（与 /api/latest 对齐，防止一次请求打爆上游） */
const MAX_SOURCES = 30;
/** 单源分类拉取超时：分类走每日缓存，可比列表更宽容 */
const PER_SOURCE_TIMEOUT_MS = 8000;
/** 服务端缓存：同一批源 24 小时内复用（首页分类每日缓存一次） */
const CATEGORIES_TTL_MS = 24 * 60 * 60 * 1000;
/** 空分类探测：单个 typeId 的影片总数查询超时 */
const COUNT_TIMEOUT_MS = 5000;
/** 空分类探测整体死线：超时未返回的按未知保留（fail-open），避免首屏被慢源拖住 */
const COUNT_DEADLINE_MS = 20000;
/** 空分类探测并发数 */
const COUNT_CONCURRENCY = 12;

function cacheKey(urls: string[]): string {
  return `categories:v2:${urls.map((u) => u.replace(/\/+$/, '')).sort().join('|')}`;
}

/** 查某分类影片总数：读 ac=videolist 第一页的 total；失败/超时返回 null（未知） */
async function fetchVodTotal(base: string, typeId: number, signal: AbortSignal): Promise<number | null> {
  try {
    const res = await fetchUpstream(
      `${base}?ac=videolist&t=${encodeURIComponent(String(typeId))}&pg=1`,
      { timeoutMs: COUNT_TIMEOUT_MS, headers: cmsRequestHeaders(), signal }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { total?: unknown; recordcount?: unknown };
    const total = parseInt(String(data.total ?? data.recordcount ?? ''), 10);
    return Number.isFinite(total) && total >= 0 ? total : null;
  } catch {
    return null;
  }
}

/**
 * 空分类过滤：确认影片总数为 0 的分类剔除（sources 与 merged 同步变干净）。
 * 未知（超时/失败/死线未及）一律保留，避免误杀慢源。
 */
async function filterEmptyCategories(
  sources: SourceConfig[],
  results: SourceCategoriesResult[]
): Promise<{ filtered: SourceCategoriesResult[]; hiddenEmpty: number }> {
  const baseOf = new Map(sources.map((s) => [s.key, s.url.replace(/\/+$/, '')]));
  const tasks = results
    .filter((r) => r.ok)
    .flatMap((r) =>
      r.categories.map((c) => ({ sourceKey: r.sourceKey, base: baseOf.get(r.sourceKey) ?? '', typeId: c.id }))
    )
    .filter((t) => t.base && /^https?:\/\//.test(t.base));
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), COUNT_DEADLINE_MS);
  const totals = new Map<string, number | null>();
  try {
    for (let i = 0; i < tasks.length; i += COUNT_CONCURRENCY) {
      if (controller.signal.aborted) break;
      const chunk = tasks.slice(i, i + COUNT_CONCURRENCY);
      const settled = await Promise.allSettled(
        chunk.map(async (t) => ({ key: `${t.sourceKey}:${t.typeId}`, total: await fetchVodTotal(t.base, t.typeId, controller.signal) }))
      );
      for (const s of settled) {
        if (s.status === 'fulfilled') totals.set(s.value.key, s.value.total);
      }
    }
  } finally {
    clearTimeout(deadline);
  }
  let hiddenEmpty = 0;
  const filtered = results.map((r) => {
    if (!r.ok) return r;
    const categories = r.categories.filter((c) => {
      if (totals.get(`${r.sourceKey}:${c.id}`) === 0) {
        hiddenEmpty++;
        return false;
      }
      return true;
    });
    return { ...r, categories };
  });
  return { filtered, hiddenEmpty };
}

async function fetchSourceCategories(source: SourceConfig): Promise<SourceCategoriesResult> {
  const fail = (error: string): SourceCategoriesResult => ({
    sourceKey: source.key,
    sourceName: source.name,
    ok: false,
    categories: [],
    error,
  });
  if (!/^https?:\/\//.test(source.url || '')) return fail('无效的源地址');
  const verdict = await checkUpstreamAllowed(source.url);
  if (!verdict.ok) return fail(verdict.reason);
  const base = source.url.replace(/\/+$/, '');
  // 优先 ac=list；部分源不支持时退化为 ac=videolist 第一页（响应里同样带 class）
  const candidates = [`${base}?ac=list`, `${base}?ac=videolist&pg=1`];
  for (const url of candidates) {
    try {
      const res = await fetchUpstream(url, {
        timeoutMs: PER_SOURCE_TIMEOUT_MS,
        headers: cmsRequestHeaders(),
      });
      if (!res.ok) continue;
      const data: unknown = await res.json();
      const categories = parseVodCategories(data).map((c) => ({ id: c.id, name: c.name }));
      if (categories.length > 0) {
        return { sourceKey: source.key, sourceName: source.name, ok: true, categories };
      }
    } catch {
      // 换下一个候选地址
    }
  }
  return fail('该源未返回可用分类');
}

export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  let body: CategoriesBody;
  try {
    body = (await req.json()) as CategoriesBody;
  } catch {
    return NextResponse.json({ error: '请求格式错误' }, { status: 400 });
  }
  const sources = Array.isArray(body.sources) ? body.sources.slice(0, MAX_SOURCES) : [];
  if (sources.length === 0) {
    const empty: CategoriesResponse = { sources: [], merged: [], okSources: 0, totalSources: 0, hiddenEmpty: 0 };
    return NextResponse.json(empty);
  }

  const key = cacheKey(sources.map((s) => s.url));
  const cached = getCache<CategoriesResponse>(key);
  if (cached) return NextResponse.json(cached);

  const settled = await Promise.allSettled(sources.map((s) => fetchSourceCategories(s)));
  const results: SourceCategoriesResult[] = settled.map((r, i) =>
    r.status === 'fulfilled' ? r.value : {
      sourceKey: sources[i].key,
      sourceName: sources[i].name,
      ok: false,
      categories: [],
      error: '请求失败',
    }
  );
  // 空分类过滤：逐个 typeId 查影片总数，确认 total===0 的剔除；超时/失败查不到的保留
  const { filtered, hiddenEmpty } = await filterEmptyCategories(sources, results);
  const merged = mergeSourceCategories(
    filtered.filter((r) => r.ok).map((r) => ({ sourceKey: r.sourceKey, categories: r.categories }))
  );
  const payload: CategoriesResponse = {
    sources: filtered,
    merged,
    okSources: filtered.filter((r) => r.ok).length,
    totalSources: sources.length,
    hiddenEmpty,
  };
  setCache(key, payload, CATEGORIES_TTL_MS);
  return NextResponse.json(payload);
}
