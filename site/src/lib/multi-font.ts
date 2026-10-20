/*
 * Multi-language font generator: renders any Unicode text (Chinese, Japanese,
 * Korean, German, etc.) as a pixel-art font for ascii.rest's banner().
 *
 * The built-in banner fonts only cover A-Z, 0-9 and a few symbols. This module
 * uses a <canvas> + a system font to rasterise arbitrary characters into
 * the pixel-grid format that banner()'s Font interface expects:
 *   - "#" for ink, anything else for empty
 *   - rows joined by "|"
 *
 * CJK characters have dense strokes, so the rasteriser automatically uses a
 * higher pixel grid (16+ rows) for them, and area-averaged downscaling to
 * preserve stroke details that single-point sampling would lose.
 */

export interface RasterOptions {
  /** The pixel height of each glyph (rows). 0 = auto-detect. Default 0. */
  height?: number;
  /** The pixel width of each glyph (columns). 0 = auto per character. Default 0. */
  width?: number;
  /** The CSS font-family to use. Default a CJK + Latin fallback chain. */
  fontFamily?: string;
  /** The font size in px for rasterising. Higher = more detail. Default 128. */
  fontSize?: number;
  /** Threshold 0-255; pixels with alpha above this are ink. Default 64. */
  threshold?: number;
}

/** The font chain for CJK + Latin. */
const FONT_CHAIN =
  '"Noto Sans CJK SC", "Noto Sans CJK TC", "Noto Sans CJK JP", "Noto Sans CJK KR", "Microsoft YaHei", "PingFang SC", "Hiragino Sans", "WenQuanYi Micro Hei", "SimHei", "SimSun", monospace';

/** Unicode ranges for CJK (Chinese, Japanese, Korean) characters. */
function isCJK(ch: string): boolean {
  const code = ch.codePointAt(0)!;
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||   // CJK Unified Ideographs
    (code >= 0x3400 && code <= 0x4dbf) ||   // CJK Extension A
    (code >= 0x3000 && code <= 0x303f) ||   // CJK Symbols and Punctuation
    (code >= 0x3040 && code <= 0x309f) ||   // Hiragana
    (code >= 0x30a0 && code <= 0x30ff) ||   // Katakana
    (code >= 0xac00 && code <= 0xd7af) ||   // Hangul Syllables
    (code >= 0x1100 && code <= 0x11ff) ||   // Hangul Jamo
    (code >= 0xff00 && code <= 0xffef)     // Halfwidth/Fullwidth Forms
  );
}

/**
 * Auto-detect the optimal pixel height based on the text content.
 * CJK characters need more rows to show their strokes clearly.
 */
function autoHeight(text: string): number {
  const hasCJK = [...text].some(isCJK);
  if (hasCJK) return 16;  // CJK: 16 rows for clear strokes
  return 7;               // Latin: same as built-in fonts
}

/**
 * Rasterise a single character into rows of "#" / "." pixels.
 * Uses area-averaged downscaling for better quality than point sampling.
 * Returns undefined for characters that render as blank (spaces, controls).
 */
function rasteriseChar(
  ch: string,
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  fontSize: number,
  height: number,
  width: number,
  threshold: number,
): string | undefined {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillText(ch, 0, fontSize);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  // Find the bounding box of non-empty pixels.
  let minX = canvas.width, minY = canvas.height, maxX = 0, maxY = 0;
  let hasInk = false;
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const alpha = data[(y * canvas.width + x) * 4 + 3];
      if (alpha > 0) {
        hasInk = true;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (!hasInk) return undefined;

  // Add small padding around the bounding box.
  const pad = 2;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(canvas.width - 1, maxX + pad);
  maxY = Math.min(canvas.height - 1, maxY + pad);

  const bbW = maxX - minX + 1;
  const bbH = maxY - minY + 1;

  // Scale factor: map bounding box to target height.
  const scale = height / bbH;
  const targetW = width > 0 ? width : Math.max(1, Math.round(bbW * scale));

  // Area-averaged downscaling: for each output pixel, average the alpha
  // values of the source pixels that fall within it, then threshold.
  const rows: string[] = [];
  for (let py = 0; py < height; py++) {
    let row = "";
    const sy0 = minY + py / scale;
    const sy1 = minY + (py + 1) / scale;
    for (let px = 0; px < targetW; px++) {
      const sx0 = minX + px / scale;
      const sx1 = minX + (px + 1) / scale;
      // Average alpha over the source region [sx0,sx1) x [sy0,sy1).
      let sum = 0, count = 0;
      const ix0 = Math.floor(sx0), ix1 = Math.ceil(sx1);
      const iy0 = Math.floor(sy0), iy1 = Math.ceil(sy1);
      for (let iy = iy0; iy < iy1; iy++) {
        for (let ix = ix0; ix < ix1; ix++) {
          if (ix < 0 || ix >= canvas.width || iy < 0 || iy >= canvas.height) continue;
          // Overlap fraction.
          const fx = Math.min(ix + 1, sx1) - Math.max(ix, sx0);
          const fy = Math.min(iy + 1, sy1) - Math.max(iy, sy0);
          if (fx > 0 && fy > 0) {
            sum += data[(iy * canvas.width + ix) * 4 + 3] * fx * fy;
            count += fx * fy;
          }
        }
      }
      const avg = count > 0 ? sum / count : 0;
      row += avg > threshold ? "#" : ".";
    }
    rows.push(row);
  }

  return rows.join("|");
}

/**
 * Build a banner-compatible Font from any text string.
 * Each unique character in the text is rasterised into a pixel glyph.
 * Characters not in the text are omitted (banner() will skip them).
 */
export function rasterFont(text: string, options: RasterOptions = {}) {
  const height = options.height ?? autoHeight(text);
  const width = options.width ?? 0;
  const fontFamily = options.fontFamily ?? FONT_CHAIN;
  const fontSize = options.fontSize ?? 128;
  const threshold = options.threshold ?? 64;

  // Set up canvas for rasterisation — large for detail.
  const canvas = document.createElement("canvas");
  canvas.width = fontSize * 2;
  canvas.height = fontSize * 2;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.font = `${fontSize}px ${fontFamily}`;
  ctx.textBaseline = "top";
  ctx.fillStyle = "#000";

  // Get unique characters from the text (plus space).
  const chars = [...new Set([...text, " "])];

  // Rasterise each character.
  const glyphs: Record<string, string> = {};
  for (const ch of chars) {
    const glyph = rasteriseChar(ch, canvas, ctx, fontSize, height, width, threshold);
    if (glyph) glyphs[ch] = glyph;
  }

  // Ensure space is a blank glyph of the right width.
  if (!glyphs[" "]) {
    const sampleW = Object.values(glyphs)[0]?.split("|")[0]?.length ?? 3;
    glyphs[" "] = Array.from({ length: height }, () => ".".repeat(sampleW)).join("|");
  }

  console.log(`[multi-font] rasterised ${Object.keys(glyphs).length} chars at height=${height}, font=${fontFamily.slice(0, 40)}`);

  return {
    height,
    glyphs,
    cased: true, // Don't uppercase — preserve the original case.
  } as const;
}

/**
 * Check which characters in the text can be drawn by the built-in fonts.
 * Returns the characters that need rasterisation (i.e. are not in any built-in font).
 */
export function needsRaster(text: string, builtInGlyphs: Record<string, string>): string {
  return [...text].filter((ch) => !Object.hasOwn(builtInGlyphs, ch.toUpperCase()) && !Object.hasOwn(builtInGlyphs, ch)).join("");
}
