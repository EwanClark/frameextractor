"""
Frame Extractor
---------------
A simple desktop app to load an MP4 video, navigate frame-by-frame,
and export the current frame as a lossless, full-resolution PNG.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Optional

import cv2
import numpy as np
from PIL import Image
from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import (
    QDragEnterEvent,
    QDropEvent,
    QImage,
    QKeySequence,
    QPixmap,
    QShortcut,
)
from PySide6.QtWidgets import (
    QApplication,
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QSizePolicy,
    QSlider,
    QSpinBox,
    QStatusBar,
    QToolButton,
    QVBoxLayout,
    QWidget,
)


# ---------------------------------------------------------------------------
# Video decoding
# ---------------------------------------------------------------------------


class VideoSource:
    """Thin wrapper around cv2.VideoCapture with frame-accurate access."""

    def __init__(self, path: str) -> None:
        self.path = path
        self.cap = cv2.VideoCapture(path)
        if not self.cap.isOpened():
            raise RuntimeError(f"Could not open video: {path}")

        self.frame_count = int(self.cap.get(cv2.CAP_PROP_FRAME_COUNT))
        self.fps = float(self.cap.get(cv2.CAP_PROP_FPS)) or 0.0
        self.width = int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        self.height = int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

        if self.frame_count <= 0:
            # Some containers don't report frame count — fall back by scanning.
            self.frame_count = self._count_by_scan()

    def _count_by_scan(self) -> int:
        count = 0
        self.cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
        while True:
            ok = self.cap.grab()
            if not ok:
                break
            count += 1
        self.cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
        return count

    def read_frame(self, index: int) -> Optional[np.ndarray]:
        """Return BGR frame at the given index, or None on failure."""
        if index < 0 or (self.frame_count and index >= self.frame_count):
            return None
        self.cap.set(cv2.CAP_PROP_POS_FRAMES, index)
        ok, frame = self.cap.read()
        if not ok or frame is None:
            return None
        return frame

    def read_next(self) -> Optional[np.ndarray]:
        """Read the next frame sequentially (fast path for prev/next)."""
        ok, frame = self.cap.read()
        if not ok or frame is None:
            return None
        return frame

    def release(self) -> None:
        if self.cap is not None:
            self.cap.release()
            self.cap = None


# ---------------------------------------------------------------------------
# Preview widget
# ---------------------------------------------------------------------------


class FramePreview(QLabel):
    """QLabel that displays a frame scaled to fit, preserving aspect ratio."""

    def __init__(self) -> None:
        super().__init__()
        self.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.setMinimumSize(480, 270)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self.setStyleSheet(
            "QLabel { background: #0e0e10; color: #888; border: 1px solid #2a2a2e; }"
        )
        self.setText("Drop an MP4 here — or click 'Open Video'")
        self._source_pixmap: Optional[QPixmap] = None

    def set_frame(self, frame_bgr: Optional[np.ndarray]) -> None:
        if frame_bgr is None:
            self._source_pixmap = None
            self.setText("(no frame)")
            return
        rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        h, w, _ = rgb.shape
        img = QImage(rgb.data, w, h, 3 * w, QImage.Format.Format_RGB888).copy()
        self._source_pixmap = QPixmap.fromImage(img)
        self._rescale()

    def clear_frame(self) -> None:
        self._source_pixmap = None
        self.setText("Drop an MP4 here — or click 'Open Video'")

    def resizeEvent(self, event) -> None:  # noqa: N802 (Qt naming)
        super().resizeEvent(event)
        self._rescale()

    def _rescale(self) -> None:
        if self._source_pixmap is None:
            return
        scaled = self._source_pixmap.scaled(
            self.size(),
            Qt.AspectRatioMode.KeepAspectRatio,
            Qt.TransformationMode.SmoothTransformation,
        )
        self.setPixmap(scaled)


# ---------------------------------------------------------------------------
# Main window
# ---------------------------------------------------------------------------


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("Frame Extractor")
        self.resize(1100, 720)
        self.setAcceptDrops(True)

        self.video: Optional[VideoSource] = None
        self.current_index: int = 0
        self.current_frame: Optional[np.ndarray] = None
        self.last_export_dir: Optional[str] = None

        self.play_timer = QTimer(self)
        self.play_timer.setTimerType(Qt.TimerType.PreciseTimer)
        self.play_timer.timeout.connect(self._on_play_tick)

        self._build_ui()
        self._wire_shortcuts()
        self._apply_style()
        self._update_controls_enabled()

    # -- UI construction -----------------------------------------------------

    def _build_ui(self) -> None:
        central = QWidget()
        self.setCentralWidget(central)

        root = QVBoxLayout(central)
        root.setContentsMargins(14, 14, 14, 14)
        root.setSpacing(10)

        # Top bar: open + filename ------------------------------------------
        top = QHBoxLayout()
        self.open_btn = QPushButton("Open Video…")
        self.open_btn.clicked.connect(self._on_open)
        top.addWidget(self.open_btn)

        self.file_label = QLabel("No file loaded")
        self.file_label.setStyleSheet("color: #9aa0a6;")
        self.file_label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        top.addWidget(self.file_label, stretch=1)

        self.meta_label = QLabel("")
        self.meta_label.setStyleSheet("color: #9aa0a6;")
        top.addWidget(self.meta_label)

        root.addLayout(top)

        # Preview -----------------------------------------------------------
        self.preview = FramePreview()
        root.addWidget(self.preview, stretch=1)

        # Slider ------------------------------------------------------------
        self.slider = QSlider(Qt.Orientation.Horizontal)
        self.slider.setMinimum(0)
        self.slider.setMaximum(0)
        self.slider.setTracking(True)
        self.slider.valueChanged.connect(self._on_slider_changed)
        root.addWidget(self.slider)

        # Navigation row ----------------------------------------------------
        nav = QHBoxLayout()
        nav.setSpacing(8)

        self.first_btn = QToolButton()
        self.first_btn.setText("⏮")
        self.first_btn.setToolTip("First frame (Home)")
        self.first_btn.clicked.connect(lambda: self._go_to(0))

        self.prev_btn = QToolButton()
        self.prev_btn.setText("◀")
        self.prev_btn.setToolTip("Previous frame (← or ,)")
        self.prev_btn.clicked.connect(self._go_prev)

        self.play_btn = QToolButton()
        self.play_btn.setText("▶ Play")
        self.play_btn.setToolTip("Play / pause (Space)")
        self.play_btn.setCheckable(True)
        self.play_btn.clicked.connect(self._toggle_play)

        self.next_btn = QToolButton()
        self.next_btn.setText("▶")
        self.next_btn.setToolTip("Next frame (→ or .)")
        self.next_btn.clicked.connect(self._go_next)

        self.last_btn = QToolButton()
        self.last_btn.setText("⏭")
        self.last_btn.setToolTip("Last frame (End)")
        self.last_btn.clicked.connect(self._go_last)

        for b in (
            self.first_btn,
            self.prev_btn,
            self.play_btn,
            self.next_btn,
            self.last_btn,
        ):
            b.setFixedHeight(32)
            b.setMinimumWidth(42)
            nav.addWidget(b)
        self.play_btn.setMinimumWidth(80)

        nav.addSpacing(12)

        nav.addWidget(QLabel("Frame"))
        self.frame_spin = QSpinBox()
        self.frame_spin.setMinimum(0)
        self.frame_spin.setMaximum(0)
        self.frame_spin.setFixedWidth(110)
        self.frame_spin.editingFinished.connect(self._on_spin_commit)
        nav.addWidget(self.frame_spin)

        self.total_label = QLabel("/ 0")
        nav.addWidget(self.total_label)

        self.time_label = QLabel("00:00:00.000")
        self.time_label.setStyleSheet("color: #9aa0a6; margin-left: 12px;")
        nav.addWidget(self.time_label)

        nav.addStretch(1)

        self.export_btn = QPushButton("Export Frame as PNG")
        self.export_btn.setToolTip("Save current frame (Ctrl+S)")
        self.export_btn.clicked.connect(self._on_export)
        self.export_btn.setMinimumHeight(34)
        nav.addWidget(self.export_btn)

        root.addLayout(nav)

        # Status bar --------------------------------------------------------
        self.setStatusBar(QStatusBar())
        self.statusBar().showMessage("Ready")

    def _wire_shortcuts(self) -> None:
        QShortcut(QKeySequence(Qt.Key.Key_Left), self, activated=self._go_prev)
        QShortcut(QKeySequence(Qt.Key.Key_Comma), self, activated=self._go_prev)
        QShortcut(QKeySequence(Qt.Key.Key_Right), self, activated=self._go_next)
        QShortcut(QKeySequence(Qt.Key.Key_Period), self, activated=self._go_next)
        QShortcut(QKeySequence(Qt.Key.Key_Home), self, activated=lambda: self._go_to(0))
        QShortcut(QKeySequence(Qt.Key.Key_End), self, activated=self._go_last)
        QShortcut(QKeySequence("Ctrl+S"), self, activated=self._on_export)
        QShortcut(QKeySequence("Ctrl+O"), self, activated=self._on_open)

        # Coarser step: Shift+arrow = ±10 frames
        QShortcut(QKeySequence("Shift+Left"), self, activated=lambda: self._step(-10))
        QShortcut(QKeySequence("Shift+Right"), self, activated=lambda: self._step(10))

        QShortcut(QKeySequence(Qt.Key.Key_Space), self, activated=self._toggle_play)

    def _apply_style(self) -> None:
        self.setStyleSheet(
            """
            QMainWindow, QWidget { background: #17181b; color: #e6e6e6; }
            QPushButton, QToolButton {
                background: #2a2b30; color: #e6e6e6;
                border: 1px solid #3a3b40; border-radius: 6px;
                padding: 6px 12px;
            }
            QPushButton:hover, QToolButton:hover { background: #34363c; }
            QPushButton:disabled, QToolButton:disabled { color: #6b6e75; background: #212227; }
            QSpinBox {
                background: #1f2024; color: #e6e6e6;
                border: 1px solid #3a3b40; border-radius: 6px; padding: 4px 6px;
            }
            QSlider::groove:horizontal {
                height: 6px; background: #2a2b30; border-radius: 3px;
            }
            QSlider::handle:horizontal {
                background: #e6e6e6; width: 14px; height: 14px;
                margin: -5px 0; border-radius: 7px;
            }
            QSlider::sub-page:horizontal { background: #6ea8ff; border-radius: 3px; }
            QStatusBar { background: #121316; color: #9aa0a6; }
            """
        )

    # -- File handling -------------------------------------------------------

    def _on_open(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self,
            "Open video",
            "",
            "Video files (*.mp4 *.mov *.mkv *.avi *.webm);;All files (*)",
        )
        if path:
            self._load_video(path)

    def _load_video(self, path: str) -> None:
        try:
            new_source = VideoSource(path)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "Could not open video", str(exc))
            return

        self._set_playing(False)
        if self.video is not None:
            self.video.release()
        self.video = new_source
        self.current_index = 0
        self.current_frame = None

        total = max(self.video.frame_count, 1)
        self.slider.blockSignals(True)
        self.slider.setMaximum(total - 1)
        self.slider.setValue(0)
        self.slider.blockSignals(False)

        self.frame_spin.blockSignals(True)
        self.frame_spin.setMaximum(total - 1)
        self.frame_spin.setValue(0)
        self.frame_spin.blockSignals(False)

        self.total_label.setText(f"/ {total - 1}")

        fps = self.video.fps
        duration = (self.video.frame_count / fps) if fps else 0.0
        self.meta_label.setText(
            f"{self.video.width}×{self.video.height}  ·  "
            f"{fps:.3f} fps  ·  {self._format_time(duration)}"
        )
        self.file_label.setText(Path(path).name)
        self.setWindowTitle(f"Frame Extractor — {Path(path).name}")

        self._show_frame(0)
        self._update_controls_enabled()
        self.statusBar().showMessage(
            f"Loaded {self.video.frame_count} frames", 4000
        )

    # -- Navigation ----------------------------------------------------------

    def _on_slider_changed(self, value: int) -> None:
        # Slider drag implies manual scrubbing; pause playback.
        if self.play_timer.isActive():
            self._set_playing(False)
        self._go_to(value, update_slider=False)

    def _on_spin_commit(self) -> None:
        if self.play_timer.isActive():
            self._set_playing(False)
        self._go_to(self.frame_spin.value())

    def _step(self, delta: int) -> None:
        if self.video is None:
            return
        if self.play_timer.isActive():
            self._set_playing(False)
        target = max(0, min(self.video.frame_count - 1, self.current_index + delta))
        self._go_to(target)

    def _go_prev(self) -> None:
        self._step(-1)

    def _go_next(self) -> None:
        if self.video is None:
            return
        # Fast path: read next sequentially (avoids a seek).
        if self.current_index + 1 >= self.video.frame_count:
            return
        frame = self.video.read_next()
        if frame is None:
            # Fall back to seek.
            self._go_to(self.current_index + 1)
            return
        self.current_index += 1
        self.current_frame = frame
        self._reflect_position()
        self.preview.set_frame(frame)

    def _go_last(self) -> None:
        if self.video is None:
            return
        self._go_to(self.video.frame_count - 1)

    def _go_to(self, index: int, update_slider: bool = True) -> None:
        if self.video is None:
            return
        index = max(0, min(self.video.frame_count - 1, index))
        frame = self.video.read_frame(index)
        if frame is None:
            self.statusBar().showMessage(f"Failed to read frame {index}", 4000)
            return
        self.current_index = index
        self.current_frame = frame
        self._reflect_position(update_slider=update_slider)
        self.preview.set_frame(frame)

    def _show_frame(self, index: int) -> None:
        self._go_to(index)

    def _reflect_position(self, update_slider: bool = True) -> None:
        if update_slider:
            self.slider.blockSignals(True)
            self.slider.setValue(self.current_index)
            self.slider.blockSignals(False)

        self.frame_spin.blockSignals(True)
        self.frame_spin.setValue(self.current_index)
        self.frame_spin.blockSignals(False)

        if self.video and self.video.fps > 0:
            t = self.current_index / self.video.fps
            self.time_label.setText(self._format_time(t))
        else:
            self.time_label.setText("—")

    # -- Export --------------------------------------------------------------

    def _on_export(self) -> None:
        if self.video is None or self.current_frame is None:
            return

        base = Path(self.video.path).stem
        default_name = f"{base}_frame_{self.current_index:06d}.png"
        start_dir = self.last_export_dir or str(Path(self.video.path).parent)
        default_path = str(Path(start_dir) / default_name)

        path, _ = QFileDialog.getSaveFileName(
            self, "Save frame as PNG", default_path, "PNG image (*.png)"
        )
        if not path:
            return
        if not path.lower().endswith(".png"):
            path += ".png"

        try:
            rgb = cv2.cvtColor(self.current_frame, cv2.COLOR_BGR2RGB)
            # compress_level=0 keeps PNG fully lossless and fastest to write.
            Image.fromarray(rgb).save(path, format="PNG", compress_level=0)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "Export failed", str(exc))
            return

        self.last_export_dir = str(Path(path).parent)
        self.statusBar().showMessage(f"Saved: {path}", 5000)

    # -- State ---------------------------------------------------------------

    def _update_controls_enabled(self) -> None:
        has_video = self.video is not None
        for w in (
            self.slider,
            self.frame_spin,
            self.first_btn,
            self.prev_btn,
            self.play_btn,
            self.next_btn,
            self.last_btn,
            self.export_btn,
        ):
            w.setEnabled(has_video)

    # -- Playback ------------------------------------------------------------

    def _toggle_play(self) -> None:
        if self.video is None:
            return
        self._set_playing(not self.play_timer.isActive())

    def _set_playing(self, playing: bool) -> None:
        if playing:
            if self.video is None:
                return
            # If we're at the end, rewind so playback can start over.
            if self.current_index >= self.video.frame_count - 1:
                self._go_to(0)
            fps = self.video.fps if self.video.fps and self.video.fps > 0 else 30.0
            interval = max(1, int(round(1000.0 / fps)))
            self.play_timer.start(interval)
            self.play_btn.setText("⏸ Pause")
            self.play_btn.setChecked(True)
        else:
            self.play_timer.stop()
            self.play_btn.setText("▶ Play")
            self.play_btn.setChecked(False)

    def _on_play_tick(self) -> None:
        if self.video is None:
            self._set_playing(False)
            return
        if self.current_index + 1 >= self.video.frame_count:
            self._set_playing(False)
            return
        self._go_next()

    # -- Drag and drop -------------------------------------------------------

    def dragEnterEvent(self, event: QDragEnterEvent) -> None:  # noqa: N802
        if event.mimeData().hasUrls():
            event.acceptProposedAction()

    def dropEvent(self, event: QDropEvent) -> None:  # noqa: N802
        urls = event.mimeData().urls()
        if not urls:
            return
        path = urls[0].toLocalFile()
        if path:
            self._load_video(path)

    # -- Lifecycle -----------------------------------------------------------

    def closeEvent(self, event) -> None:  # noqa: N802
        self.play_timer.stop()
        if self.video is not None:
            self.video.release()
        super().closeEvent(event)

    # -- Helpers -------------------------------------------------------------

    @staticmethod
    def _format_time(seconds: float) -> str:
        if seconds < 0 or seconds != seconds:  # NaN guard
            return "—"
        total_ms = int(round(seconds * 1000))
        hours, rem_ms = divmod(total_ms, 3_600_000)
        minutes, rem_ms = divmod(rem_ms, 60_000)
        secs, ms = divmod(rem_ms, 1000)
        return f"{hours:02d}:{minutes:02d}:{secs:02d}.{ms:03d}"


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("Frame Extractor")

    window = MainWindow()
    window.show()

    # Support: `python main.py path/to/video.mp4`
    if len(sys.argv) > 1:
        candidate = sys.argv[1]
        if Path(candidate).exists():
            window._load_video(candidate)

    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
