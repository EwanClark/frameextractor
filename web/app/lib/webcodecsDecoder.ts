// Alternate decode path that bypasses the <video> element entirely.
//
// We demux the MP4 with mp4box.js and feed encoded samples into a WebCodecs
// VideoDecoder. This is the fallback we use when the <video> element:
//   - fails outright (codec not supported by the <video> pipeline), or
//   - renders black frames due to a GPU driver / hardware-decode bug.
//
// Because we decode the bitstream ourselves and draw via drawImage on a
// canvas, we dodge the code paths that cause intermittent black frames in
// Chromium (crbug 40739089, 40473787).

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as MP4BoxNS from "mp4box";

type MP4BoxModule = typeof MP4BoxNS & { DataStream?: unknown };
const MP4 = MP4BoxNS as unknown as MP4BoxModule;

type Sample = {
  cts: number;
  duration: number;
  timescale: number;
  is_sync: boolean;
  data: Uint8Array;
};

export interface DecoderTrackInfo {
  width: number;
  height: number;
  codec: string;
  fps: number;
  duration: number;
  nbSamples: number;
  matrix?: number[];
}

const SUPPORTED_CODEC_PREFIXES = [
  "avc1",
  "avc3",
  "hvc1",
  "hev1",
  "vp09",
  "vp08",
  "av01",
];

export async function isWebCodecsSupported(codecString: string): Promise<boolean> {
  if (typeof VideoDecoder === "undefined") return false;
  try {
    const res = await VideoDecoder.isConfigSupported({ codec: codecString });
    return !!res.supported;
  } catch {
    return false;
  }
}

function getDescription(trak: any): Uint8Array | undefined {
  const entry = trak?.mdia?.minf?.stbl?.stsd?.entries?.[0];
  if (!entry) return undefined;
  const box = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C;
  if (!box || typeof box.write !== "function") return undefined;
  const DataStream = (MP4 as any).DataStream;
  if (!DataStream) return undefined;
  const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
  box.write(stream);
  const raw = new Uint8Array(stream.buffer);
  // Strip 8-byte box header (size + type) to get codec-specific config.
  return raw.slice(8);
}

/** Stream the file into mp4box in chunks. Resolves once `onReady` fires. */
async function loadFile(
  file: File,
): Promise<{ mp4: any; info: any }> {
  const mp4 = (MP4 as any).createFile();
  const ready = new Promise<{ mp4: any; info: any }>((resolve, reject) => {
    mp4.onReady = (info: any) => resolve({ mp4, info });
    mp4.onError = (msg: string) =>
      reject(new Error(msg || "mp4box failed to parse the file."));
  });

  const reader = file.stream().getReader();
  const chunkSize = 4 * 1024 * 1024;
  let offset = 0;

  (async () => {
    try {
      let carry = new Uint8Array(0);
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          if (carry.length > 0) {
            const slice = carry.slice();
            const ab = slice.buffer as ArrayBuffer & { fileStart: number };
            ab.fileStart = offset;
            mp4.appendBuffer(ab);
            offset += slice.length;
          }
          mp4.flush();
          break;
        }
        const merged = new Uint8Array(carry.length + value.length);
        merged.set(carry, 0);
        merged.set(value, carry.length);
        carry = merged;

        while (carry.length >= chunkSize) {
          const slice = carry.slice(0, chunkSize);
          carry = carry.slice(chunkSize);
          const ab = slice.buffer as ArrayBuffer & { fileStart: number };
          ab.fileStart = offset;
          mp4.appendBuffer(ab);
          offset += chunkSize;
        }
      }
    } catch (err) {
      try {
        mp4.onError?.((err as Error).message);
      } catch {}
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }
  })();

  return ready;
}

export class WebCodecsFrameExtractor {
  private file: File;
  private mp4: any;
  private trackId = 0;
  private description?: Uint8Array;
  private codecString = "";
  private samples: Sample[] = [];
  private samplesComplete = false;
  private waiters: Array<() => void> = [];
  trackInfo?: DecoderTrackInfo;

  constructor(file: File) {
    this.file = file;
  }

