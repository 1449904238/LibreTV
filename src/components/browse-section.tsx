'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
import { resolveSource, useAppStore } from '@/lib/store';
import { cn, validateSourceUrl } from '@/lib/utils';
import type { SearchResultItem, SourceConfig } from '@/lib/types';
import { isAdultContent } from '@/lib/cms-parser';
import {
  BROWSE_CATEGORY_LIMIT,
  filterAdultCategories,
  sliceCategories,
} from '@/lib/browse-categories';
import { RecommendSection } from './douban-section';
import { SmartImage } from './smart-image';
import { aggregateResults, AggregatedCard } from './video-card';

/**
 * 首页浏览区：三种模式可切换（选择即持久化）。
 * - single：默认源模式。首页可切换默认源，分类即该源 ac=list 的真实分类。
 * - aggregate：聚合模式。全源分类归一合并，默认展示前10个、其余折叠。
 * - recommend：现有推荐榜单（豆瓣 / Bangumi / 影视热榜），保持不变。
 * 分类走服务端 24h 缓存（/api/categories），客户端 staleTime 同步为 24h，
 * 满足"每日缓存一次"；列表走 10 分钟缓存，翻页即时可用。
 */

const MODE_TABS = [
  { id: 'single', label: '单源分类' },
  { id: 'aggregate', label: '聚合分类' },
  { id: 'recommend', label: '推荐榜单' },
] as const;

type ModeId = (typeof MODE_TABS)[number]['id'];

