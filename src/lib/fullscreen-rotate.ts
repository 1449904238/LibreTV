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
