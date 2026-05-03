"use client";

import {
  type ChangeEvent,
  type DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  browserCanPlay,
  describeCodec,
  sniffMp4,
  type CodecFourCC,
} from "./lib/sniffMp4";
import { detectBlackFrame } from "./lib/detectBlackFrame";
import {
  isWebCodecsSupported,
  WebCodecsFrameExtractor,
} from "./lib/webcodecsDecoder";

// ---------------------------------------------------------------------------
// Types / tiny helpers
// ---------------------------------------------------------------------------

type VideoFrameMetadata = {
  presentationTime: number;
  expectedDisplayTime: number;
  width: number;
  height: number;
  mediaTime: number;
  presentedFrames: number;
  processingDuration?: number;
};

type RVFCHandle = number;

type HTMLVideoElementWithRVFC = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    cb: (now: number, metadata: VideoFrameMetadata) => void,
  ) => RVFCHandle;
  cancelVideoFrameCallback?: (handle: RVFCHandle) => void;
};

type Mode = "video" | "webcodecs";

type LoadState =
  | { kind: "idle" }
  | { kind: "analyzing"; filename: string }
  | { kind: "loading-video"; filename: string }
  | { kind: "loading-webcodecs"; filename: string; reason: string }
  | { kind: "ready"; mode: Mode; filename: string }
  | {
      kind: "error";
      filename: string;
      message: string;
      hint?: string;
      codec?: CodecFourCC;
    };

const DEFAULT_FPS = 30;

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00.000";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds - Math.floor(seconds)) * 1000);
  return `${m}:${s.toString().padStart(2, "0")}.${ms
    .toString()
    .padStart(3, "0")}`;
}

function stripExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

