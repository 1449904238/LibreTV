"use client";

import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { createHlsLoader } from "@/lib/hls-loader";

interface MobileNativeVideoProps {
  url: string;
  title?: string;
  /** true = 直播（小缓冲 + /api/live/stream 代理），false = 点播（/api/proxy 代理 + 广告过滤 + 进度恢复） */
  live?: boolean;
  adFilter?: boolean;
  getRestorePosition?: () => number | Promise<number>;
  onTimeUpdate?: (position: number, duration: number) => void;
  onEnded?: () => void;
  onPause?: (position: number, duration: number) => void;
  onRequestSwitchSource?: (reason: string) => void;
}

const NATIVE_MEDIA_RE = /\.(mp4|m4v|webm|ogv|ogg|mov)(\?|$)/i;
const FLV_RE = /\.flv(\?|$)/i;
const VOD_PROXY_BASE = "/api/proxy?url=";
const LIVE_PROXY_BASE = "/api/live/stream?url=";
const LIVE_PROXY_PREFIX = "/api/live/stream";

/**
 * 手机端原生播放器：只用 `<video id="v" controls playsinline>`，不加载 ArtPlayer。
 * - Safari（iOS）原生支持 HLS：直接 src；
 * - Android Chrome 等：hls.js 挂到同一个原生 <video> 上（UI 仍是浏览器原生 controls）；
 * - 直播 flv：mpegts.js 挂到同一个原生 <video> 上；
 * - 直连致命失败时各走一次同源代理重试（点播 /api/proxy，直播 /api/live/stream）。
 */
