import type Artplayer from 'artplayer';

/**
 * 全屏横屏提醒（iOS 补偿）。
 *
 * Android：autoOrientation 选项 + Screen Orientation API，进全屏自动锁横屏、退出自动解锁；
 * iPhone Safari 没有 screen.orientation.lock，任何网站都无法强制旋转，
 * 只能在“横视频 + 竖屏全屏”时提示用户手动旋转手机。
 */
export function attachFullscreenRotateHint(
  art: Artplayer,
  options: { showHint: (text: string) => void },
): () => void {
  const { showHint } = options;

  const maybeRemind = () => {
    try {
      const inFullscreen = art.fullscreen || art.fullscreenWeb;
      if (!inFullscreen) return;
      // 有锁屏 API 的走系统自动旋转，无需提醒
      const orientation = typeof screen !== 'undefined' ? screen.orientation : undefined;
      const canLock =
        !!orientation && typeof (orientation as { lock?: unknown }).lock === 'function';
      if (canLock) return;
      const video = art.video;
      if (!video || !(video.videoWidth > video.videoHeight)) return;
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      if (vw < vh) showHint('横屏视频，建议旋转手机至横屏观看');
    } catch {
      /* 忽略 */
    }
  };

  const onFullscreen = () => maybeRemind();
  const onFullscreenWeb = () => maybeRemind();
  art.on('fullscreen', onFullscreen);
  art.on('fullscreenWeb', onFullscreenWeb);

  return () => {
    try {
      art.off('fullscreen', onFullscreen);
      art.off('fullscreenWeb', onFullscreenWeb);
    } catch {
      /* 播放器已销毁时忽略 */
    }
  };
}

/** 是否手机/平板等触屏设备（仅这类设备改全屏行为，桌面保持不变） */
export function isMobileDevice(): boolean {
  try {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
    if (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches) return true;
    return /Mobi|Android|iPhone|iPad|iPod|Mobile|HarmonyOS/i.test(navigator.userAgent);
  } catch {
    return false;
  }
}

/**
 * 手机端全屏按钮改为网页全屏（横屏旋转），桌面保持原生全屏不变。
 *
 * 背景：原生 fullscreen 在 iPhone Safari 上没有 screen.orientation.lock，
 * 点全屏按钮竖屏不变；而 fullscreenWeb + autoOrientation 会用 CSS rotate(90deg)
 * 把横视频旋转为横屏（即现在网页全屏已有的效果）。
 * 这里把手机上的原生全屏按钮重定向到 fullscreenWeb，复用同一套旋转逻辑。
 */
export function attachMobileFullscreenLandscape(art: Artplayer): () => void {
  if (!isMobileDevice()) return () => {};
  try {
    art.controls.update({
      name: 'fullscreen',
      click(this: Artplayer) {
        try {
          if (this.fullscreen) this.fullscreen = false;
          this.fullscreenWeb = !this.fullscreenWeb;
        } catch {
          /* 忽略 */
        }
      },
    });
  } catch {
    return () => {};
  }
  return () => {
    try {
      art.controls.update({
        name: 'fullscreen',
        click(this: Artplayer) {
          this.fullscreen = !this.fullscreen;
        },
      });
    } catch {
      /* 播放器已销毁时忽略 */
    }
  };
}