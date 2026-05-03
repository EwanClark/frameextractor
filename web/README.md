# Frame Extractor — web

The browser version of the frame extractor. Everything runs client-side: no
uploads, no account, no servers touching your video.

## Stack

- Next.js 16 (App Router, Turbopack)
- React 19
- Tailwind CSS 4
- [`mp4box`](https://github.com/gpac/mp4box.js) + WebCodecs for the fallback decoder

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## How reliability works

When you drop a video in, three things happen:

1. The MP4 container is **sniffed** (`app/lib/sniffMp4.ts`) to identify the
   codec. If it's H.264 / VP9 / AV1 / HEVC-on-a-capable-OS we hand it to the
   `<video>` element. If it's a codec `<video>` can't handle, we skip that
   path entirely.
2. The `<video>` path draws every frame into a `<canvas>` and samples it
   (`app/lib/detectBlackFrame.ts`). If the rendered frame is almost pure
   black — a symptom of GPU-decode failure or a Chromium hardware bug — we
   stop and switch to the fallback.
3. The fallback path (`app/lib/webcodecsDecoder.ts`) demuxes the MP4 with
   `mp4box.js`, feeds encoded samples into a `VideoDecoder`, and draws each
   decoded `VideoFrame` onto a `<canvas>`. This bypasses every one of the
   buggy code paths in Chromium's `<video>` + MSE pipeline.

If both fail (e.g. HEVC on a Linux box with no HEVC hardware), the user gets
a clear, specific message instead of a black video and silence.

## Scripts

```bash
npm run dev     # Start the Next.js dev server
npm run build   # Create a production build
npm run start   # Serve the production build
npm run lint    # Lint
```

## Keyboard shortcuts

| Key                 | Action                       |
| ------------------- | ---------------------------- |
| `Space`             | Play / pause                 |
| `←` / `→`           | Step one frame               |
| `Shift` + `←` / `→` | Step ten frames              |
| `Enter`             | Extract current frame as PNG |

## Deploying

This directory is a standalone Next.js project. Point Vercel at
`frameextractor/web` as the project root (or use the
[vercel.json](../vercel.json) at the repo root) and it'll build + deploy
with zero config.
