'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
import { resolveSource, useAppStore } from '@/lib/store';
import { cn, validateSourceUrl } from '@/lib/utils';
import type { SearchResultItem, SourceConfig } from '@/lib/types';
import { TAXONOMY, filterDomesticItems, matchSourceCategory } from '@/lib/browse-taxonomy';
import { RecommendSection } from './douban-section';
import { SmartImage } from './smart-image';

/**
 * 首页浏览区：三种模式可切换（选择即持久化）。
 * - single：默认源模式。首页可切换默认源，分类即该源 ac=list 的真实分类。
 * - aggregate：聚合模式。全源分类归一合并，默认展示前10个、其余折叠。
 * - recommend：现有推荐榜单（豆瓣 / Bangumi / 影视热榜），保持不变。
 * 分类走服务端 24h 缓存（/api/categories），客户端 staleTime 同步为 24h，
 * 满足"每日缓存一次"；列表走 10 分钟缓存，翻页即时可用。
 */

/**
 * 首页分类浏览（TV 端展示方案）：
 * 一级：最近最火 / 电影 / 剧集 / 综艺 / 动漫 / 短剧 / 纪录片 / 海外专区 / 推荐榜单；
 * 电影 / 剧集 / 海外专区带二级（动作/武打、国产剧、欧美影视……）。
 * 数据走聚合：类目按关键词映射各源 ac/list 的 type_id（服务端 24h 缓存），
 * 列表走 /api/vod-list（10 分钟缓存）；最近最火走 /api/latest 并按更新时间排序。
 * 国内节点自动过滤海外条目；海外内容统一归入海外专区。
 * 首页启动默认落在最近最火并自动加载。
 */
/** 已勾选且地址合法的源（分类与列表只查这些源） */
function useAvailableSources(): SourceConfig[] {
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const selectedKeys = useAppStore((s) => s.selectedKeys);
  return useMemo(() => {
    const seen = new Set<string>();
    return selectedKeys
      .map((key) => resolveSource({ customAPIs, envSources }, key))
      .filter((s): s is SourceConfig => {
        if (!s || !validateSourceUrl(s.url) || seen.has(s.key)) return false;
        seen.add(s.key);
        return true;
      });
  }, [customAPIs, envSources, selectedKeys]);
}

function useCategoriesQuery(sources: SourceConfig[], enabled: boolean) {
  const hash = useMemo(() => sources.map((s) => s.key).sort().join(','), [sources]);
  const query = useQuery({
    queryKey: ['vod-categories', hash],
    queryFn: ({ signal }) => api.categories(sources, signal),
    enabled: enabled && sources.length > 0,
    staleTime: 24 * 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
  });
  return { query, hash };
}

const PRIMARY_TABS: { key: string; label: string }[] = [
  ...TAXONOMY.map((p) => ({ key: p.key, label: p.label })),
  { key: 'recommend', label: '推荐榜单' },
];

