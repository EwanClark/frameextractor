/**
 * Sample a canvas and decide whether the rendered video frame is almost
 * certainly black (or a uniform dark color). If so, the `<video>` pipeline
 * has most likely failed — either the codec can't be decoded, or a
 * hardware-decode bug is hitting us. See crbug 40739089.
 *
 * Heuristic: average the luma over a sparse grid. If both the average and
 * maximum sampled luma fall below a threshold, call it black.
 */
export interface BlackFrameCheck {
  isBlack: boolean;
  averageLuma: number;
  maxLuma: number;
  sampled: number;
}

export function detectBlackFrame(canvas: HTMLCanvasElement): BlackFrameCheck {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx || canvas.width === 0 || canvas.height === 0) {
    return { isBlack: true, averageLuma: 0, maxLuma: 0, sampled: 0 };
  }
  const { width, height } = canvas;
  const stepX = Math.max(1, Math.floor(width / 16));
  const stepY = Math.max(1, Math.floor(height / 16));
  let total = 0;
  let max = 0;
  let count = 0;
  for (let y = stepY; y < height; y += stepY) {
    for (let x = stepX; x < width; x += stepX) {
      const d = ctx.getImageData(x, y, 1, 1).data;
      const luma = 0.2126 * d[0] + 0.7152 * d[1] + 0.0722 * d[2];
      total += luma;
      if (luma > max) max = luma;
      count++;
    }
  }
  if (count === 0) return { isBlack: true, averageLuma: 0, maxLuma: 0, sampled: 0 };
  const avg = total / count;
  // Be conservative: require both very low average AND very low max before
  // we call it "black". A video with a dark scene might average ~15 but
  // will have brighter specular highlights, pushing max well above 20.
  const isBlack = avg < 3 && max < 8;
  return { isBlack, averageLuma: avg, maxLuma: max, sampled: count };
}