export function BrowseSection({
  onPick,
  onOpen,
}: {
  onPick: (title: string) => void;
  onOpen: (item: SearchResultItem) => void;
}) {
  const browseMode = useAppStore((s) => s.browseMode);
  const updateSettings = useAppStore((s) => s.updateSettings);

  return (
    <section aria-label="分类浏览">
      <div className="flex flex-wrap items-center gap-1.5 mb-4">
        <div className="flex bg-chip rounded-lg p-0.5" role="tablist" aria-label="浏览模式">
          {MODE_TABS.map((m) => (
            <button
              key={m.id}
              role="tab"
              aria-selected={browseMode === m.id}
              className={cn(
                'px-3.5 py-1.5 rounded-md text-sm transition-colors',
                browseMode === m.id ? 'bg-accent text-on-accent' : 'text-muted hover:text-content'
              )}
              onClick={() => updateSettings({ browseMode: m.id as ModeId })}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {browseMode === 'single' ? (
        <SingleSourceBrowser onOpen={onOpen} />
      ) : browseMode === 'aggregate' ? (
        <AggregateBrowser onOpen={onOpen} />
      ) : (
        <RecommendSection onPick={onPick} onOpen={onOpen} />
      )}
    </section>
  );
}

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

/** 单源模式：首页切换默认源 → 分类即该源分类 */
function SingleSourceBrowser({ onOpen }: { onOpen: (item: SearchResultItem) => void }) {
  const sources = useAvailableSources();
  const defaultKey = useAppStore((s) => s.defaultBrowseSourceKey);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const yellowFilter = useAppStore((s) => s.yellowFilter);
  const queryClient = useQueryClient();

  const activeSource = useMemo(() => {
    if (sources.length === 0) return null;
    return sources.find((s) => s.key === defaultKey) ?? sources[0];
  }, [sources, defaultKey]);

  const { query } = useCategoriesQuery(sources, true);
  const [catExpanded, setCatExpanded] = useState(false);
  const [typeId, setTypeId] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [accum, setAccum] = useState<SearchResultItem[]>([]);
  const [pagecount, setPagecount] = useState(1);

  const rawCats = useMemo(() => {
    if (!query.data || !activeSource) return [];
    const entry = query.data.sources.find((s) => s.sourceKey === activeSource.key);
    return entry?.categories ?? [];
  }, [query.data, activeSource]);
  const cats = useMemo(() => filterAdultCategories(rawCats, yellowFilter), [rawCats, yellowFilter]);
  const { visible: visibleCats, collapsed } = sliceCategories(cats, catExpanded);

  // 源或分类就绪时默认选中第一个分类；源切换时收起折叠并重置列表
  useEffect(() => {
    setCatExpanded(false);
    setPage(1);
    setAccum([]);
    setTypeId(null);
  }, [activeSource?.key]);
  useEffect(() => {
    if (cats.length === 0) {
      if (typeId !== null) {
        setTypeId(null);
        setPage(1);
        setAccum([]);
      }
      return;
    }
    if (typeId === null || !cats.some((c) => c.id === typeId)) {
      setTypeId(cats[0].id);
      setPage(1);
      setAccum([]);
      setPagecount(1);
    }
  }, [cats, typeId]);


  const listQuery = useQuery({
    queryKey: ['vod-list-single', activeSource?.key, typeId, page, yellowFilter],
    queryFn: ({ signal }) =>
      api.vodListSingle(activeSource as SourceConfig, typeId as number, page, yellowFilter, signal),
    enabled: !!activeSource && typeId !== null,
    staleTime: 10 * 60 * 1000,
  });
  useEffect(() => {
    if (!listQuery.data) return;
    const rows = listQuery.data.list;
    setPagecount(listQuery.data.pagecount);
    setAccum((prev) => (page === 1 ? rows : [...prev, ...rows]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listQuery.data]);

  const switchSource = (key: string) => {
    if (key === activeSource?.key) return;
    updateSettings({ defaultBrowseSourceKey: key });
  };
  const switchCat = (id: number) => {
    if (id === typeId) return;
    setTypeId(id);
    setPagecount(1);
    setPage(1);
    setAccum([]);
  };

  if (sources.length === 0) {
    return <p className="text-center text-sm text-faint py-8">暂无可用点播源：请先登录并在设置中添加或勾选点播源</p>;
  }

  return (
    <div>
      {/* 默认源切换 */}
      <div className="flex flex-wrap gap-1.5 mb-3" aria-label="默认源">
        {sources.map((s) => (
          <button
            key={s.key}
            className={cn(
              'px-2.5 py-1 rounded-full text-xs transition-colors',
              s.key === activeSource?.key
                ? 'bg-accent text-on-accent'
                : 'bg-chip text-muted hover:text-content hover:bg-hover'
            )}
            onClick={() => switchSource(s.key)}
          >
            {s.name}
          </button>
        ))}
      </div>

      {/* 该源分类：默认前10，其余折叠 */}
      <div className="flex items-center justify-end mb-3">
        <button
          className={cn('text-xs text-muted hover:text-content', query.isFetching && 'animate-pulse pointer-events-none')}
          onClick={() => queryClient.invalidateQueries({ queryKey: ['vod-categories'] })}
          disabled={query.isFetching}
        >
          刷新分类
        </button>
      </div>
      {query.isError ? (
        <p className="text-center text-sm text-faint py-8">分类加载失败，可稍后重试</p>
      ) : query.isLoading ? (
        <div className="flex flex-wrap gap-1.5 mb-4">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="h-7 w-16 rounded-full bg-chip animate-pulse" />
          ))}
        </div>
      ) : cats.length === 0 ? (
        <p className="text-center text-sm text-faint py-8">该源暂无可用分类</p>
      ) : (
        <div className="flex flex-wrap gap-1.5 mb-4">
          {visibleCats.map((c) => (
            <button
              key={c.id}
              className={cn(
                'px-2.5 py-1 rounded-full text-xs transition-colors',
                c.id === typeId ? 'bg-accent text-on-accent' : 'bg-chip text-muted hover:text-content hover:bg-hover'
              )}
              onClick={() => switchCat(c.id)}
            >
              {c.name}
            </button>
          ))}
          {collapsed > 0 && (
            <button
              className="px-2.5 py-1 rounded-full text-xs bg-chip text-muted hover:text-content hover:bg-hover"
              onClick={() => setCatExpanded(true)}
            >
              展开更多
            </button>
          )}
          {catExpanded && cats.length > BROWSE_CATEGORY_LIMIT && (
            <button
              className="px-2.5 py-1 rounded-full text-xs bg-chip text-muted hover:text-content hover:bg-hover"
              onClick={() => setCatExpanded(false)}
            >
              收起
            </button>
          )}
        </div>
      )}

      {/* 分类内容 */}
      {typeId === null ? null : listQuery.isError ? (
        <p className="text-center text-sm text-faint py-8">该分类加载失败，可稍后重试</p>
      ) : listQuery.isLoading && page === 1 ? (
        <GridSkeleton />
      ) : accum.length === 0 && !listQuery.isFetching ? (
        <p className="text-center text-sm text-faint py-8">该分类暂无内容</p>
      ) : (
        <>
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2.5">
            {accum.map((item) => (
              <VodPosterCard key={`${item.sourceKey}:${item.vodId}`} item={item} onClick={() => onOpen(item)} />
            ))}
          </div>
          <div className="flex items-center justify-center gap-3 mt-4">
            {listQuery.isFetching && <span className="text-xs text-faint">加载中…</span>}
            {!listQuery.isFetching && page < pagecount && (
              <button className="btn-ghost btn-sm" onClick={() => setPage((p) => p + 1)}>
                加载更多
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** 聚合模式：全源分类归一，默认前10、其余折叠 */
function AggregateBrowser({ onOpen }: { onOpen: (item: SearchResultItem) => void }) {
  const sources = useAvailableSources();
  const yellowFilter = useAppStore((s) => s.yellowFilter);
  const queryClient = useQueryClient();
  const byKey = useMemo(() => new Map(sources.map((s) => [s.key, s])), [sources]);

  const { query, hash: sourcesHash } = useCategoriesQuery(sources, true);
  const [catExpanded, setCatExpanded] = useState(false);
  const [catKey, setCatKey] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [accum, setAccum] = useState<SearchResultItem[]>([]);

  const merged = useMemo(() => {
    const rows = query.data?.merged ?? [];
    return yellowFilter ? rows.filter((m) => !isAdultContent(m.name)) : rows;
  }, [query.data, yellowFilter]);
  const { visible: visibleCats, collapsed } = sliceCategories(merged, catExpanded);

  useEffect(() => {
    setCatExpanded(false);
    setCatKey(null);
    setPage(1);
    setAccum([]);
  }, [sourcesHash]);
  useEffect(() => {
    if (merged.length === 0) {
      if (catKey !== null) {
        setCatKey(null);
        setPage(1);
        setAccum([]);
      }
      return;
    }
    if (catKey === null || !merged.some((m) => m.key === catKey)) {
      setCatKey(merged[0].key);
      setPage(1);
      setAccum([]);
    }
  }, [merged, catKey]);

  const active = merged.find((m) => m.key === catKey) ?? null;
  const targets = useMemo(() => {
    if (!active) return [];
    const grouped = new Map<string, number[]>();
    for (const r of active.refs) {
      if (!byKey.has(r.sourceKey)) continue;
      if (!grouped.has(r.sourceKey)) grouped.set(r.sourceKey, []);
      grouped.get(r.sourceKey)!.push(r.typeId);
    }
    return [...grouped.entries()].map(([key, typeIds]) => ({
      source: byKey.get(key) as SourceConfig,
      typeIds,
    }));
  }, [active, byKey]);

  const listQuery = useQuery({
    queryKey: ['vod-list-agg', catKey, page, yellowFilter, targets.map((t) => t.source.key).sort().join(',')],
    queryFn: ({ signal }) => api.vodListAggregate(targets, page, yellowFilter, signal),
    enabled: targets.length > 0,
    staleTime: 10 * 60 * 1000,
  });
  useEffect(() => {
    if (!listQuery.data) return;
    const rows = listQuery.data.list;
    setAccum((prev) => (page === 1 ? rows : [...prev, ...rows]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listQuery.data]);

  const switchCat = (key: string) => {
    if (key === catKey) return;
    setCatKey(key);
    setPage(1);
    setAccum([]);
  };

  const groups = useMemo(() => aggregateResults(accum), [accum]);
  if (sources.length === 0) {
    return <p className="text-center text-sm text-faint py-8">暂无可用点播源：请先登录并在设置中添加或勾选点播源</p>;
  }


  return (
    <div>
      <div className="flex items-center justify-end mb-3">
        <button
          className={cn('text-xs text-muted hover:text-content', query.isFetching && 'animate-pulse pointer-events-none')}
          onClick={() => queryClient.invalidateQueries({ queryKey: ['vod-categories'] })}
          disabled={query.isFetching}
        >
          刷新分类
        </button>
      </div>

      {query.isError ? (
        <p className="text-center text-sm text-faint py-8">分类加载失败，可稍后重试</p>
      ) : query.isLoading ? (
        <div className="flex flex-wrap gap-1.5 mb-4">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="h-7 w-16 rounded-full bg-chip animate-pulse" />
          ))}
        </div>
      ) : merged.length === 0 ? (
        <p className="text-center text-sm text-faint py-8">暂无可用分类</p>
      ) : (
        <div className="flex flex-wrap gap-1.5 mb-4">
          {visibleCats.map((c) => (
            <button
              key={c.key}
              className={cn(
                'px-2.5 py-1 rounded-full text-xs transition-colors',
                c.key === catKey ? 'bg-accent text-on-accent' : 'bg-chip text-muted hover:text-content hover:bg-hover'
              )}
              onClick={() => switchCat(c.key)}
            >
              {c.name}
            </button>
          ))}
          {collapsed > 0 && (
            <button
              className="px-2.5 py-1 rounded-full text-xs bg-chip text-muted hover:text-content hover:bg-hover"
              onClick={() => setCatExpanded(true)}
            >
              展开更多
            </button>
          )}
          {catExpanded && merged.length > BROWSE_CATEGORY_LIMIT && (
            <button
              className="px-2.5 py-1 rounded-full text-xs bg-chip text-muted hover:text-content hover:bg-hover"
              onClick={() => setCatExpanded(false)}
            >
              收起
            </button>
          )}
        </div>
      )}

      {catKey === null ? null : listQuery.isError ? (
        <p className="text-center text-sm text-faint py-8">该分类加载失败，可稍后重试</p>
      ) : listQuery.isLoading && page === 1 ? (
        <GridSkeleton />
      ) : accum.length === 0 && !listQuery.isFetching ? (
        <p className="text-center text-sm text-faint py-8">该分类暂无内容</p>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 items-start">
            {groups.map((g) => (
              <AggregatedCard key={g.key} group={g} onOpen={onOpen} />
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
    </div>
  );
}

/** 竖式海报卡（单源列表用，点击直接进详情） */
function VodPosterCard({ item, onClick }: { item: SearchResultItem; onClick: () => void }) {
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const [imgFailed, setImgFailed] = useState(false);
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
        <div className="text-[11px] text-faint truncate mt-0.5" title={item.typeName ?? item.sourceName}>
          {item.typeName ?? item.sourceName}
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
