import { describe, expect, it } from 'vitest';
import {
  TAXONOMY,
  filterDomesticItems,
  isForeignItem,
  matchSourceCategory,
} from './browse-taxonomy';

function hits(name: string): string[] {
  return matchSourceCategory(name)
    .map((h) => `${h.primary}:${h.secondary ?? '-'}`)
    .sort();
}

describe('matchSourceCategory', () => {
  it('电影二级：动作片进动作/武打', () => {
    expect(hits('动作片')).toEqual(['movie:action']);
  });

  it('电影兜底：电影片进全部电影', () => {
    expect(hits('电影片')).toEqual(['movie:all']);
  });

  it('剧情片归电影不归剧集', () => {
    expect(hits('剧情片')).toEqual(['movie:all']);
  });

  it('连续剧进剧集全部', () => {
    expect(hits('连续剧')).toContain('tv:all');
  });

  it('国产剧进国产节点', () => {
    expect(hits('国产剧')).toEqual(expect.arrayContaining(['tv:all', 'tv:domestic']));
  });

  it('短剧独立成类，不进剧集', () => {
    expect(hits('短剧')).toEqual(['short:-']);
  });

  it('韩剧进海外日韩，不进剧集', () => {
    expect(hits('韩剧')).toEqual(expect.arrayContaining(['overseas:jpk']));
    expect(hits('韩剧').some((h) => h.startsWith('tv:'))).toBe(false);
  });

  it('悬疑可双归属电影与剧集', () => {
    expect(hits('悬疑')).toEqual(expect.arrayContaining(['movie:suspense', 'tv:suspense']));
  });

  it('综艺/动漫/纪录片单节点', () => {
    expect(hits('大陆综艺')).toEqual(['variety:-']);
    expect(hits('国产动漫')).toEqual(['anime:-']);
    expect(hits('纪录片')).toEqual(['doc:-']);
  });

  it('无归属类目被丢弃：伦理片/电影解说/体育/台球', () => {
    for (const name of ['伦理片', '电影解说', '体育', '足球', '台球', '预告片', '']) {
      expect(hits(name)).toEqual([]);
    }
  });

  it('日韩综艺统一进海外专区，不进综艺节点', () => {
    expect(hits('日韩综艺')).toEqual(['overseas:jpk']);
  });

  it('国产动漫只进动漫节点', () => {
    expect(hits('国产动漫')).toEqual(['anime:-']);
  });

  it('港剧算国产剧集节点', () => {
    expect(hits('港剧')).toContain('tv:all');
    expect(hits('港剧').some((h) => h.startsWith('overseas'))).toBe(false);
  });

  it('泰国剧进其他海外', () => {
    expect(hits('泰国剧')).toEqual(expect.arrayContaining(['overseas:other']));
  });
});

describe('isForeignItem / filterDomesticItems', () => {
  it('地区命中即海外', () => {
    expect(isForeignItem({ area: '日本' })).toBe(true);
    expect(isForeignItem({ area: '美国' })).toBe(true);
    expect(isForeignItem({ area: '大陆', typeName: '国产剧' })).toBe(false);
  });

  it('类型名命中即海外', () => {
    expect(isForeignItem({ typeName: '韩国伦理' })).toBe(true);
    expect(isForeignItem({ typeName: '剧情片' })).toBe(false);
  });

  it('字段缺失时保留（避免误杀）', () => {
    expect(isForeignItem({})).toBe(false);
    expect(filterDomesticItems([{}, { area: '日本' }])).toHaveLength(1);
  });
});

describe('TAXONOMY 结构', () => {
  it('一级顺序与二级默认选中', () => {
    expect(TAXONOMY.map((p) => p.key)).toEqual([
      'hot', 'movie', 'tv', 'variety', 'anime', 'short', 'doc', 'overseas',
    ]);
    for (const p of TAXONOMY) {
      if (p.subs.length > 0) expect(p.subs[0].key).toBe('all');
    }
  });
});

