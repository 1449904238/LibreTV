'use client';

import { usePathname, useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';

/** 上次停留位置（同标签页有效）：点播记住首页/搜索页，直播记住频道页，来回切不断档 */
const LAST_VOD_KEY = 'fuhuiTV:last-vod:v1';
const LAST_LIVE_KEY = 'fuhuiTV:last-live:v1';

function loadKey(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function saveKey(key: string, url: string): void {
  try {
    sessionStorage.setItem(key, url);
  } catch {
    // 配额不足时放弃记忆
  }
}

function currentUrl(): string {
  return window.location.pathname + window.location.search;
}

/**
 * 顶栏点播 / 直播切换（替代原来的"直播"单链）。
 * - 去直播前记住当前点播页（含搜索词），回来接上；
 * - 去点播前记住当前直播频道（含 ?url= 等参数），回来继续看；
 * - 点当前已选中的 Tab：点播首页/直播首页则不动，在某直播频道则回直播首页。
 */
export function MediaTabs() {
  const pathname = usePathname();
  const router = useRouter();
  const isLive = pathname.startsWith('/live');

  const goVod = () => {
    const cur = currentUrl();
    if (cur.startsWith('/live')) saveKey(LAST_LIVE_KEY, cur);
    if (cur === '/' || cur.startsWith('/?')) return;
    router.push(loadKey(LAST_VOD_KEY) || '/');
  };

  const goLive = () => {
    const cur = currentUrl();
    if (!cur.startsWith('/live')) saveKey(LAST_VOD_KEY, cur);
    if (cur.startsWith('/live')) {
      if (!window.location.search) return;
      router.push('/live');
      return;
    }
    router.push(loadKey(LAST_LIVE_KEY) || '/live');
  };

  const tabClass = (active: boolean) =>
    cn(
      'whitespace-nowrap px-2 sm:px-3 py-1 sm:py-1.5 text-xs sm:text-sm transition-colors',
      active ? 'bg-accent text-on-accent' : 'text-muted hover:text-content'
    );

  return (
    <div className="flex bg-chip rounded-lg p-0.5" role="tablist" aria-label="点播直播切换">
      <button role="tab" aria-selected={!isLive} className={tabClass(!isLive)} onClick={goVod}>
        点播
      </button>
      <button role="tab" aria-selected={isLive} className={tabClass(isLive)} onClick={goLive}>
        直播
      </button>
    </div>
  );
}
