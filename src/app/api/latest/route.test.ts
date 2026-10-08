import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { POST } from './route';
import { SESSION_COOKIE, signSession } from '@/lib/auth';

/**
 * 每日最新接口单测：多源聚合、跨源同名去重（留更新时间最新）、
 * 按更新时间倒序、成人过滤、坏源不影响整体、结果缓存。
 * 上游一律 mock fetch，无真实网络。
 */

function cmsList(items: Array<Record<string, unknown>>): string {
  return JSON.stringify({ code: 1, pagecount: 1, list: items });
}

let fetchCalls = 0;

/** cms-a 正常 3 条、cms-b 500、cms-c 与 a 有同名条目但更新更晚 */
function mockUpstream(): void {
  fetchCalls = 0;
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    fetchCalls++;
    const url = String(input);
    if (url.includes('cms-a.example')) {
      return new Response(
        cmsList([
          { vod_id: 1, vod_name: '热门剧', vod_pic: 'http://img/a1.jpg', vod_time: '2026-10-01 10:00:00', type_name: '国产剧' },
          { vod_id: 2, vod_name: '老电影', vod_pic: 'http://img/a2.jpg', vod_time: '2026-09-01 10:00:00', type_name: '电影' },
          { vod_id: 3, vod_name: '午夜速递', vod_pic: 'http://img/a3.jpg', vod_time: '2026-10-05 10:00:00', type_name: '福利视频' },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url.includes('cms-c.example')) {
      return new Response(
        cmsList([
          { vod_id: 9, vod_name: '热门剧', vod_pic: 'http://img/c9.jpg', vod_time: '2026-10-07 10:00:00', type_name: '国产剧' },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url.includes('cms-cache.example')) {
      return new Response(
        cmsList([
          { vod_id: 5, vod_name: '缓存剧', vod_pic: 'http://img/d5.jpg', vod_time: '2026-10-06 10:00:00', type_name: '国产剧' },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url.includes('cms-b.example')) {
      return new Response('server error', { status: 500 });
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fn);
}

function makeRequest(body: unknown): Request {
  const { token } = signSession();
  return new Request('https://local.test/api/latest', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      cookie: `${SESSION_COOKIE}=${token}`,
    },
    body: JSON.stringify(body),
  });
}

const SOURCES = [
  { key: 'a', name: '源A', url: 'https://cms-a.example.com/api.php' },
  { key: 'b', name: '源B', url: 'https://cms-b.example.com/api.php' },
  { key: 'c', name: '源C', url: 'https://cms-c.example.com/api.php' },
];

beforeAll(() => {
  process.env.PASSWORD = 'test-password-123';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/latest', () => {
  it('聚合多源并按更新时间倒序', async () => {
    mockUpstream();
    const res = await POST(makeRequest({ sources: SOURCES }));
    const data = (await res.json()) as { items: Array<{ name: string }>; okSources: number; totalSources: number };
    // 同名“热门剧”只留一条（cms-c 的更新更晚）
    expect(data.items.map((i) => i.name)).toEqual(['热门剧', '午夜速递', '老电影']);
    expect(data.okSources).toBe(2);
    expect(data.totalSources).toBe(3);
  });

  it('同名去重保留更新时间最新的一条（含来源信息可直接播放）', async () => {
    mockUpstream();
    const res = await POST(makeRequest({ sources: SOURCES }));
    const data = (await res.json()) as {
      items: Array<{ name: string; sourceKey: string; vodId: string; sourceUrl: string }>;
    };
    const hit = data.items.find((i) => i.name === '热门剧');
    expect(hit?.sourceKey).toBe('c');
    expect(hit?.vodId).toBe('9');
    expect(hit?.sourceUrl).toBe('https://cms-c.example.com/api.php');
  });

  it('成人内容过滤', async () => {
    mockUpstream();
    const res = await POST(makeRequest({ sources: SOURCES, filterAdult: true }));
    const data = (await res.json()) as { items: Array<{ name: string }> };
    expect(data.items.map((i) => i.name)).not.toContain('午夜速递');
  });

  it('空源列表直接返回空', async () => {
    mockUpstream();
    const res = await POST(makeRequest({ sources: [] }));
    const data = (await res.json()) as { items: unknown[]; okSources: number };
    expect(data.items).toEqual([]);
    expect(data.okSources).toBe(0);
    expect(fetchCalls).toBe(0);
  });

  it('同一批源命中服务端缓存（第二次不打上游）', async () => {
    mockUpstream();
    const cached = [{ key: 'd', name: '源D', url: 'https://cms-cache.example.com/api.php' }];
    await POST(makeRequest({ sources: cached }));
    const firstCalls = fetchCalls;
    expect(firstCalls).toBe(1);
    const res = await POST(makeRequest({ sources: cached }));
    expect(fetchCalls).toBe(firstCalls);
    const data = (await res.json()) as { items: Array<{ name: string }> };
    expect(data.items.map((i) => i.name)).toEqual(['缓存剧']);
  });
});
