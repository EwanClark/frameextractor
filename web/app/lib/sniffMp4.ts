// Minimal MP4 / ISOBMFF sniffer.
//
// We walk the top-level boxes until we find a video `stsd` (sample description)
// and read its FourCC. That FourCC tells us whether the file is H.264 (avc1),
// HEVC (hev1 / hvc1), VP9 (vp09), AV1 (av01), etc.
//
// The goal isn't to decode — it's to fail fast with a helpful message *before*
// the user waits for Chrome to quietly render a black video.

export type CodecFourCC =
  | "avc1" // H.264
  | "hev1" // HEVC (inband parameter sets)
  | "hvc1" // HEVC (out-of-band parameter sets)
  | "vp09" // VP9
  | "vp08" // VP8
  | "av01" // AV1
  | "mp4v" // MPEG-4 Part 2
  | "unknown";

export interface SniffResult {
  isIsoBmff: boolean;
  codec: CodecFourCC;
  brands: string[];
  hasMovie: boolean;
  sniffedBytes: number;
}

const FTYP = 0x66747970; // "ftyp"
const MOOV = 0x6d6f6f76; // "moov"
const MOOF = 0x6d6f6f66; // "moof"
const TRAK = 0x7472616b; // "trak"
const MDIA = 0x6d646961; // "mdia"
const MINF = 0x6d696e66; // "minf"
const STBL = 0x7374626c; // "stbl"
const STSD = 0x73747364; // "stsd"
const HDLR = 0x68646c72; // "hdlr"

type Reader = {
  view: DataView;
  u8: Uint8Array;
  size: number;
};

function makeReader(buf: ArrayBuffer): Reader {
  return {
    view: new DataView(buf),
    u8: new Uint8Array(buf),
    size: buf.byteLength,
  };
}

function readFourCC(r: Reader, offset: number): string {
  return String.fromCharCode(
    r.u8[offset],
    r.u8[offset + 1],
    r.u8[offset + 2],
    r.u8[offset + 3],
  );
}

function walkBoxes(
  r: Reader,
  start: number,
  end: number,
  visit: (type: number, typeStr: string, start: number, size: number) =>
    | void
    | "stop"
    | "enter",
): boolean {
  let offset = start;
  while (offset + 8 <= end) {
    const size32 = r.view.getUint32(offset);
    const type = r.view.getUint32(offset + 4);
    const typeStr = readFourCC(r, offset + 4);

    let size = size32;
    let headerSize = 8;
    if (size32 === 1) {
      if (offset + 16 > end) return false;
      const hi = r.view.getUint32(offset + 8);
      const lo = r.view.getUint32(offset + 12);
      size = hi * 0x100000000 + lo;
      headerSize = 16;
    } else if (size32 === 0) {
      size = end - offset;
    }

    if (size < headerSize || offset + size > end) {
      return false;
    }

    const action = visit(type, typeStr, offset, size);
    if (action === "stop") return true;
    if (action === "enter") {
      const stop = walkBoxes(r, offset + headerSize, offset + size, visit);
      if (stop) return true;
    }
    offset += size;
  }
  return false;
}

/**
 * Read the first few MB of a File to sniff its MP4 codec.
 * We only need enough bytes to reach the `moov/trak/mdia/minf/stbl/stsd` box.
 * Fast-start files have `moov` near the beginning (< 512 KB typical).
 * For non-fast-start files we progressively read more (up to a cap).
 */
export async function sniffMp4(file: File): Promise<SniffResult> {
  // Try escalating read sizes, since `moov` may be at the end of a non
  // fast-start recording. We cap at 32MB to avoid pulling huge files into
  // memory just to sniff.
  const tries = [256 * 1024, 2 * 1024 * 1024, 8 * 1024 * 1024, 32 * 1024 * 1024];

  let result: SniffResult = {
    isIsoBmff: false,
    codec: "unknown",
    brands: [],
    hasMovie: false,
    sniffedBytes: 0,
  };

  for (const size of tries) {
    const read = Math.min(size, file.size);
    const buf = await file.slice(0, read).arrayBuffer();
    result = parseBuffer(buf);
    result.sniffedBytes = read;
    if (result.codec !== "unknown" && result.hasMovie) break;
    if (read >= file.size) break;
  }

  // If the file has no moov in the first 32MB, try the tail — common for
  // phone recordings / screen captures.
  if (!result.hasMovie && file.size > 0) {
    const tailSize = Math.min(32 * 1024 * 1024, file.size);
    const tailBuf = await file
      .slice(Math.max(0, file.size - tailSize))
      .arrayBuffer();
    const tail = parseBuffer(tailBuf);
    if (tail.codec !== "unknown") {
      result.codec = tail.codec;
      result.hasMovie = tail.hasMovie || result.hasMovie;
    }
    if (tail.brands.length) result.brands = tail.brands;
  }

  return result;
}