function mediaErrorMessage(err: MediaError | null): string {
  if (!err) return "The browser couldn't decode this video.";
  switch (err.code) {
    case 1:
      return "Loading was aborted.";
    case 2:
      return "A network error interrupted loading.";
    case 3:
      return "The browser couldn't decode this video.";
    case 4:
      return "This video format isn't supported by the browser.";
    default:
      return err.message || "Unknown video error.";
  }
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function FrameExtractor() {
  // DOM refs
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const rvfcHandleRef = useRef<RVFCHandle | null>(null);
  const blackCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // WebCodecs decoder (lazy)
  const webCodecsRef = useRef<WebCodecsFrameExtractor | null>(null);
  const currentBitmapRef = useRef<ImageBitmap | null>(null);
  const pendingSeekRef = useRef<number | null>(null);

  // State
  const [file, setFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<LoadState>({ kind: "idle" });
  const [mode, setMode] = useState<Mode>("video");
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [fps, setFps] = useState(DEFAULT_FPS);
  const [fpsDetected, setFpsDetected] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [videoSize, setVideoSize] = useState({ w: 0, h: 0 });
  const [isDragOver, setIsDragOver] = useState(false);
  const [isExtracting, setIsExtracting] = useState(false);
  const [detectedCodec, setDetectedCodec] = useState<CodecFourCC>("unknown");
  const [webCodecsTotalFrames, setWebCodecsTotalFrames] = useState(0);

  const totalFrames = useMemo(() => {
    if (mode === "webcodecs") return webCodecsTotalFrames;
    if (!duration || !fps) return 0;
    return Math.max(1, Math.round(duration * fps));
  }, [duration, fps, mode, webCodecsTotalFrames]);

  const currentFrame = useMemo(() => {
    if (!fps) return 0;
    return Math.round(currentTime * fps);
  }, [currentTime, fps]);

  // --------------------------------------------------------------------- //
  // Cleanup                                                               //
  // --------------------------------------------------------------------- //

  const clearBlackCheck = useCallback(() => {
    if (blackCheckTimerRef.current) {
      clearTimeout(blackCheckTimerRef.current);
      blackCheckTimerRef.current = null;
    }
  }, []);

  const revokeObjectUrl = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  const disposeWebCodecs = useCallback(() => {
    webCodecsRef.current?.dispose();
    webCodecsRef.current = null;
    if (currentBitmapRef.current) {
      currentBitmapRef.current.close();
      currentBitmapRef.current = null;
    }
  }, []);

  const resetAll = useCallback(() => {
    clearBlackCheck();
    revokeObjectUrl();
    disposeWebCodecs();
    setFile(null);
    setVideoUrl(null);
    setLoadState({ kind: "idle" });
    setMode("video");
    setCurrentTime(0);
    setDuration(0);
    setFps(DEFAULT_FPS);
    setFpsDetected(false);
    setIsPlaying(false);
    setVideoSize({ w: 0, h: 0 });
    setDetectedCodec("unknown");
    setWebCodecsTotalFrames(0);
  }, [clearBlackCheck, disposeWebCodecs, revokeObjectUrl]);

  useEffect(() => {
    return () => {
      clearBlackCheck();
      revokeObjectUrl();
      disposeWebCodecs();
    };
  }, [clearBlackCheck, disposeWebCodecs, revokeObjectUrl]);

  // --------------------------------------------------------------------- //
  // FPS detection via requestVideoFrameCallback                           //
  // --------------------------------------------------------------------- //

  const detectFps = useCallback(() => {
    const video = videoRef.current as HTMLVideoElementWithRVFC | null;
    if (!video || typeof video.requestVideoFrameCallback !== "function") {
      return;
    }
    const samples: number[] = [];
    let lastMediaTime: number | null = null;
    let cancelled = false;

    const step = (_now: number, meta: VideoFrameMetadata) => {
      if (cancelled) return;
      if (lastMediaTime != null) {
        const delta = meta.mediaTime - lastMediaTime;
        if (delta > 0 && delta < 1) samples.push(delta);
      }
      lastMediaTime = meta.mediaTime;
      if (samples.length < 8) {
        rvfcHandleRef.current =
          video.requestVideoFrameCallback?.(step) ?? null;
      } else {
        const sorted = [...samples].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const detected = 1 / median;
        const candidates = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120];
        let best = detected;
        let bestDiff = Infinity;
        for (const c of candidates) {
          const diff = Math.abs(c - detected);
          if (diff < bestDiff && diff / c < 0.02) {
            bestDiff = diff;
            best = c;
          }
        }
        setFps(Number(best.toFixed(3)));
        setFpsDetected(true);
        video.pause();
        video.currentTime = 0;
      }
    };

    video.muted = true;
    video.currentTime = 0;
    video.play().catch(() => {});
    rvfcHandleRef.current = video.requestVideoFrameCallback?.(step) ?? null;

    return () => {
      cancelled = true;
      if (
        rvfcHandleRef.current != null &&
        typeof video.cancelVideoFrameCallback === "function"
      ) {
        video.cancelVideoFrameCallback(rvfcHandleRef.current);
      }
      rvfcHandleRef.current = null;
    };
  }, []);

  // --------------------------------------------------------------------- //
  // WebCodecs fallback                                                    //
  // --------------------------------------------------------------------- //

  const drawBitmapToPreview = useCallback((bmp: ImageBitmap) => {
    const preview = previewRef.current;
    if (!preview) return;
    preview.width = bmp.width;
    preview.height = bmp.height;
    const ctx = preview.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, bmp.width, bmp.height);
    ctx.drawImage(bmp, 0, 0);
  }, []);

  const decodeAtFrameWebCodecs = useCallback(
    async (frameIndex: number) => {
      const dec = webCodecsRef.current;
      if (!dec) return;
      if (pendingSeekRef.current !== null) {
        pendingSeekRef.current = frameIndex;
        return;
      }
      pendingSeekRef.current = frameIndex;
      try {
        while (pendingSeekRef.current !== null) {
          const target: number = pendingSeekRef.current;
          const bmp = await dec.decodeFrame(target);
          currentBitmapRef.current?.close();
          currentBitmapRef.current = bmp;
          drawBitmapToPreview(bmp);
          // If a newer seek came in while we were decoding, loop and service it.
          if (pendingSeekRef.current === target) {
            pendingSeekRef.current = null;
          }
        }
      } catch (err) {
        console.error("WebCodecs decode failed:", err);
        pendingSeekRef.current = null;
      }
    },
    [drawBitmapToPreview],
  );

  const switchToWebCodecs = useCallback(
    async (reason: string, startFrame = 0) => {
      if (!file) return;
      const codecDescription = describeCodec(detectedCodec);
      setLoadState({
        kind: "loading-webcodecs",
        filename: file.name,
        reason,
      });
      setMode("webcodecs");
      // Tear down the <video> pipeline so the GPU decoder isn't fighting us.
      revokeObjectUrl();
      setVideoUrl(null);
      setIsPlaying(false);

      try {
        const dec = new WebCodecsFrameExtractor(file);
        const info = await dec.init();
        webCodecsRef.current = dec;
        setWebCodecsTotalFrames(dec.totalFrames);
        setVideoSize({ w: info.width, h: info.height });
        setDuration(info.duration);
        if (info.fps && isFinite(info.fps) && info.fps > 0) {
          setFps(Number(info.fps.toFixed(3)));
          setFpsDetected(true);
        }
        await decodeAtFrameWebCodecs(startFrame);
        setCurrentTime(info.fps > 0 ? startFrame / info.fps : 0);
        setLoadState({ kind: "ready", mode: "webcodecs", filename: file.name });
      } catch (err) {
        const message = (err as Error).message || String(err);
        setLoadState({
          kind: "error",
          filename: file.name,
          message: "This file can't be decoded in your browser.",
          hint:
            codecDescription !== "unknown"
              ? `The file is ${codecDescription}. ${message}. ` +
                "Try converting it to H.264 MP4 first."
              : `${message}. Try converting it to H.264 MP4 first.`,
          codec: detectedCodec,
        });
      }
    },
    [decodeAtFrameWebCodecs, detectedCodec, file, revokeObjectUrl],
  );

  // --------------------------------------------------------------------- //
  // File loading                                                          //
  // --------------------------------------------------------------------- //

  const loadFile = useCallback(
    async (f: File) => {
      resetAll();
      setFile(f);
      setLoadState({ kind: "analyzing", filename: f.name });

      // 1. Sniff the container to see what we're dealing with.
      let codec: CodecFourCC = "unknown";
      let canPlayNative = true;
      try {
        const sniff = await sniffMp4(f);
        codec = sniff.codec;
        setDetectedCodec(codec);
        if (sniff.isIsoBmff && codec !== "unknown") {
          canPlayNative = browserCanPlay(codec);
        }
      } catch {
        // Non-fatal: fall back to <video> and see what happens.
      }

      // 2. If the codec is known-unplayable by <video>, jump straight to
      //    the WebCodecs path (or show a clear error if WebCodecs can't help).
      if (codec !== "unknown" && !canPlayNative) {
        const codecDesc = describeCodec(codec);
        // Check if WebCodecs can handle it at all, so we don't falsely
        // promise anything.
        const configProbe = await tryCanDecode(codec);
        if (!configProbe) {
          setLoadState({
            kind: "error",
            filename: f.name,
            message: `Your browser can't decode ${codecDesc} video.`,
            hint:
              codec === "hev1" || codec === "hvc1"
                ? "HEVC / H.265 isn't supported on this system. The easiest fix is to convert the file to H.264 MP4 first (QuickTime, HandBrake, or `ffmpeg -c:v libx264`)."
                : `Try converting the file to H.264 MP4 first.`,
            codec,
          });
          return;
        }
        // WebCodecs probably can — route straight there.
        await switchToWebCodecs(
          `${codecDesc} isn't supported by the standard video player in this browser — using WebCodecs instead.`,
          0,
        );
        return;
      }

      // 3. Primary path: load into <video>.
      setLoadState({ kind: "loading-video", filename: f.name });
      const url = URL.createObjectURL(f);
      objectUrlRef.current = url;
      setVideoUrl(url);
      setMode("video");
      setIsPlaying(false);
      setFps(DEFAULT_FPS);
      setFpsDetected(false);
    },
    [resetAll, switchToWebCodecs],
  );

  // --------------------------------------------------------------------- //
  // <video> event handlers                                                //
  // --------------------------------------------------------------------- //

  const scheduleBlackCheck = useCallback(() => {
    clearBlackCheck();
    blackCheckTimerRef.current = setTimeout(() => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas) return;
      if (video.videoWidth === 0 || video.videoHeight === 0) return;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      try {
        ctx.drawImage(video, 0, 0);
      } catch {
        return;
      }
      const check = detectBlackFrame(canvas);
      if (check.isBlack && file) {
        // The <video> accepted the file but is rendering black — almost
        // certainly a hardware-decode failure or unsupported profile.
        // Fall back to WebCodecs.
        switchToWebCodecs(
          "The native player is rendering black frames (likely a hardware-decode issue). Switching to a software decoder.",
          currentFrame,
        );
      }
    }, 700);
  }, [clearBlackCheck, currentFrame, file, switchToWebCodecs]);

  const onLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video || !file) return;

    if (video.videoWidth === 0 || video.videoHeight === 0) {
      // Metadata arrived but no video track was decoded. Try WebCodecs.
      switchToWebCodecs(
        "The native player couldn't decode this video. Switching to a software decoder.",
        0,
      );
      return;
    }

    setDuration(video.duration || 0);
    setVideoSize({ w: video.videoWidth, h: video.videoHeight });
    setCurrentTime(0);
    detectFps();
    setLoadState({ kind: "ready", mode: "video", filename: file.name });

    // After a brief delay (to let the first frame actually render), sample
    // the canvas to check if we got actual pixels.
    scheduleBlackCheck();
  }, [detectFps, file, scheduleBlackCheck, switchToWebCodecs]);

  const onTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    setCurrentTime(video.currentTime);
  }, []);

  const onSeeked = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    setCurrentTime(video.currentTime);
    scheduleBlackCheck();
  }, [scheduleBlackCheck]);

  const onPlay = useCallback(() => setIsPlaying(true), []);
  const onPause = useCallback(() => setIsPlaying(false), []);

  const onVideoError = useCallback(() => {
    const video = videoRef.current;
    if (!video || !file) return;
    const err = video.error;
    // Most common case: the browser can't decode this container/codec.
    switchToWebCodecs(
      mediaErrorMessage(err) + " Switching to a software decoder.",
      0,
    );
  }, [file, switchToWebCodecs]);

  // --------------------------------------------------------------------- //
  // Seeking (unified for both modes)                                      //
  // --------------------------------------------------------------------- //

  const seekToFrame = useCallback(
    (frame: number) => {
      const clamped = Math.max(0, Math.min(totalFrames - 1, frame));

      if (mode === "webcodecs") {
        if (!fps) return;
        setCurrentTime(clamped / fps);
        decodeAtFrameWebCodecs(clamped);
        return;
      }

      const video = videoRef.current;
      if (!video || !fps) return;
      const targetTime = Math.min(duration, (clamped + 0.5) / fps);
      if (!video.paused) video.pause();
      video.currentTime = targetTime;
      setCurrentTime(targetTime);
    },
    [decodeAtFrameWebCodecs, duration, fps, mode, totalFrames],
  );

  const stepFrames = useCallback(
    (delta: number) => seekToFrame(currentFrame + delta),
    [currentFrame, seekToFrame],
  );

  const togglePlay = useCallback(() => {
    if (mode === "webcodecs") return; // Playback disabled in WebCodecs mode.
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, [mode]);

  // --------------------------------------------------------------------- //
  // PNG extraction                                                        //
  // --------------------------------------------------------------------- //

  const extractPng = useCallback(async () => {
    if (!file) return;
    setIsExtracting(true);
    try {
      let canvas: HTMLCanvasElement;
      if (mode === "webcodecs") {
        const preview = previewRef.current;
        if (!preview || !currentBitmapRef.current) {
          return;
        }
        canvas = document.createElement("canvas");
        canvas.width = currentBitmapRef.current.width;
        canvas.height = currentBitmapRef.current.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(currentBitmapRef.current, 0, 0);
      } else {
        const video = videoRef.current;
        const work = canvasRef.current;
        if (!video || !work) return;
        video.pause();
        work.width = video.videoWidth;
        work.height = video.videoHeight;
        const ctx = work.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(video, 0, 0);
        canvas = work;
      }

      const blob: Blob | null = await new Promise((resolve) =>
        canvas.toBlob((b) => resolve(b), "image/png"),
      );
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const base = stripExt(file.name);
      const frameLabel = String(currentFrame).padStart(6, "0");
      const timeLabel = currentTime.toFixed(3).replace(".", "_");
      a.href = url;
      a.download = `${base}_frame-${frameLabel}_t-${timeLabel}s.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } finally {
      setIsExtracting(false);
    }
  }, [currentFrame, currentTime, file, mode]);

  // --------------------------------------------------------------------- //
  // File inputs                                                           //
  // --------------------------------------------------------------------- //

  const onFileInput = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (f) loadFile(f);
      e.target.value = "";
    },
    [loadFile],
  );

  const onDrop = useCallback(
    (e: DragEvent<HTMLElement>) => {
      e.preventDefault();
      setIsDragOver(false);
      const f = e.dataTransfer.files?.[0];
      if (f) loadFile(f);
    },
    [loadFile],
  );

  // --------------------------------------------------------------------- //
  // Keyboard shortcuts                                                    //
  // --------------------------------------------------------------------- //

  useEffect(() => {
    if (loadState.kind !== "ready") return;
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.key === " ") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        stepFrames(e.shiftKey ? -10 : -1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        stepFrames(e.shiftKey ? 10 : 1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        extractPng();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [loadState.kind, togglePlay, stepFrames, extractPng]);

  // --------------------------------------------------------------------- //
  // Render                                                                //
  // --------------------------------------------------------------------- //

  const showPlayer = loadState.kind === "ready";
  const showBusy =
    loadState.kind === "analyzing" ||
    loadState.kind === "loading-video" ||
    loadState.kind === "loading-webcodecs";

  return (
    <main className="flex-1 flex flex-col w-full">
      <header className="w-full border-b border-[var(--border)] bg-[var(--surface)]">
        <div className="mx-auto max-w-5xl px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-md bg-[var(--accent)] flex items-center justify-center text-white font-bold">
              F
            </div>
            <div>
              <h1 className="text-lg font-semibold leading-tight">
                Frame Extractor
              </h1>
              <p className="text-xs text-[var(--muted)] leading-tight">
                Upload an MP4, pick the frame you want, save as a full-quality
                PNG.
              </p>
            </div>
          </div>
          {file && (
            <button
              type="button"
              onClick={resetAll}
              className="text-sm text-[var(--muted)] hover:text-[var(--foreground)] transition-colors"
            >
              Change video
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 w-full mx-auto max-w-5xl px-6 py-8">
        {loadState.kind === "idle" ? (
          <Dropzone
            isDragOver={isDragOver}
            setIsDragOver={setIsDragOver}
            onDrop={onDrop}
            onFileInput={onFileInput}
          />
        ) : loadState.kind === "error" ? (
          <ErrorPane
            filename={loadState.filename}
            message={loadState.message}
            hint={loadState.hint}
            onReset={resetAll}
          />
        ) : (
          <div className="flex flex-col gap-6">
            <div className="rounded-lg overflow-hidden bg-black border border-[var(--border)] relative">
              {mode === "video" && videoUrl && (
                <video
                  ref={videoRef}
                  src={videoUrl}
                  onLoadedMetadata={onLoadedMetadata}
                  onTimeUpdate={onTimeUpdate}
                  onSeeked={onSeeked}
                  onPlay={onPlay}
                  onPause={onPause}
                  onError={onVideoError}
                  onClick={togglePlay}
                  className="w-full h-auto max-h-[70vh] block mx-auto cursor-pointer"
                  playsInline
                  preload="auto"
                />
              )}
              {mode === "webcodecs" && (
                <canvas
                  ref={previewRef}
                  className="w-full h-auto max-h-[70vh] block mx-auto"
                />
              )}
              {showBusy && (
                <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center">
                  <div className="flex flex-col items-center gap-3 text-white text-sm">
                    <div className="w-6 h-6 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                    <div>
                      {loadState.kind === "analyzing" &&
                        "Inspecting the file…"}
                      {loadState.kind === "loading-video" && "Loading video…"}
                      {loadState.kind === "loading-webcodecs" &&
                        "Setting up the software decoder…"}
                    </div>
                    {loadState.kind === "loading-webcodecs" && (
                      <div className="max-w-md text-xs text-white/70 text-center px-2">
                        {loadState.reason}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {showPlayer && (
              <>
                <div className="flex flex-col gap-2">
                  <input
                    type="range"
                    className="scrubber"
                    min={0}
                    max={Math.max(0, totalFrames - 1)}
                    step={1}
                    value={currentFrame}
                    onChange={(e) => seekToFrame(Number(e.target.value))}
                  />
                  <div className="flex justify-between text-xs text-[var(--muted)] font-mono">
                    <span>{formatTime(currentTime)}</span>
                    <span>{formatTime(duration)}</span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="flex items-center gap-2">
                    <IconButton
                      label="Previous frame (←)"
                      onClick={() => stepFrames(-1)}
                    >
                      <ChevronLeft />
                    </IconButton>
                    {mode === "video" && (
                      <IconButton
                        label={isPlaying ? "Pause (Space)" : "Play (Space)"}
                        onClick={togglePlay}
                      >
                        {isPlaying ? <PauseIcon /> : <PlayIcon />}
                      </IconButton>
                    )}
                    <IconButton
                      label="Next frame (→)"
                      onClick={() => stepFrames(1)}
                    >
                      <ChevronRight />
                    </IconButton>
                    <div className="ml-2 text-sm font-mono text-[var(--muted)] tabular-nums">
                      Frame{" "}
                      <span className="text-[var(--foreground)]">
                        {currentFrame.toLocaleString()}
                      </span>{" "}
                      /{" "}
                      <span>
                        {totalFrames
                          ? (totalFrames - 1).toLocaleString()
                          : "—"}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 text-sm">
                    <label
                      htmlFor="fps"
                      className="text-[var(--muted)]"
                      title={
                        fpsDetected
                          ? "Detected from the video. Adjust if stepping feels off."
                          : "Estimate — adjust if frame stepping feels off."
                      }
                    >
                      FPS
                    </label>
                    <input
                      id="fps"
                      type="number"
                      min={1}
                      max={240}
                      step={0.001}
                      value={fps}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (!Number.isFinite(v) || v <= 0) return;
                        setFps(v);
                      }}
                      className="w-24 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm font-mono focus:outline-none focus:border-[var(--accent)]"
                    />
                    {fpsDetected && (
                      <span className="text-xs text-[var(--muted)]">auto</span>
                    )}
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
                  <div className="text-sm text-[var(--muted)] min-w-0">
                    <div className="text-[var(--foreground)] font-medium truncate">
                      {file?.name ?? ""}
                    </div>
                    <div className="font-mono text-xs mt-0.5 truncate">
                      {videoSize.w}×{videoSize.h} · {formatTime(duration)} ·{" "}
                      {fps.toFixed(fps % 1 === 0 ? 0 : 3)} fps
                      {detectedCodec !== "unknown" && (
                        <>
                          {" "}
                          · {describeCodec(detectedCodec)}
                        </>
                      )}
                      {mode === "webcodecs" && (
                        <>
                          {" "}
                          · <span className="text-[var(--warning)]">software decode</span>
                        </>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={extractPng}
                    disabled={isExtracting}
                    className="inline-flex items-center justify-center gap-2 rounded-md bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-[var(--accent-foreground)] hover:bg-[var(--accent-hover)] disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                  >
                    <DownloadIcon />
                    {isExtracting ? "Extracting…" : "Extract frame as PNG"}
                  </button>
                </div>

                <div className="text-xs text-[var(--muted)] leading-relaxed">
                  <span className="font-semibold text-[var(--foreground)]">
                    Shortcuts:
                  </span>{" "}
                  {mode === "video" && (
                    <>
                      <kbd className="kbd">Space</kbd> play/pause ·{" "}
                    </>
                  )}
                  <kbd className="kbd">←</kbd> <kbd className="kbd">→</kbd>{" "}
                  step 1 frame · <kbd className="kbd">Shift</kbd> + arrow step
                  10 frames · <kbd className="kbd">Enter</kbd> extract PNG
                </div>
              </>
            )}
          </div>
        )}
        <canvas ref={canvasRef} className="hidden" />
      </div>

      <footer className="w-full border-t border-[var(--border)] bg-[var(--surface)] mt-auto">
        <div className="mx-auto max-w-5xl px-6 py-3 text-xs text-[var(--muted)] flex items-center justify-between">
          <span>Runs entirely in your browser. Nothing is uploaded.</span>
          <span className="font-mono">PNG · full quality</span>
        </div>
      </footer>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

async function tryCanDecode(codec: CodecFourCC): Promise<boolean> {
  if (typeof VideoDecoder === "undefined") return false;
  const probes: Partial<Record<CodecFourCC, string[]>> = {
    avc1: ["avc1.42E01E", "avc1.4D401E", "avc1.64001E"],
    hev1: ["hev1.1.6.L93.B0", "hev1.2.4.L120.B0"],
    hvc1: ["hvc1.1.6.L93.B0", "hvc1.2.4.L120.B0"],
    vp09: ["vp09.00.10.08", "vp09.02.10.10"],
    vp08: ["vp08.00.10.08"],
    av01: ["av01.0.04M.08", "av01.0.05M.08"],
  };
  const list = probes[codec] ?? [];
  for (const c of list) {
    try {
      const res = await VideoDecoder.isConfigSupported({ codec: c });
      if (res.supported) return true;
    } catch {}
  }
  return isWebCodecsSupported("avc1.42E01E");
}

function Dropzone({
  isDragOver,
  setIsDragOver,
  onDrop,
  onFileInput,
}: {
  isDragOver: boolean;
  setIsDragOver: (v: boolean) => void;
  onDrop: (e: DragEvent<HTMLElement>) => void;
  onFileInput: (e: ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-10">
      <label
        htmlFor="video-input"
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={onDrop}
        className={[
          "flex flex-col items-center justify-center text-center cursor-pointer",
          "w-full min-h-[320px] rounded-xl border-2 border-dashed",
          "transition-colors",
          isDragOver
            ? "border-[var(--accent)] bg-[var(--accent)]/5"
            : "border-[var(--border)] bg-[var(--surface)] hover:border-[var(--accent)]/60 hover:bg-[var(--accent)]/[0.03]",
        ].join(" ")}
      >
        <div className="w-14 h-14 rounded-full bg-[var(--accent)]/10 flex items-center justify-center mb-4 text-[var(--accent)]">
          <UploadIcon />
        </div>
        <div className="text-lg font-semibold">
          Drop an MP4 here, or click to browse
        </div>
        <div className="mt-1 text-sm text-[var(--muted)] max-w-md">
          Your video never leaves your device. MP4, MOV, M4V, and WebM all
          work. HEVC / H.265 is handled where possible.
        </div>
        <input
          id="video-input"
          type="file"
          accept="video/mp4,video/quicktime,video/webm,video/x-matroska,video/*"
          onChange={onFileInput}
          className="hidden"
        />
      </label>
    </div>
  );
}

function ErrorPane({
  filename,
  message,
  hint,
  onReset,
}: {
  filename: string;
  message: string;
  hint?: string;
  onReset: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="w-14 h-14 rounded-full bg-[var(--danger)]/15 flex items-center justify-center mb-4 text-[var(--danger)]">
        <AlertIcon />
      </div>
      <div className="font-mono text-xs text-[var(--muted)] mb-1">
        {filename}
      </div>
      <div className="text-lg font-semibold max-w-xl">{message}</div>
      {hint && (
        <div className="mt-2 text-sm text-[var(--muted)] max-w-xl leading-relaxed">
          {hint}
        </div>
      )}
      <button
        type="button"
        onClick={onReset}
        className="mt-6 inline-flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-medium hover:border-[var(--accent)] transition-colors"
      >
        Try a different file
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function IconButton({
  children,
  onClick,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="w-10 h-10 flex items-center justify-center rounded-md border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--accent)]/10 hover:border-[var(--accent)]/40 active:scale-95 transition-all text-[var(--foreground)]"
    >
      {children}
    </button>
  );
}

function ChevronLeft() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}
function ChevronRight() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}
function PlayIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
      <polygon points="6 4 20 12 6 20 6 4" />
    </svg>
  );
}
function PauseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
    </svg>
  );
}
function DownloadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}
function UploadIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}
function AlertIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}
