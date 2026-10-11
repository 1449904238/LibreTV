import { describe, expect, it } from 'vitest';
import {
  BROWSE_CATEGORY_LIMIT,
  filterAdultCategories,
  mergeSourceCategories,
  normalizeCategoryName,
  sliceCategories,
} from './browse-categories';

describe('normalizeCategoryName', () => {
  it('去空白标点并小写', () => {
    expect(normalizeCategoryName('动作片 ')).toBe(normalizeCategoryName('动作 片'));
    expect(normalizeCategoryName('Movie')).toBe('movie');
  });
});

describe('mergeSourceCategories', () => {
  it('跨源同名合并并统计源数量', () => {
    const merged = mergeSourceCategories([
      { sourceKey: 'a', categories: [{ id: 1, name: '电影' }, { id: 2, name: '剧集' }] },
      { sourceKey: 'b', categories: [{ id: 6, name: '电影' }, { id: 7, name: '综艺' }] },
    ]);
    expect(merged).toHaveLength(3);
    expect(merged[0]).toMatchObject({ name: '电影', sourceCount: 2 });
    expect(merged[0].refs).toEqual([
      { sourceKey: 'a', typeId: 1 },
      { sourceKey: 'b', typeId: 6 },
    ]);
  });

  it('同源重复分类去重', () => {
    const merged = mergeSourceCategories([
      { sourceKey: 'a', categories: [{ id: 1, name: '电影' }, { id: 1, name: '电影' }] },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].refs).toHaveLength(1);
  });
});

describe('filterAdultCategories', () => {
  it('开启时过滤成人分类', () => {
    const items = [{ name: '电影' }, { name: '伦理片' }];
    expect(filterAdultCategories(items, true)).toEqual([{ name: '电影' }]);
    expect(filterAdultCategories(items, false)).toHaveLength(2);
  });
});

describe('sliceCategories', () => {
  it('默认展示前10个并给出折叠数', () => {
    const items = Array.from({ length: 13 }, (_, i) => ({ name: `c${i}` }));
    const { visible, collapsed } = sliceCategories(items, false);
    expect(visible).toHaveLength(BROWSE_CATEGORY_LIMIT);
    expect(collapsed).toBe(3);
    expect(sliceCategories(items, true).visible).toHaveLength(13);
  });
});