function parseBuffer(buf: ArrayBuffer): SniffResult {
  const r = makeReader(buf);
  const result: SniffResult = {
    isIsoBmff: false,
    codec: "unknown",
    brands: [],
    hasMovie: false,
    sniffedBytes: buf.byteLength,
  };

  walkBoxes(r, 0, r.size, (type, typeStr, start, size) => {
    if (type === FTYP) {
      result.isIsoBmff = true;
      const major = readFourCC(r, start + 8);
      const brands: string[] = [major];
      let b = start + 16;
      while (b + 4 <= start + size) {
        brands.push(readFourCC(r, b));
        b += 4;
      }
      result.brands = brands.filter((x) => /^[\w\- ]{4}$/.test(x));
      return;
    }
    if (type === MOOV) {
      result.hasMovie = true;
      return "enter";
    }
    if (type === MOOF) {
      result.hasMovie = true;
      return;
    }
    if (type === TRAK || type === MDIA || type === MINF || type === STBL) {
      return "enter";
    }
    if (type === HDLR) {
      // Confirmed video track marker — not strictly required but useful.
      // handler_type is at offset +8 (version/flags) +4 (pre_defined) = +16
      // relative to the parent box's content start... we're already inside
      // mdia here thanks to "enter".
      void typeStr;
      return;
    }
    if (type === STSD) {
      // stsd: version+flags (4) + entry_count (4) + entries[]
      const entryStart = start + 8 + 8;
      if (entryStart + 8 <= start + size) {
        const entryType = readFourCC(r, entryStart + 4);
        if (
          entryType === "avc1" ||
          entryType === "avc3" ||
          entryType === "hev1" ||
          entryType === "hvc1" ||
          entryType === "vp09" ||
          entryType === "vp08" ||
          entryType === "av01" ||
          entryType === "mp4v"
        ) {
          if (entryType === "avc3") result.codec = "avc1";
          else result.codec = entryType as CodecFourCC;
          return "stop";
        }
      }
      return;
    }
    return;
  });

  return result;
}

export function describeCodec(codec: CodecFourCC): string {
  switch (codec) {
    case "avc1":
      return "H.264";
    case "hev1":
    case "hvc1":
      return "HEVC (H.265)";
    case "vp09":
      return "VP9";
    case "vp08":
      return "VP8";
    case "av01":
      return "AV1";
    case "mp4v":
      return "MPEG-4";
    default:
      return "unknown";
  }
}

export function browserCanPlay(codec: CodecFourCC): boolean {
  if (typeof document === "undefined") return true;
  const video = document.createElement("video");
  const queries: Partial<Record<CodecFourCC, string[]>> = {
    avc1: [
      'video/mp4; codecs="avc1.42E01E"',
      'video/mp4; codecs="avc1.4D401E"',
      'video/mp4; codecs="avc1.64001E"',
    ],
    hev1: [
      'video/mp4; codecs="hev1.1.6.L93.B0"',
      'video/mp4; codecs="hev1.2.4.L120.B0"',
    ],
    hvc1: [
      'video/mp4; codecs="hvc1.1.6.L93.B0"',
      'video/mp4; codecs="hvc1.2.4.L120.B0"',
    ],
    vp09: ['video/mp4; codecs="vp09.00.10.08"', 'video/webm; codecs="vp9"'],
    vp08: ['video/webm; codecs="vp8"'],
    av01: ['video/mp4; codecs="av01.0.04M.08"'],
    mp4v: ['video/mp4; codecs="mp4v.20.9"'],
  };
  const list = queries[codec] ?? [];
  for (const q of list) {
    const ans = video.canPlayType(q);
    if (ans === "probably" || ans === "maybe") return true;
  }
  return false;
}
