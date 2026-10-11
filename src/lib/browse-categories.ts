import type { MergedCategory, VodCategory } from './types';
import { isAdultContent } from './cms-parser';

/** 首页分类展示上限：默认展示前 N 个，其余折叠进"展开更多" */
export const BROWSE_CATEGORY_LIMIT = 10;

/**
 * 分类名归一化：去空白与标点、转小写，用于跨源同名合并。
 * 例："动作片 " / "动作片" / "动作 片" 归一为同一 key。
 */
export function normalizeCategoryName(name: string): string {
  return name.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/**
 * 多源分类聚合：同名（归一后）合并为一项，refs 指回各源 type_id。
 * 排序：拥有源数量多的在前，同数量时按名称排序，保证每日缓存命中后展示稳定。
 */
export function mergeSourceCategories(
  perSource: { sourceKey: string; categories: VodCategory[] }[]
): MergedCategory[] {
  const buckets = new Map<string, MergedCategory>();
  for (const { sourceKey, categories } of perSource) {
    const seen = new Set<string>();
    for (const c of categories) {
      const key = normalizeCategoryName(c.name);
      if (!key || seen.has(`${key}`)) continue;
      seen.add(`${key}`);
      const exist = buckets.get(key);
      if (exist) {
        if (!exist.refs.some((r) => r.sourceKey === sourceKey && r.typeId === c.id)) {
          exist.refs.push({ sourceKey, typeId: c.id });
          exist.sourceCount = new Set(exist.refs.map((r) => r.sourceKey)).size;
        }
      } else {
        buckets.set(key, {
          key,
          name: c.name.trim(),
          sourceCount: 1,
          refs: [{ sourceKey, typeId: c.id }],
        });
      }
    }
  }
  return [...buckets.values()].sort(
    (a, b) => b.sourceCount - a.sourceCount || a.name.localeCompare(b.name, 'zh')
  );
}

/** 成人分类过滤（复用搜索的成人关键词表，与 yellowFilter 开关联动） */
export function filterAdultCategories<T extends { name: string }>(items: T[], enabled: boolean): T[] {
  if (!enabled) return items;
  return items.filter((i) => !isAdultContent(i.name));
}

/** 折叠切片：默认展示前 limit 个，返回可见项与是否还有更多 */
export function sliceCategories<T>(items: T[], expanded: boolean, limit = BROWSE_CATEGORY_LIMIT): { visible: T[]; collapsed: number } {
  if (expanded || items.length <= limit) return { visible: items, collapsed: 0 };
  return { visible: items.slice(0, limit), collapsed: items.length - limit };
}
