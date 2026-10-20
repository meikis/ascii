/*
 * Multi-language font generator: renders any Unicode text (Chinese, Japanese,
 * Korean, German, etc.) as a pixel-art font for ascii.rest's banner().
 *
 * The built-in banner fonts only cover A-Z, 0-9 and a few symbols. This module
 * uses a <canvas> + a monospace font to rasterise arbitrary characters into
 * the pixel-grid format that banner()'s Font interface expects:
 *   - "#" for ink, anything else for empty
 *   - rows joined by "|"
 *
 * Usage:
 *   import { rasterFont, banner } from "...";
 *   const font = rasterFont("你好世界", { height: 7 });
 *   const piece = banner("你好世界", { font });
 */

export interface RasterOptions {
  /** The pixel height of each glyph (rows). Default 7. */
  height?: number;
  /** The pixel width of each glyph (columns). 0 = auto per character. Default 0. */
  width?: number;
  /** The CSS font-family to use. Default a monospace fallback chain. */
  fontFamily?: string;
  /** The font size in px for rasterising. Higher = more detail. Default 64. */
  fontSize?: number;
  /** Threshold 0-255; pixels darker than this are ink. Default 128. */
  threshold?: number;
}

/** The monospace font chain for CJK + Latin. */
const FONT_CHAIN =
  '"Noto Sans CJK SC", "Noto Sans CJK TC", "Noto Sans CJK JP", "Noto Sans CJK KR", "Microsoft YaHei", "PingFang SC", "Hiragino Sans", "WenQuanYi Micro Hei", "SimHei", "SimSun", monospace';

/**
 * Rasterise a single character into rows of "#" / "." pixels.
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
      if (alpha > threshold) {
        hasInk = true;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (!hasInk) return undefined;

  // Scale the bounding box to the target height.
  const bbW = maxX - minX + 1;
  const bbH = maxY - minY + 1;
  const scale = height / bbH;
  const targetW = Math.max(1, Math.round(bbW * scale));

  // Downscale using threshold sampling.
  const rows: string[] = [];
  for (let py = 0; py < height; py++) {
    let row = "";
    const sy = minY + Math.floor(py / scale);
    for (let px = 0; px < (width || targetW); px++) {
      const sx = minX + Math.floor(px / scale);
      const alpha = sx >= 0 && sx < canvas.width && sy >= 0 && sy < canvas.height
        ? data[(sy * canvas.width + sx) * 4 + 3]
        : 0;
      row += alpha > threshold ? "#" : ".";
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
  const height = options.height ?? 7;
  const width = options.width ?? 0;
  const fontFamily = options.fontFamily ?? FONT_CHAIN;
  const fontSize = options.fontSize ?? 64;
  const threshold = options.threshold ?? 80;

  // Set up canvas for rasterisation.
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