export function MobileNativeVideo({
  url,
  title,
  live = false,
  adFilter = false,
  getRestorePosition,
  onTimeUpdate,
  onEnded,
  onPause,
  onRequestSwitchSource,
}: MobileNativeVideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState("");
  const [showPoster, setShowPoster] = useState(true);
  const cbs = useRef({ getRestorePosition, onTimeUpdate, onEnded, onPause, onRequestSwitchSource });
  cbs.current = { getRestorePosition, onTimeUpdate, onEnded, onPause, onRequestSwitchSource };

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !url) return;
    setError("");
    setShowPoster(true);

    let hls: Hls | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let flvPlayer: any = null;
    let disposed = false;
    let lastSave = 0;
    let restored = false;
    const proxyBase = live ? LIVE_PROXY_BASE : VOD_PROXY_BASE;

    const isProxyUrl = (u: string) =>
      live ? u.startsWith(LIVE_PROXY_PREFIX) : u.startsWith("/api/proxy");

    // 微信/QQ 内核 inline 播放兼容
    try {
      video.setAttribute("playsinline", "");
      video.setAttribute("webkit-playsinline", "");
      video.setAttribute("x5-playsinline", "");
    } catch { /* 忽略 */ }

    const tryPlay = () => {
      video.play().catch(() => { /* 等待用户手势 */ });
    };

    const restorePosition = async () => {
      if (restored || live) return;
      restored = true;
      try {
        const saved = (await cbs.current.getRestorePosition?.()) ?? 0;
        const duration = video.duration || 0;
        if (saved > 10 && duration > 0 && saved < duration - 2) {
          video.currentTime = saved;
        }
      } catch { /* 忽略 */ }
    };

    const fail = (message: string, switchReason?: string) => {
      if (disposed) return;
      if (switchReason && cbs.current.onRequestSwitchSource) {
        cbs.current.onRequestSwitchSource(switchReason);
        return;
      }
      setError(message);
    };

    /** 原生直链（含 Safari 原生 HLS）：失败时走一次代理重试 */
    const playNativeDirect = (mediaUrl: string, allowProxyFallback: boolean, failMessage?: string) => {
      const onDirectError = () => {
        video.removeEventListener("error", onDirectError);
        if (disposed) return;
        if (allowProxyFallback && !isProxyUrl(mediaUrl)) {
          playNativeDirect(proxyBase + encodeURIComponent(url), false, failMessage);
          return;
        }
        fail(failMessage || "视频加载失败，请尝试其他资源", "原生播放失败");
      };
      video.addEventListener("error", onDirectError);
      video.src = mediaUrl;
      video.load();
      tryPlay();
    };

    /** hls.js 挂到原生 <video>：UI 仍是浏览器原生 controls */
    const playHls = (mediaUrl: string, allowProxyFallback: boolean) => {
      try {
        hls?.destroy();
      } catch { /* 忽略 */ }
      hls = null;

      // Safari 原生支持 HLS 就不用 hls.js（iOS 只能原生播 HLS）
      try {
        if (video.canPlayType("application/vnd.apple.mpegurl")) {
          playNativeDirect(mediaUrl, allowProxyFallback, "直播流加载失败，请尝试其他频道");
          return;
        }
      } catch { /* canPlayType 不可用则走 hls.js */ }

      if (!Hls.isSupported()) {
        playNativeDirect(mediaUrl, allowProxyFallback);
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const hlsConfig: any = live
        ? {
            debug: false,
            enableWorker: true,
            liveSyncDurationCount: 3,
            backBufferLength: 30,
            maxBufferLength: 20,
            maxMaxBufferLength: 40,
            manifestLoadingMaxRetry: 2,
            manifestLoadingRetryDelay: 1000,
            fragLoadingMaxRetry: 4,
            fragLoadingRetryDelay: 800,
          }
        : {
            debug: false,
            enableWorker: true,
            backBufferLength: 90,
            maxBufferLength: 30,
            maxMaxBufferLength: 60,
            maxBufferHole: 0.5,
            fragLoadingMaxRetry: 6,
            fragLoadingRetryDelay: 1000,
            manifestLoadingMaxRetry: 3,
            manifestLoadingRetryDelay: 1000,
            startLevel: -1,
            loader: createHlsLoader(Hls, { blockAd: adFilter }) as unknown as Hls["config"]["loader"],
          };

      const inst = new Hls(hlsConfig);
      hls = inst;
      inst.loadSource(mediaUrl);
      inst.attachMedia(video);
      inst.on(Hls.Events.MANIFEST_PARSED, () => {
        if (!disposed) tryPlay();
      });
      inst.on(Hls.Events.ERROR, (_evt, data) => {
        if (disposed || !data.fatal) return;
        const isNetErr =
          data.type === Hls.ErrorTypes.NETWORK_ERROR || data.details === "manifestLoadError";
        if (allowProxyFallback && !isProxyUrl(mediaUrl) && isNetErr) {
          playHls(proxyBase + encodeURIComponent(url), false);
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          try {
            inst.recoverMediaError();
            return;
          } catch { /* 继续走失败 */ }
        }
        // 无后缀但内容是 MP4 的源：HLS 解析失败时回退一次原生播放
        if (!NATIVE_MEDIA_RE.test(url) && !isProxyUrl(mediaUrl)) {
          playNativeDirect(url, true, live ? "直播流加载失败，请尝试其他频道" : "视频加载失败，请尝试其他视频源");
          return;
        }
        fail(
          live ? "直播流加载失败，请尝试其他频道" : "视频加载失败，请尝试其他视频源",
          `移动端播放失败(${data.details || data.type})`
        );
      });
    };

    /** 直播 flv：mpegts.js 挂到同一个原生 <video id="v"> 上 */
    const playFlv = async (mediaUrl: string, allowProxyFallback: boolean) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let Mpegts: any;
      try {
        Mpegts = (await import("mpegts.js")).default;
      } catch {
        fail("FLV 播放模块加载失败，请检查网络后重试");
        return;
      }
      if (disposed) return;
      if (!Mpegts.getFeatureList().mseLivePlayback) {
        fail("当前浏览器不支持 FLV 直播播放");
        return;
      }
      try {
        flvPlayer?.destroy();
      } catch { /* 忽略 */ }
      const player = Mpegts.createPlayer(
        { type: "flv", isLive: true, url: mediaUrl },
        { enableWorker: false, enableStashBuffer: false, stashInitialSize: 128, liveBufferLatencyChasing: true, lazyLoad: false }
      );
      flvPlayer = player;
      player.attachMediaElement(video);
      player.load();
      player.on(Mpegts.Events.ERROR, () => {
        if (disposed) return;
        if (allowProxyFallback && !isProxyUrl(mediaUrl)) {
          void playFlv(proxyBase + encodeURIComponent(url), false);
          return;
        }
        fail("直播流加载失败，请尝试其他频道", "FLV播放失败");
      });
      player.play().catch(() => {});
    };

    // —— 引擎分发 ——
    if (live && FLV_RE.test(url)) {
      void playFlv(url, true);
    } else if (NATIVE_MEDIA_RE.test(url)) {
      playNativeDirect(url, true);
    } else {
      playHls(url, true);
    }

    const onLoadedMetadata = () => {
      void restorePosition();
    };
    const onPlaying = () => {
      setShowPoster(false);
      setError("");
    };
    const onTimeUpdateEvt = () => {
      const now = Date.now();
      if (now - lastSave > 5000) {
        lastSave = now;
        try {
          cbs.current.onTimeUpdate?.(video.currentTime, video.duration || 0);
        } catch { /* 忽略 */ }
      }
    };
    const onPauseEvt = () => {
      try {
        cbs.current.onPause?.(video.currentTime, video.duration || 0);
      } catch { /* 忽略 */ }
    };
    const onEndedEvt = () => {
      try {
        cbs.current.onEnded?.();
      } catch { /* 忽略 */ }
    };
    const saveOnHide = () => {
      if (document.visibilityState === "hidden") {
        try {
          cbs.current.onPause?.(video.currentTime, video.duration || 0);
        } catch { /* 忽略 */ }
      }
    };

    video.addEventListener("loadedmetadata", onLoadedMetadata);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("timeupdate", onTimeUpdateEvt);
    video.addEventListener("pause", onPauseEvt);
    video.addEventListener("ended", onEndedEvt);
    document.addEventListener("visibilitychange", saveOnHide);

    return () => {
      disposed = true;
      try {
        cbs.current.onPause?.(video.currentTime, video.duration || 0);
      } catch { /* 忽略 */ }
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("timeupdate", onTimeUpdateEvt);
      video.removeEventListener("pause", onPauseEvt);
      video.removeEventListener("ended", onEndedEvt);
      document.removeEventListener("visibilitychange", saveOnHide);
      try {
        hls?.destroy();
      } catch { /* 忽略 */ }
      try {
        flvPlayer?.pause();
      } catch { /* 忽略 */ }
      try {
        flvPlayer?.destroy();
      } catch { /* 忽略 */ }
      try {
        video.removeAttribute("src");
        video.load();
      } catch { /* 忽略 */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  return (
    <div className="relative w-full h-full bg-black">
      {/* 手机端：原生 video 标签直接播放 */}
      <video
        id="v"
        ref={videoRef}
        controls
        playsInline
        preload="auto"
        crossOrigin="anonymous"
        title={title}
        className="w-full h-full bg-black"
      />
      {showPoster && !error && (
        <div
          className="absolute inset-0 bg-black pointer-events-none"
          style={{
            backgroundImage: "url(/player-poster.png)",
            backgroundSize: "contain",
            backgroundPosition: "center",
            backgroundRepeat: "no-repeat",
          }}
        />
      )}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/80">
          <p className="text-danger text-sm px-4 text-center">{error}</p>
          <button className="btn-ghost text-xs" onClick={() => location.reload()}>
            重新加载
          </button>
        </div>
      )}
    </div>
  );
}