  async init(): Promise<DecoderTrackInfo> {
    const { mp4, info } = await loadFile(this.file);
    const videoTrack = info.videoTracks?.[0];
    if (!videoTrack) throw new Error("No video track found in the file.");
    if (!SUPPORTED_CODEC_PREFIXES.some((p) => videoTrack.codec.startsWith(p))) {
      throw new Error(
        `Codec ${videoTrack.codec} isn't usable by WebCodecs in this browser.`,
      );
    }
    if (!(await isWebCodecsSupported(videoTrack.codec))) {
      throw new Error(
        `WebCodecs reports no decoder for ${videoTrack.codec} in this browser.`,
      );
    }

    this.mp4 = mp4;
    this.trackId = videoTrack.id;
    this.codecString = videoTrack.codec;
    const trak = mp4.getTrackById(this.trackId);
    this.description = getDescription(trak);
    if (!this.description) {
      throw new Error(
        "Couldn't read the codec description from the file — it may be damaged.",
      );
    }

    mp4.onSamples = (id: number, _user: unknown, batch: Sample[]) => {
      if (id !== this.trackId) return;
      for (const s of batch) this.samples.push(s);
      this.wakeWaiters();
    };
    mp4.setExtractionOptions(this.trackId, null, { nbSamples: 256 });
    mp4.start();

    // Give mp4box a macrotask to flush samples, then mark complete.
    setTimeout(() => {
      this.samplesComplete = true;
      this.wakeWaiters();
    }, 0);

    const duration = videoTrack.duration / videoTrack.timescale;
    const fps = videoTrack.nb_samples / Math.max(duration, 1e-6);

    this.trackInfo = {
      width: videoTrack.track_width || videoTrack.video?.width || 0,
      height: videoTrack.track_height || videoTrack.video?.height || 0,
      codec: videoTrack.codec,
      fps,
      duration,
      nbSamples: videoTrack.nb_samples,
      matrix: videoTrack.matrix,
    };
    return this.trackInfo;
  }

  private wakeWaiters() {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }

  private async waitForSample(index: number): Promise<void> {
    while (this.samples.length <= index && !this.samplesComplete) {
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }

  get totalFrames(): number {
    return this.trackInfo?.nbSamples ?? 0;
  }

  /** Decode the frame at `targetIndex`. Always decodes from the nearest
   *  preceding keyframe so inter-frames have their references. */
  async decodeFrame(targetIndex: number): Promise<ImageBitmap> {
    if (!this.description) throw new Error("Decoder not initialised.");
    await this.waitForSample(targetIndex);

    let startIndex = targetIndex;
    while (startIndex > 0 && !this.samples[startIndex]?.is_sync) {
      startIndex--;
    }

    const target = this.samples[targetIndex];
    if (!target) throw new Error(`Frame ${targetIndex} is out of range.`);
    const targetTs = (target.cts * 1e6) / target.timescale;

    let resolveBmp: (b: ImageBitmap) => void;
    let rejectBmp: (e: Error) => void;
    const done = new Promise<ImageBitmap>((res, rej) => {
      resolveBmp = res;
      rejectBmp = rej;
    });

    let captured = false;
    const decoder = new VideoDecoder({
      output: (frame) => {
        if (captured) {
          frame.close();
          return;
        }
        if (frame.timestamp >= targetTs - 1) {
          captured = true;
          createImageBitmap(frame).then(
            (b) => {
              frame.close();
              resolveBmp(b);
            },
            (e) => {
              frame.close();
              rejectBmp(e as Error);
            },
          );
        } else {
          frame.close();
        }
      },
      error: (e) => {
        if (!captured) rejectBmp(e);
      },
    });

    decoder.configure({
      codec: this.codecString,
      codedWidth: this.trackInfo?.width,
      codedHeight: this.trackInfo?.height,
      description: this.description,
      hardwareAcceleration: "prefer-software",
    });

    for (let i = startIndex; i <= targetIndex; i++) {
      const s = this.samples[i];
      if (!s) continue;
      decoder.decode(
        new EncodedVideoChunk({
          type: s.is_sync ? "key" : "delta",
          timestamp: (s.cts * 1e6) / s.timescale,
          duration: (s.duration * 1e6) / s.timescale,
          data: s.data,
        }),
      );
    }
    await decoder.flush();
    try {
      decoder.close();
    } catch {}
    return done;
  }

  dispose() {
    try {
      this.mp4?.stop?.();
    } catch {}
  }
}
