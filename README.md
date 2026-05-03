# Frame Extractor

A tiny, focused desktop app: load an MP4, scrub through it frame-by-frame (or
play it at normal speed), and export the exact frame you want as a
**full-resolution, lossless PNG**.

No accounts. No cloud. No bloat.

## Features

- Open any MP4 (also works for MOV / MKV / AVI / WebM via the same codec path)
- Drag-and-drop a file onto the window, or use **Open Video…**
- **Play / pause** at the video's native framerate
- Frame-accurate navigation: slider, frame number box, and prev/next buttons
- Keyboard shortcuts for fast scrubbing
- One-click **Export Frame as PNG** at the original resolution with
  `compress_level=0` (fully lossless, no re-encoding of pixel data)

## Install

Python 3.10+ is recommended. A `venv/` is already in this folder.

```bash
# From the project root
./venv/bin/pip install -r requirements.txt
```

If you want a fresh environment:

```bash
python -m venv venv
./venv/bin/pip install -r requirements.txt
```

## Run

```bash
./venv/bin/python main.py
```

Optionally open a file directly:

```bash
./venv/bin/python main.py /path/to/clip.mp4
```

## Keyboard shortcuts

| Action                      | Shortcut                     |
| --------------------------- | ---------------------------- |
| Open video                  | `Ctrl+O`                     |
| Play / pause                | `Space`                      |
| Previous / next frame       | `←` / `→`  (also `,` / `.`)  |
| Jump ±10 frames             | `Shift + ←/→`                |
| First / last frame          | `Home` / `End`               |
| Export current frame as PNG | `Ctrl+S`                     |

Any manual navigation (slider, frame box, prev/next, jump) automatically
pauses playback.

## Notes on quality

- Frames are decoded by FFmpeg (via OpenCV) at their native pixel dimensions.
- Export uses Pillow with `compress_level=0`, so the saved PNG is a
  bit-exact copy of the decoded frame — there is no additional lossy step.
- Seeking uses `CAP_PROP_POS_FRAMES`; sequential **Next** / playback reads
  without re-seeking to stay fast and frame-accurate.

## Project layout

```
frameextractor/
├── main.py            # The whole app (GUI + decoding + export)
├── requirements.txt
└── README.md
```
