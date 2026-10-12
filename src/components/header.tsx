'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ThemeToggle } from './theme';
import { SourceManagerDrawer } from './source-manager';
import { HistoryPanel } from './history-panel';
import { requestShowDownloadManager } from './download-manager';
import { Icon, type IconName } from './icon';
import { SearchHistoryDropdown, useSearchHistory } from './search-history';
import { MediaTabs } from './media-tabs';
import { cn } from '@/lib/utils';
import { useAuth } from './auth';

/** 顶部导航：Logo、搜索框（首页外）、历史、设置 */
export function Header({ showSearch = false }: { showSearch?: boolean }) {
  const router = useRouter();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // 移动端菜单：Esc 关闭
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);
  const [query, setQuery] = useState('');
  // 与首页搜索框共用同一套「最近搜索」下拉逻辑
  const searchHistory = useSearchHistory(query);
  const { verified, logout, openLogin } = useAuth();

  const submitSearch = (text: string) => {
    const q = text.trim().slice(0, 100);
    if (!q) return;
    searchHistory.close();
    router.push(`/?s=${encodeURIComponent(q)}`, { scroll: false });
    // 顶栏搜索一并写入最近搜索（此前只有首页会记录）
    searchHistory.record(q);
  };

  const pickHistory = (text: string) => {
    setQuery(text);
    submitSearch(text);
  };

  return (
    <>
      <header className="sticky top-0 z-40 bg-surface/90 backdrop-blur border-b border-line">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center gap-3">
          <Link href="/" aria-label="fuhuiTV 首页" className="flex items-center shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/icons/icon-512.png" alt="fuhuiTV" className="w-7 h-7 rounded-lg" />
          </Link>

          {showSearch && (
            <form
              className="flex-1 max-w-xl hidden sm:block"
              onSubmit={(e) => {
                e.preventDefault();
                submitSearch(query);
              }}
            >
              <div ref={searchHistory.containerRef} className="relative">
                <input
                  className={cn(
                    'input w-full h-9',
                    // 展开时：上圆角与外框沿用聚焦样式，底边改为内部分隔线，与下拉拼成同一面板
                    searchHistory.visible &&
                      'rounded-b-none border-accent border-b-line bg-surface-raised focus-visible:ring-0'
                  )}
                  aria-label="搜索影片"
                  placeholder="搜索影片..."
                  value={query}
                  maxLength={100}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    searchHistory.resetActive();
                  }}
                  onFocus={searchHistory.onFocus}
                  onKeyDown={(e) => searchHistory.onKeyDown(e, pickHistory)}
                  role="combobox"
                  aria-expanded={searchHistory.visible}
                  aria-controls="header-search-history"
                  aria-autocomplete="list"
                  aria-activedescendant={
                    searchHistory.visible && searchHistory.activeIndex >= 0
                      ? `header-search-history-${searchHistory.activeIndex}`
                      : undefined
                  }
                />
                {searchHistory.visible && (
                  <SearchHistoryDropdown
                    id="header-search-history"
                    matches={searchHistory.matches}
                    activeIndex={searchHistory.activeIndex}
                    onPick={pickHistory}
                    onRemove={searchHistory.remove}
                    onClearAll={searchHistory.clearAll}
                  />
                )}
              </div>
            </form>
          )}

          <div className="flex-1 sm:hidden" />

          <nav className="flex items-center gap-1 ml-auto">
            <MediaTabs />
            <ThemeToggle />
            <div className="hidden sm:flex items-center gap-1">
              <IconButton label="观看历史" onClick={() => setHistoryOpen(true)}>
                <Icon name="clock" />
              </IconButton>
              <IconButton label="下载管理" onClick={() => requestShowDownloadManager()}>
                <Icon name="download" />
              </IconButton>
              <IconButton label="设置" onClick={() => setSettingsOpen(true)}>
                <Icon name="gear" />
              </IconButton>
              {verified && (
                <IconButton label="退出登录" onClick={() => logout()}>
                  <Icon name="logout" />
                </IconButton>
              )}
            </div>
            {!verified && (
              <button className="ml-1 shrink-0 whitespace-nowrap px-2.5 sm:px-3 py-1.5 rounded-md text-xs sm:text-sm bg-accent text-on-accent transition-colors hover:opacity-90" onClick={() => openLogin()}>
                登录
              </button>
            )}
            <div className="relative sm:hidden">
              <IconButton label="更多操作" onClick={() => setMenuOpen((v) => !v)}>
                <Icon name="menu" />
              </IconButton>
              {menuOpen && (
                <>
                  <button
                    aria-hidden
                    tabIndex={-1}
                    className="fixed inset-0 z-30 cursor-default bg-transparent"
                    onClick={() => setMenuOpen(false)}
                  />
                  <div className="absolute right-0 top-full z-40 mt-2 w-44 card p-1.5" role="menu" aria-label="更多操作">
                    <MenuRow icon="clock" label="观看历史" onClick={() => { setMenuOpen(false); setHistoryOpen(true); }} />
                    <MenuRow icon="download" label="下载管理" onClick={() => { setMenuOpen(false); requestShowDownloadManager(); }} />
                    <MenuRow icon="gear" label="设置" onClick={() => { setMenuOpen(false); setSettingsOpen(true); }} />
                    {verified && (
                      <MenuRow icon="logout" label="退出登录" onClick={() => { setMenuOpen(false); logout(); }} />
                    )}
                  </div>
                </>
              )}
            </div>
          </nav>
        </div>
      </header>

      <SourceManagerDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <HistoryPanel open={historyOpen} onClose={() => setHistoryOpen(false)} />
    </>
  );
}


/** 移动端下拉菜单行：链接或按钮统一样式 */
function MenuRow({
  icon,
  label,
  onClick,
  href,
  onNavigate,
}: {
  icon: IconName;
  label: string;
  onClick?: () => void;
  href?: string;
  onNavigate?: () => void;
}) {
  const inner = (
    <>
      <Icon name={icon} className="w-4 h-4 shrink-0" />
      <span className="text-sm">{label}</span>
    </>
  );
  const cls = 'w-full flex items-center gap-2.5 rounded-md px-2.5 py-2 text-muted hover:text-content hover:bg-hover transition-colors text-left';
  if (href) {
    return (
      <Link href={href} className={cls} role="menuitem" onClick={onNavigate}>
        {inner}
      </Link>
    );
  }
  return (
    <button className={cls} role="menuitem" onClick={onClick}>
      {inner}
    </button>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className="p-2 rounded-md text-muted hover:text-content hover:bg-hover transition-colors"
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
