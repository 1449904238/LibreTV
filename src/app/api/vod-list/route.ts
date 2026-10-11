import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import {
  cmsRequestHeaders,
  filterAdultResults,
  normalizeTitle,
  parseSearchList,
} from '@/lib/cms-parser';
import { fetchUpstream, getCache, setCache } from '@/lib/fetch-utils';
import { checkUpstreamAllowed } from '@/lib/ssrf';
import type {
  SearchResultItem,
  SourceConfig,
  VodListAggregateResponse,
  VodListResponse,
} from '@/lib/types';

export const runtime = 'nodejs';

type VodListBody =
  | { mode: 'single'; source: SourceConfig; typeId: number; page?: number; filterAdult?: boolean }
  | {
      mode: 'aggregate';
      targets: { source: SourceConfig; typeIds: number[] }[];
      page?: number;
      filterAdult?: boolean;
    };

/** 单源请求超时（ms）：分类翻页只有 1 页意图，比搜索更激进 */
const PER_REQUEST_TIMEOUT_MS = 8000;
/** 列表缓存：同一源 + 分类 + 页 10 分钟内复用（翻页返回不重复打上游） */
const LIST_TTL_MS = 10 * 60 * 1000;
/** 聚合模式单次最多上游请求数：源数量 × 每源 typeId 数量裁剪到该上限 */
const MAX_UPSTREAM_REQUESTS = 20;

function clampPage(p: unknown): number {
  const n = typeof p === 'number' ? p : parseInt(String(p ?? '1'), 10);
  if (!Number.isFinite(n)) return 1;
  return Math.min(200, Math.max(1, n));
}

function singleCacheKey(url: string, typeId: number, page: number, filterAdult: boolean): string {
  return `vodlist:${url.replace(/\/+$/, '')}:t${typeId}:p${page}:${filterAdult ? 1 : 0}`;
}

async function fetchVodPage(
  source: SourceConfig,
  typeId: number,
  page: number
): Promise<{ items: SearchResultItem[]; pagecount: number; total: number } | null> {
  if (!/^https?:\/\//.test(source.url || '')) return null;
  const verdict = await checkUpstreamAllowed(source.url);
  if (!verdict.ok) return null;
  const base = source.url.replace(/\/+$/, '');
  const url = `${base}?ac=videolist&t=${encodeURIComponent(String(typeId))}&pg=${page}`;
  try {
    const res = await fetchUpstream(url, {
      timeoutMs: PER_REQUEST_TIMEOUT_MS,
      headers: cmsRequestHeaders(),
    });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    const items = parseSearchList(data, source);
    const d = data as { pagecount?: unknown; total?: unknown; recordcount?: unknown };
    const pagecount = parseInt(String(d.pagecount ?? '1'), 10);
    const total = parseInt(String(d.total ?? d.recordcount ?? items.length), 10);
    return {
      items,
      pagecount: Number.isFinite(pagecount) && pagecount > 0 ? pagecount : 1,
      total: Number.isFinite(total) && total >= 0 ? total : items.length,
    };
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  let body: VodListBody;
  try {
    body = (await req.json()) as VodListBody;
  } catch {
    return NextResponse.json({ error: '请求格式错误' }, { status: 400 });
  }

  if (body.mode === 'single') {
    const page = clampPage(body.page);
    const filterAdult = body.filterAdult === true;
    if (!body.source || !Number.isInteger(body.typeId) || (body.typeId as number) < 0) {
      return NextResponse.json({ error: '缺少 source 或 typeId' }, { status: 400 });
    }
    const key = singleCacheKey(body.source.url, body.typeId, page, filterAdult);
    const cached = getCache<VodListResponse>(key);
    if (cached) return NextResponse.json(cached);
    const fetched = await fetchVodPage(body.source, body.typeId, page);
    if (!fetched) return NextResponse.json({ error: '该源分类加载失败' }, { status: 502 });
    let list = fetched.items;
    if (filterAdult) list = filterAdultResults(list, true);
    const payload: VodListResponse = { list, page, pagecount: fetched.pagecount, total: fetched.total };
    setCache(key, payload, LIST_TTL_MS);
    return NextResponse.json(payload);
  }

  if (body.mode === 'aggregate') {
    const page = clampPage(body.page);
    const filterAdult = body.filterAdult === true;
    const targets = (Array.isArray(body.targets) ? body.targets : []).slice(0, 30);
    // 展平为 (source, typeId) 请求并裁剪上限：优先保证更多源各至少查 1 个分类
    const flat: { source: SourceConfig; typeId: number }[] = [];
    const safeIds = (t: { typeIds: unknown }): number[] =>
      (Array.isArray(t.typeIds) ? t.typeIds : []).filter((id): id is number => Number.isInteger(id) && id >= 0).slice(0, 10);
    const perSourceFirst = targets.flatMap((t) =>
      safeIds(t).slice(0, 1).map((typeId) => ({ source: t.source, typeId }))
    );
    const rest = targets.flatMap((t) =>
      safeIds(t).slice(1).map((typeId) => ({ source: t.source, typeId }))
    );
    for (const r of [...perSourceFirst, ...rest]) {
      if (flat.length >= MAX_UPSTREAM_REQUESTS) break;
      if (typeof r.typeId !== 'number' || !r.source?.url) continue;
      flat.push(r);
    }
    if (flat.length === 0) {
      const empty: VodListAggregateResponse = { list: [], page, okSources: 0, totalSources: 0 };
      return NextResponse.json(empty);
    }
    const key =
      `vodlist-agg:p${page}:${filterAdult ? 1 : 0}:` +
      flat.map((f) => `${f.source.url.replace(/\/+$/, '')}:t${f.typeId}`).sort().join('|');
    const cached = getCache<VodListAggregateResponse>(key);
    if (cached) return NextResponse.json(cached);

    const settled = await Promise.allSettled(flat.map((f) => fetchVodPage(f.source, f.typeId, page)));
    const okSources = new Set<string>();
    const best = new Map<string, SearchResultItem>();
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      if (r.status !== 'fulfilled' || !r.value) continue;
      okSources.add(flat[i].source.key);
      for (const item of r.value.items) {
        if (!item.name) continue;
        const k = normalizeTitle(item.name);
        if (!best.has(k)) best.set(k, item);
      }
    }
    let list = [...best.values()];
    if (filterAdult) list = filterAdultResults(list, true);
    // 聚合页内按名称稳定排序，保证翻页与缓存一致
    list.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'));
    const payload: VodListAggregateResponse = {
      list,
      page,
      okSources: okSources.size,
      totalSources: new Set(flat.map((f) => f.source.key)).size,
    };
    setCache(key, payload, LIST_TTL_MS);
    return NextResponse.json(payload);
  }

  return NextResponse.json({ error: '未知 mode' }, { status: 400 });
}
