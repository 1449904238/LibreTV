import { NextResponse } from "next/server";
import { guardRequest } from "@/lib/api-guard";
import { cmsRequestHeaders, filterAdultResults, normalizeTitle, parseSearchList } from "@/lib/cms-parser";
import { fetchUpstream, getCache, setCache } from "@/lib/fetch-utils";
import { checkUpstreamAllowed } from "@/lib/ssrf";
import type { SearchResultItem, SourceConfig } from "@/lib/types";

export const runtime = "nodejs";

interface LatestBody {
  sources: SourceConfig[];
  filterAdult?: boolean;
}

/** 单次最多取 30 个源，防止一次请求打爆上游 */
const MAX_SOURCES = 30;
/** 单源请求超时（ms）：最新页只有 1 页，比搜索更激进 */
const PER_SOURCE_TIMEOUT_MS = 8000;
/** 返回条数上限 */
const LATEST_LIMIT = 60;
/** 服务端缓存：同一批源 20 分钟内复用（首页每次打开都会请求） */
const LATEST_TTL_MS = 20 * 60 * 1000;

function timeScore(v: unknown): number {
  if (typeof v !== "string" || !v) return 0;
  const t = Date.parse(v.replace(" ", "T"));
  return Number.isFinite(t) ? t : 0;
}

/**
 * 单源拉最新一页：ac=videolist 默认按更新时间倒序，第一页即最新。
 * 失败（网络/格式/SSRF）返回 null，由调用方静默跳过——坏源不影响整体。
 */
async function fetchLatest(
  source: SourceConfig
): Promise<{ items: SearchResultItem[]; scores: Map<string, number> } | null> {
  if (!/^https?:\/\//.test(source.url || "")) return null;
  const verdict = await checkUpstreamAllowed(source.url);
  if (!verdict.ok) return null;
  const base = source.url.replace(/\/+$/, "");
  const res = await fetchUpstream(`${base}?ac=videolist&pg=1`, {
    timeoutMs: PER_SOURCE_TIMEOUT_MS,
    headers: cmsRequestHeaders(),
  });
  if (!res.ok) return null;
  const data: unknown = await res.json();
  const items = parseSearchList(data, source);
  const scores = new Map<string, number>();
  const list = (data as { list?: unknown }).list;
  if (Array.isArray(list)) {
    for (const raw of list) {
      const v = raw as Record<string, unknown>;
      scores.set(String(v.vod_id ?? ""), timeScore(v.vod_time));
    }
  }
  return { items, scores };
}

export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  let body: LatestBody;
  try {
    body = (await req.json()) as LatestBody;
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }
  const sources = Array.isArray(body.sources) ? body.sources.slice(0, MAX_SOURCES) : [];
  if (sources.length === 0) {
    return NextResponse.json({ items: [], okSources: 0, totalSources: 0 });
  }

  const cacheKey =
    `latest:${sources.map((s) => s.url.replace(/\/+$/, "")).sort().join("|")}` +
    `:${body.filterAdult ? 1 : 0}`;
  const cached = getCache<{ items: SearchResultItem[]; okSources: number; totalSources: number }>(cacheKey);
  if (cached) return NextResponse.json(cached);

  const settled = await Promise.allSettled(sources.map((s) => fetchLatest(s)));
  // 跨源同名去重：同一标题只留更新时间最新的那一条
  const best = new Map<string, { item: SearchResultItem; score: number }>();
  let okSources = 0;
  settled.forEach((r) => {
    if (r.status !== "fulfilled" || !r.value) return;
    okSources++;
    for (const item of r.value.items) {
      if (!item.vodId || !item.name) continue;
      const key = normalizeTitle(item.name);
      const score = r.value.scores.get(item.vodId) ?? 0;
      const prev = best.get(key);
      if (!prev || score > prev.score) best.set(key, { item, score });
    }
  });

  let items = [...best.values()]
    .sort((a, b) => b.score - a.score)
    .map((e) => e.item)
    .slice(0, LATEST_LIMIT);
  if (body.filterAdult) items = filterAdultResults(items, true);

  const payload = { items, okSources, totalSources: sources.length };
  setCache(cacheKey, payload, LATEST_TTL_MS);
  return NextResponse.json(payload);
}
