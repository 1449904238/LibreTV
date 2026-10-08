import { formatTime } from './utils';

/**
 * 移动端触屏手势（点播 player-shell / 直播 live-player 共用）。
 *
 * - 长按（默认500ms）3 倍速播放，松手恢复（点播用；直播可传 longPressDelay: 0 关闭）；
 * - 横向滑动：快进 / 快退（点播用，满屏滑动 = 120 秒；直播传 enableSeek: false 关闭）；
 * - 左半屏上下滑：亮度（Web 调不了系统亮度，用 CSS brightness 滤镜模拟，
 *   范围 0.3–1.5，松手后持久化到 localStorage，下次打开自动恢复）；
 * - 右半屏上下滑：音量（0–100%，上滑增大）。
 *
 * 只处理单指触摸；位移超过阈值才锁定方向进入手势，并取消长按计时，
 * 因此点按（播放/暂停）、双击（全屏）等 ArtPlayer 原生交互不受影响。
 */

export interface GestureArt {
  video?: HTMLVideoElement | null;
}

export interface VideoGestureOptions {
  enableSeek?: boolean;
  longPressDelay?: number;
  longPressRate?: number;
  showHint: (text: string) => void;
  isLocked?: () => boolean;
}

const BRIGHTNESS_KEY = 'libretv-video-brightness';
const BRIGHTNESS_MIN = 0.3;
const BRIGHTNESS_MAX = 1.5;
const ENGAGE_THRESHOLD = 12;
const SEEK_FULL_WIDTH_SECONDS = 120;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function loadBrightness(): number {
  try {
    const raw = localStorage.getItem(BRIGHTNESS_KEY);
    if (raw == null) return 1;
    const value = Number(raw);
    return Number.isFinite(value) ? clamp(value, BRIGHTNESS_MIN, BRIGHTNESS_MAX) : 1;
  } catch {
    return 1;
  }
}

function saveBrightness(value: number): void {
  try {
    localStorage.setItem(BRIGHTNESS_KEY, String(value));
  } catch {
    // ignore (private mode etc.)
  }
}

function applyBrightness(video: HTMLVideoElement, value: number): void {
  video.style.filter = Math.abs(value - 1) < 0.005 ? "" : `brightness(${value.toFixed(2)})`;
}

type GestureMode = 'seek' | 'volume' | 'brightness' | null;

export function attachVideoGestures(
  container: HTMLElement,
  art: GestureArt,
  options: VideoGestureOptions,
): () => void {
  const { enableSeek = true, longPressDelay = 500, longPressRate = 3.0, showHint, isLocked } = options;

  if (art.video) applyBrightness(art.video, loadBrightness());

  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let isLongPress = false;
  let originalRate = 1;
  let startX = 0;
  let startY = 0;
  let startTime = 0;
  let startVolume = 0.8;
  let startBrightness = 1;
  let currentBrightness = 1;
  let mode: GestureMode = null;

  const clearLongPressTimer = () => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  };

  const onTouchStart = (e: TouchEvent) => {
    const video = art.video;
    if (!video || e.touches.length !== 1) {
      clearLongPressTimer();
      return;
    }
    const touch = e.touches[0];
    startX = touch.clientX;
    startY = touch.clientY;
    startTime = video.currentTime;
    startVolume = video.volume;
    startBrightness = loadBrightness();
    currentBrightness = startBrightness;
    mode = null;
    if (isLocked?.() ?? false) return;
    if (longPressDelay <= 0 || video.paused) return;
    originalRate = video.playbackRate;
    clearLongPressTimer();
    longPressTimer = setTimeout(() => {
      const v = art.video;
      if (!v || v.paused || mode) return;
      v.playbackRate = longPressRate;
      isLongPress = true;
      showHint(`${longPressRate} 倍速`);
      e.preventDefault();
    }, longPressDelay);
  };

  const onTouchMove = (e: TouchEvent) => {
    const video = art.video;
    if (!video || e.touches.length !== 1 || (isLocked?.() ?? false)) {
      clearLongPressTimer();
      return;
    }
    if (isLongPress) {
      e.preventDefault();
      return;
    }
    const touch = e.touches[0];
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    if (!mode) {
      if (Math.hypot(dx, dy) < ENGAGE_THRESHOLD) return;
      clearLongPressTimer();
      const rect = container.getBoundingClientRect();
      if (Math.abs(dx) > Math.abs(dy)) {
        if (!enableSeek || !Number.isFinite(video.duration) || video.duration <= 0) return;
        mode = 'seek';
      } else {
        mode = touch.clientX - rect.left < rect.width / 2 ? 'brightness' : 'volume';
      }
    }
    e.preventDefault();
    const rect = container.getBoundingClientRect();
    if (mode === 'seek') {
      const target = clamp(
        startTime + (dx / rect.width) * SEEK_FULL_WIDTH_SECONDS,
        0,
        video.duration,
      );
      video.currentTime = target;
      const delta = Math.round(target - startTime);
      showHint(`${delta >= 0 ? "快进" : "快退"} ${Math.abs(delta)}s · ${formatTime(target)}`);
    } else if (mode === 'volume') {
      const volume = clamp(startVolume - dy / rect.height, 0, 1);
      video.volume = volume;
      if (volume > 0) video.muted = false;
      // iOS Safari 禁止网页改音量：写后读回无变化则如实提示，不显示假进度
      if (Math.abs(video.volume - volume) > 0.01 && Math.abs(startVolume - volume) > 0.01) {
        showHint('请用音量键调节音量');
      } else {
        showHint(`音量 ${Math.round(volume * 100)}%`);
      }
    } else {
      currentBrightness = clamp(
        startBrightness - (dy / rect.height) * (BRIGHTNESS_MAX - BRIGHTNESS_MIN),
        BRIGHTNESS_MIN,
        BRIGHTNESS_MAX,
      );
      applyBrightness(video, currentBrightness);
      showHint(`亮度 ${Math.round(currentBrightness * 100)}%`);
    }
  };

  const onTouchEnd = () => {
    clearLongPressTimer();
    const video = art.video;
    if (isLongPress) {
      if (video) video.playbackRate = originalRate;
      isLongPress = false;
      showHint(`${originalRate} 倍速`);
    } else if (mode === 'brightness') {
      saveBrightness(currentBrightness);
    }
    mode = null;
  };

  container.addEventListener('touchstart', onTouchStart, { passive: false });
  container.addEventListener('touchend', onTouchEnd);
  container.addEventListener('touchcancel', onTouchEnd);
  container.addEventListener('touchmove', onTouchMove, { passive: false });

  return () => {
    clearLongPressTimer();
    container.removeEventListener('touchstart', onTouchStart);
    container.removeEventListener('touchend', onTouchEnd);
    container.removeEventListener('touchcancel', onTouchEnd);
    container.removeEventListener('touchmove', onTouchMove);
  };
}