export function BrowseSection({
  onPick,
  onOpen,
}: {
  onPick: (title: string) => void;
  onOpen: (item: SearchResultItem) => void;
}) {
  const [primary, setPrimary] = useState('hot');
  const [secondary, setSecondary] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [accum, setAccum] = useState<SearchResultItem[]>([]);
  const sources = useAvailableSources();
  const yellowFilter = useAppStore((s) => s.yellowFilter);
  const queryClient = useQueryClient();
  const { query, hash: sourcesHash } = useCategoriesQuery(sources, primary !== 'recommend');

  const activePrimary = TAXONOMY.find((p) => p.key === primary) ?? null;
  const activeSubKey =
    activePrimary && activePrimary.subs.length > 0 ? (secondary ?? activePrimary.subs[0].key) : null;

  // 各源类目 → 两级分类映射（同名跨源 type_id 各异，在此按关键词归一）
  const mapping = useMemo(() => {
    const m = new Map<string, { typeId: number; primary: string; secondary: string | null }[]>();
    for (const s of query.data?.sources ?? []) {
      if (!s.ok) continue;
      const arr: { typeId: number; primary: string; secondary: string | null }[] = [];
      for (const c of s.categories) {
        for (const h of matchSourceCategory(c.name)) {
          arr.push({ typeId: c.id, primary: h.primary, secondary: h.secondary });
        }
      }
      m.set(s.sourceKey, arr);
    }
    return m;
  }, [query.data]);

  const byKey = useMemo(() => new Map(sources.map((s) => [s.key, s])), [sources]);

  // 当前节点在全源的 typeId 目标："全部X"取该一级下全部命中并集
  const targets = useMemo(() => {
    if (!activePrimary || primary === 'hot' || primary === 'recommend') return [];
    const grouped = new Map<string, number[]>();
    for (const [sourceKey, refs] of mapping) {
      const src = byKey.get(sourceKey);
      if (!src) continue;
      const ids = [
        ...new Set(
          refs
            .filter(
              (r) =>
                r.primary === primary &&
                (activeSubKey === null || activeSubKey === 'all' || r.secondary === activeSubKey)
            )
            .map((r) => r.typeId)
        ),
      ];
      if (ids.length > 0) grouped.set(sourceKey, ids);
    }
    return [...grouped.entries()].map(([key, typeIds]) => ({
      source: byKey.get(key) as SourceConfig,
      typeIds,
    }));
  }, [mapping, primary, activeSubKey, activePrimary, byKey]);
  const targetsKey = targets.map((t) => t.source.key).sort().join(',');

  // 最近最火：全源最新入库（服务端已按更新时间倒序），只收国内内容
  const hotQuery = useQuery({
    queryKey: ['taxonomy-hot', sourcesHash, yellowFilter],
    queryFn: ({ signal }) => api.latest(sources, yellowFilter, signal),
    enabled: primary === 'hot' && sources.length > 0,
    staleTime: 10 * 60 * 1000,
  });
  const hotItems = useMemo(() => filterDomesticItems(hotQuery.data?.items ?? []), [hotQuery.data]);

  // 分类节点：多源多 typeId 并行合并，本地追加翻页
  const listQuery = useQuery({
    queryKey: ['vod-list-tax', primary, activeSubKey, page, yellowFilter, targetsKey],
    queryFn: ({ signal }) => api.vodListAggregate(targets, page, yellowFilter, signal),
    enabled: !!activePrimary && primary !== 'hot' && primary !== 'recommend' && targets.length > 0,
    staleTime: 10 * 60 * 1000,
  });
  useEffect(() => {
    if (!listQuery.data) return;
    const rows = activePrimary?.overseas ? listQuery.data.list : filterDomesticItems(listQuery.data.list);
    setAccum((prev) => (page === 1 ? rows : [...prev, ...rows]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listQuery.data]);

  const switchPrimary = (key: string) => {
    if (key === primary) return;
    setPrimary(key);
    setSecondary(null);
    setPage(1);
    setAccum([]);
  };
  const switchSub = (key: string) => {
    if (key === activeSubKey) return;
    setSecondary(key);
    setPage(1);
    setAccum([]);
  };
  // 源集合 / 成人过滤变化时回到默认选中并清空列表
  useEffect(() => {
    setSecondary(null);
    setPage(1);
    setAccum([]);
  }, [primary, sourcesHash, yellowFilter]);

  if (sources.length === 0) {
    return <p className="text-center text-sm text-faint py-8">暂无可用点播源：请先登录并在设置中添加或勾选点播源</p>;
  }

  return (
    <section aria-label="分类浏览">
      <div className="flex gap-1.5 mb-3 overflow-x-auto pb-1 -mx-1 px-1" role="tablist" aria-label="分类">
        {PRIMARY_TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={primary === t.key}
            className={cn(
              'px-2.5 py-1 rounded-md text-[13px] transition-colors shrink-0',
              primary === t.key ? 'bg-accent text-on-accent' : 'bg-chip text-muted hover:text-content hover:bg-hover'
            )}
            onClick={() => switchPrimary(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activePrimary && activePrimary.subs.length > 0 && (
        <div className="flex gap-1.5 mb-4 overflow-x-auto pb-1 -mx-1 px-1" role="tablist" aria-label="子分类">
          {activePrimary.subs.map((s) => (
            <button
              key={s.key}
              role="tab"
              aria-selected={activeSubKey === s.key}
              className={cn(
                'px-2.5 py-1 rounded-full text-xs transition-colors',
                activeSubKey === s.key ? 'bg-accent text-on-accent' : 'bg-chip text-muted hover:text-content hover:bg-hover'
              )}
              onClick={() => switchSub(s.key)}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center justify-end mb-3">
        <button
          className={cn('text-xs text-muted hover:text-content', query.isFetching && 'animate-pulse pointer-events-none')}
          onClick={() => queryClient.invalidateQueries({ queryKey: ['vod-categories'] })}
          disabled={query.isFetching}
        >
          刷新分类
        </button>
      </div>

      {primary === 'recommend' ? (
        <RecommendSection onPick={onPick} onOpen={onOpen} />
      ) : primary === 'hot' ? (
        hotQuery.isError ? (
          <p className="text-center text-sm text-faint py-8">最近最火加载失败，可稍后重试</p>
        ) : hotQuery.isLoading ? (
          <GridSkeleton />
        ) : hotItems.length === 0 && !hotQuery.isFetching ? (
          <p className="text-center text-sm text-faint py-8">暂无内容</p>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2.5">
            {hotItems.map((item) => (
              <VodPosterCard key={`${item.sourceKey}:${item.vodId}`} item={item} onClick={() => onOpen(item)} showSource />
            ))}
          </div>
        )
      ) : query.isError ? (
        <p className="text-center text-sm text-faint py-8">分类加载失败，可稍后重试</p>
      ) : query.isLoading ? (
        <GridSkeleton />
      ) : targets.length === 0 ? (
        <p className="text-center text-sm text-faint py-8">该分类暂无可用片源</p>
      ) : listQuery.isError ? (
        <p className="text-center text-sm text-faint py-8">该分类加载失败，可稍后重试</p>
      ) : listQuery.isLoading && page === 1 ? (
        <GridSkeleton />
      ) : accum.length === 0 && !listQuery.isFetching ? (
        <p className="text-center text-sm text-faint py-8">该分类暂无内容</p>
      ) : (
        <>
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2.5">
            {accum.map((item) => (
              <VodPosterCard key={`${item.sourceKey}:${item.vodId}`} item={item} onClick={() => onOpen(item)} showSource />
            ))}
          </div>
          <div className="flex items-center justify-center gap-3 mt-4">
            {listQuery.isFetching && <span className="text-xs text-faint">加载中…</span>}
            {!listQuery.isFetching && (
              <button className="btn-ghost btn-sm" onClick={() => setPage((p) => p + 1)}>
                加载更多
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/** 竖式海报卡（单源列表用，点击直接进详情） */
function VodPosterCard({ item, onClick, showSource }: { item: SearchResultItem; onClick: () => void; showSource?: boolean }) {
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const [imgFailed, setImgFailed] = useState(false);
  const sub = showSource
    ? [item.typeName, item.sourceName].filter(Boolean).join(String.fromCharCode(183))
    : (item.typeName ?? item.sourceName);
  useEffect(() => setImgFailed(false), [item.pic]);

  return (
    <div
      className="card cursor-pointer hover:scale-[1.03] hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <div className="relative aspect-[2/3] bg-chip">
        {item.pic && !imgFailed ? (
          <SmartImage
            url={item.pic}
            mode={imageProxyMode}
            customProxy={customImageProxy}
            alt={item.name}
            className="w-full h-full object-cover"
            onExhausted={() => setImgFailed(true)}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-chip">
            <svg className="w-8 h-8 text-faint" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 4v16m10-16v16M3 6a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6zm4 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1h-1a1 1 0 01-1-1V6zm8 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1h-1a1 1 0 01-1-1V6zm4 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1h-1a1 1 0 01-1-1V6zm4 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1h-1a1 1 0 01-1-1V6z" />
            </svg>
          </div>
        )}
        {item.remarks && (
          <span className="absolute bottom-1.5 left-1.5 tag bg-black/70 text-rating font-medium max-w-[calc(100%-12px)] truncate">
            {item.remarks}
          </span>
        )}
      </div>
      <div className="p-2">
        <div className="text-xs font-medium text-content truncate" title={item.name}>
          {item.name}
        </div>
        <div className="text-[11px] text-faint truncate mt-0.5" title={sub}>
          {sub}
        </div>
      </div>
    </div>
  );
}

function GridSkeleton() {
  return (
    <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2.5">
      {Array.from({ length: 16 }).map((_, i) => (
        <div key={i}>
          <div className="aspect-[2/3] rounded-lg bg-chip animate-pulse" />
          <div className="h-3 mt-2 rounded bg-chip animate-pulse" />
        </div>
      ))}
    </div>
  );
}

