"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client-api";
import { resolveSource, useAppStore } from "@/lib/store";
import type { SearchResultItem } from "@/lib/types";
import { SmartImage } from "./smart-image";
import { cn } from "@/lib/utils";

/**
 * 首页每日最新：聚合已勾选点播源 ac=videolist 第一页（采集站默认按更新时间倒序），
 * 服务端跨源去重并按更新时间排序。竖式海报卡（图上文下）+ 分类筛选，点击直接进详情可播。
 */

const CATEGORIES = ["电影", "剧集", "综艺", "动漫", "纪录片", "其他"] as const;
type Category = (typeof CATEGORIES)[number];

/** 按采集站 type_name 归类（顺序敏感：先判小类再判大类） */
function categoryOf(typeName?: string): Category {
  const t = typeName || "";
  if (/动漫|动画|卡通|番剧|漫/.test(t)) return "动漫";
  if (/综艺|真人秀|选秀|脱口秀/.test(t)) return "综艺";
  if (/纪录|纪实/.test(t)) return "纪录片";
  if (/剧/.test(t)) return "剧集";
  if (/电影|片/.test(t)) return "电影";
  return "其他";
}

export function LatestSection({ onOpen }: { onOpen: (item: SearchResultItem) => void }) {
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const selectedKeys = useAppStore((s) => s.selectedKeys);
  const yellowFilter = useAppStore((s) => s.yellowFilter);
  const queryClient = useQueryClient();
  const [cat, setCat] = useState<"全部" | Category>("全部");

  const sources = useMemo(() => {
    const list = [];
    for (const key of selectedKeys) {
      const s = resolveSource({ customAPIs, envSources }, key);
      if (s && /^https?:\/\//.test(s.url)) {
        list.push({ key: s.key, name: s.name, url: s.url, isAdult: s.isAdult });
      }
    }
    return list;
  }, [customAPIs, envSources, selectedKeys]);

  const keysHash = useMemo(() => sources.map((s) => s.key).sort().join(","), [sources]);

  const query = useQuery({
    queryKey: ["latest", keysHash, yellowFilter],
    queryFn: ({ signal }) => api.latest(sources, yellowFilter, signal),
    enabled: sources.length > 0,
    staleTime: 10 * 60 * 1000,
  });

  const items = query.data?.items ?? [];

  // 源变化时分类回到全部，避免旧分类筛出空列表
  useEffect(() => {
    setCat("全部");
  }, [keysHash]);

  const catCounts = useMemo(() => {
    const counts = new Map();
    for (const i of query.data?.items ?? []) {
      const c = categoryOf(i.typeName);
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    return counts;
  }, [query.data]);

  const visible = cat === "全部" ? items : items.filter((i) => categoryOf(i.typeName) === cat);

  return (
    <section aria-label="每日最新" className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-semibold text-content">每日最新</h2>
        <div className="flex items-center gap-2">
          {query.data && (
            <span className="text-xs text-faint">
              {query.data.okSources}/{query.data.totalSources} 个源 · 按更新时间排序
            </span>
          )}
          {sources.length > 0 && (
            <button
              className={cn(
                "text-xs text-muted hover:text-content transition-colors",
                query.isFetching && "animate-pulse pointer-events-none"
              )}
              onClick={() => {
                queryClient.invalidateQueries({ queryKey: ["latest"] });
              }}
              disabled={query.isFetching}
            >
              刷新
            </button>
          )}
        </div>
      </div>

      {items.length > 0 && catCounts.size > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-4">
          <FilterChip active={cat === "全部"} onClick={() => setCat("全部")}>
            全部
          </FilterChip>
          {CATEGORIES.filter((c) => catCounts.has(c)).map((c) => (
            <FilterChip key={c} active={cat === c} onClick={() => setCat(c)}>
              {c} {catCounts.get(c)}
            </FilterChip>
          ))}
        </div>
      )}

      {sources.length === 0 ? (
        <p className="text-center text-sm text-faint py-8">
          暂无可用点播源：请先登录并在设置中添加或勾选点播源
        </p>
      ) : query.isError ? (
        <p className="text-center text-sm text-faint py-8">最新内容加载失败，可稍后重试</p>
      ) : query.isLoading ? (
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2.5">
          {Array.from({ length: 16 }).map((_, i) => (
            <div key={i}>
              <div className="aspect-[2/3] rounded-lg bg-chip animate-pulse" />
              <div className="h-3 mt-2 rounded bg-chip animate-pulse" />
            </div>
          ))}
        </div>
      ) : visible.length === 0 ? (
        <p className="text-center text-sm text-faint py-8">该分类暂无内容</p>
      ) : (
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2.5">
          {visible.map((item) => (
            <LatestCard
              key={`${item.sourceKey}:${item.vodId}`}
              item={item}
              onClick={() => onOpen(item)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** 竖式海报卡：图上文下（标题 + 来源），更新信息以角标压在海报左下 */
function LatestCard({ item, onClick }: { item: SearchResultItem; onClick: () => void }) {
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
        if (e.key === "Enter" || e.key === " ") {
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
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 4v16m10-16v16M3 6a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6zm4 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1h-1a1 1 0 01-1-1V6zm8 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1h-1a1 1 0 01-1-1V6zm4 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1h-1a1 1 0 01-1-1V6z" />
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
        <div className="text-[11px] text-faint truncate mt-0.5" title={item.sourceName}>
          {item.sourceName}
        </div>
      </div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={cn(
        "px-2.5 py-1 rounded-full text-xs transition-colors",
        active ? "bg-accent text-on-accent" : "bg-chip text-muted hover:text-content hover:bg-hover"
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
