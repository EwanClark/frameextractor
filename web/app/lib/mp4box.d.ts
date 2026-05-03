// Minimal ambient types for the parts of mp4box.js we use.
// The real module has many more exports — we stick to the frame-extraction flow.
declare module "mp4box" {
  export interface MP4Sample {
    number: number;
    track_id: number;
    timescale: number;
    description_index: number;
    description: unknown;
    data: Uint8Array;
    size: number;
    duration: number;
    cts: number;
    dts: number;
    is_sync: boolean;
    is_leading: number;
    depends_on: number;
    is_depended_on: number;
    has_redundancy: number;
    offset?: number;
  }

  export interface MP4VideoTrackInfo {
    id: number;
    codec: string;
    created: Date;
    duration: number;
    language: string;
    nb_samples: number;
    timescale: number;
    track_width: number;
    track_height: number;
    movie_duration: number;
    movie_timescale: number;
    matrix?: number[];
    video?: {
      width: number;
      height: number;
    };
  }

  export interface MP4Info {
    duration: number;
    timescale: number;
    fragment_duration?: number;
    isFragmented: boolean;
    isProgressive: boolean;
    hasIOD: boolean;
    brands: string[];
    created: Date;
    modified: Date;
    tracks: MP4VideoTrackInfo[];
    videoTracks: MP4VideoTrackInfo[];
    audioTracks: MP4VideoTrackInfo[];
  }

  export interface MP4Box {
    // Extraction configuration
    setExtractionOptions(
      trackId: number,
      user?: unknown,
      options?: { nbSamples?: number; rapAlignement?: boolean },
    ): void;
    onReady?: (info: MP4Info) => void;
    onError?: (e: string) => void;
    onSamples?: (id: number, user: unknown, samples: MP4Sample[]) => void;

    // Parser IO
    appendBuffer(buffer: ArrayBuffer & { fileStart: number }): number;
    start(): void;
    stop(): void;
    flush(): void;
    seek(
      time: number,
      useRap?: boolean,
    ): { offset: number; time: number };
    releaseUsedSamples(trackId: number, sampleNumber: number): void;

    // Track description (AVC/HEVC config box bytes)
    getTrackById(trackId: number): unknown;
  }

  export function createFile(): MP4Box;
}
