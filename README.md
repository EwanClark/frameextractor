# Frame Extractor

Load an MP4, step through it frame-by-frame, and export the frame you want as
a full-resolution, lossless PNG. Two implementations live in this repo:

| Version           | Path          | Runtime                             | What it's for                                             |
| ----------------- | ------------- | ----------------------------------- | --------------------------------------------------------- |
| **Desktop (Py)**  | [`python/`](./python)    | PySide6 + OpenCV                    | Fast local tool with frame-accurate OpenCV seeking.       |
| **Web (Next.js)** | [`web/`](./web)       | Next.js 16, WebCodecs, Tailwind 4   | Shareable link. Runs entirely in the browser — zero upload. |

Both do the same job with the same UX; pick whichever fits where you are.

## Why two?

- **Python**: decoding reliability via FFmpeg/OpenCV. Handles HEVC, ProRes,
  VP9, MKV, and anything else OpenCV will open. No install friction if you
  already have Python.
- **Web**: nothing to install, works on any machine, and aggressively handles
  the "upload works but the video is black" problem that plagues most online
  tools. See [`web/README.md`](./web/README.md) for how it falls back from
  `<video>` to a WebCodecs + `mp4box.js` software decoder when the browser's
  native pipeline misbehaves.

## Quick start

### Web version

```bash
cd web
npm install
npm run dev
```

### Python version

```bash
cd python
./venv/bin/pip install -r requirements.txt
./venv/bin/python main.py [optional-video-path.mp4]
```

## Keyboard shortcuts

Both apps agree on:

| Action            | Shortcut                    |
| ----------------- | --------------------------- |
| Play / pause      | `Space`                     |
| Previous / next   | `←` / `→`  (also `,` / `.`) |
| Jump ±10 frames   | `Shift + ←/→`               |
| Export as PNG     | `Enter` (web), `Ctrl+S` (desktop) |
| Open a file       | click / drag-drop, `Ctrl+O` (desktop) |

## Repo layout

```
frameextractor/
├── python/        # PySide6 + OpenCV desktop app
│   ├── main.py
│   └── requirements.txt
├── web/           # Next.js app (deployable to Vercel)
│   ├── app/
│   ├── package.json
│   └── ...
├── vercel.json    # Tells Vercel where the web app lives
└── README.md
```
