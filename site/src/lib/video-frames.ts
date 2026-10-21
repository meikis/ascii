/*
 * Video frame extraction: uses ffmpeg.wasm (WebAssembly) to decode any video
 * format — including H.265/HEVC from phone recordings — that the browser's
 * native <video> element cannot play.
 *
 * Strategy:
 * 1. First try the native <video> element (fast, works for H.264/VP8/VP9).
 * 2. If that fails (videoWidth=0 → unsupported codec like HEVC), fall back to
 *    ffmpeg.wasm core loaded directly on the main thread (no Worker, no
 *    importScripts issues with module workers).
 *
 * The ffmpeg core files are served from /ffmpeg/ (public/ffmpeg/).
 * We load ffmpeg-core.js via a <script> tag (it's UMD/IIFE, not ESM) which
 * sets self.createFFmpegCore, then call it to get the ffmpeg FS.
 */

export interface VideoFrameData {
  /** The frame's pixels, as RGBA ImageData. */
  data: ImageData;
  /** Delay before the next frame, in milliseconds. */
  delay: number;
}

/** Lazy-loaded ffmpeg core (the Emscripten module instance). */
let ffmpegCore: any = null;

/** Stage callback: reports what phase the extraction is in. */
export type StageCallback = (stage: string) => void;

/**
 * Extracts frames from a video Blob.
 */
export async function videoFrames(
  blob: Blob,
  fps = 10,
  maxFrames = 200,
  onProgress?: (done: number, total: number) => void,
  onStage?: StageCallback,
): Promise<VideoFrameData[]> {
  console.log(`[video-frames] blob size=${blob.size}, type=${blob.type}`);

  // Step 1: Try native <video> decoding first (fast path for H.264/WebM).
  onStage?.("checking browser video support…");
  try {
    const frames = await videoFramesNative(blob, fps, maxFrames, onProgress);
    if (frames.length > 0) {
      console.log(`[video-frames] native: got ${frames.length} frames`);
      return frames;
    }
  } catch (err) {
    console.log(`[video-frames] native decode failed: ${(err as Error).message}`);
  }

  // Step 2: Fall back to ffmpeg core (handles HEVC, H.265, etc.).
  console.log("[video-frames] falling back to ffmpeg core for decoding");
  return videoFramesFFmpeg(blob, fps, maxFrames, onProgress, onStage);
}

// ---------------------------------------------------------------------------
// Native <video> path (H.264, VP8, VP9 — the common cases)
// ---------------------------------------------------------------------------

async function videoFramesNative(
  blob: Blob,
  fps: number,
  maxFrames: number,
  onProgress?: (done: number, total: number) => void,
): Promise<VideoFrameData[]> {
  const url = URL.createObjectURL(blob);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("metadata timeout")), 15_000);
    video.onloadedmetadata = () => { clearTimeout(t); resolve(); };
    video.onerror = () => { clearTimeout(t); reject(new Error("native: load error")); };
  });

  const duration = video.duration;
  if (!isFinite(duration) || duration <= 0) {
    URL.revokeObjectURL(url);
    throw new Error("native: no duration");
  }

  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 5_000;
    const check = () => {
      if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
        resolve();
      } else if (Date.now() > deadline) {
        reject(new Error(`native: codec unsupported (readyState=${video.readyState}, videoWidth=${video.videoWidth})`));
      } else {
        setTimeout(check, 150);
      }
    };
    check();
  });

  const vw = video.videoWidth;
  const vh = video.videoHeight;
  console.log(`[video-frames] native: ${vw}x${vh}, duration=${duration}`);

  const total = Math.min(maxFrames, Math.ceil(duration * fps));
  const interval = duration / total;

  // Downscale large videos to reduce pixel processing downstream.
  const maxDim = 640;
  const scale = Math.min(1, maxDim / Math.max(vw, vh));
  const cw = Math.round(vw * scale), ch = Math.round(vh * scale);

  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

  const frames: VideoFrameData[] = [];

  for (let i = 0; i < total; i++) {
    const t = i * interval;
    await seekNative(video, t);
    ctx.drawImage(video, 0, 0, cw, ch);
    const data = ctx.getImageData(0, 0, cw, ch);
    frames.push({ data, delay: 1000 / fps });
    if (onProgress) onProgress(i + 1, total);
  }

  URL.revokeObjectURL(url);
  return frames;
}

function seekNative(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const tid = setTimeout(() => {
      if (settled) return;
      settled = true;
      video.removeEventListener("seeked", onSeeked);
      resolve(); // don't reject — skip the frame instead
    }, 3_000);
    const onSeeked = () => {
      if (settled) return;
      settled = true;
      clearTimeout(tid);
      video.removeEventListener("seeked", onSeeked);
      resolve();
    };
    video.addEventListener("seeked", onSeeked);
    try { video.currentTime = time; } catch { clearTimeout(tid); resolve(); }
  });
}

// ---------------------------------------------------------------------------
// ffmpeg core path (main thread, no Worker)
// ---------------------------------------------------------------------------

/**
 * Loads ffmpeg-core.js via a <script> tag (it's UMD, sets self.createFFmpegCore),
 * then calls createFFmpegCore to get the Emscripten module with FS access.
 */
async function loadFFmpegCore(): Promise<any> {
  if (ffmpegCore) return ffmpegCore;

  console.log("[video-frames] loading ffmpeg-core.js via <script> tag…");

  // Load the UMD script. It sets self.createFFmpegCore.
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/ffmpeg/ffmpeg-core.js";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("failed to load ffmpeg-core.js script"));
    document.head.appendChild(script);
  });

  if (!(self as any).createFFmpegCore) {
    throw new Error("ffmpeg-core.js loaded but createFFmpegCore not found");
  }

  console.log("[video-frames] createFFmpegCore found, instantiating…");

  // Instantiate the core. The wasmURL is passed via mainScriptUrlOrBlob.
  ffmpegCore = await (self as any).createFFmpegCore({
    mainScriptUrlOrBlob: `/ffmpeg/ffmpeg-core.js#${btoa(JSON.stringify({
      wasmURL: "/ffmpeg/ffmpeg-core.wasm",
      workerURL: "",
    }))}`,
  });

  console.log("[video-frames] ffmpeg core instantiated");
  return ffmpegCore;
}

async function videoFramesFFmpeg(
  blob: Blob,
  fps: number,
  maxFrames: number,
  onProgress?: (done: number, total: number) => void,
  onStage?: StageCallback,
): Promise<VideoFrameData[]> {
  onStage?.("loading ffmpeg decoder (32 MB WASM)…");
  const core = await loadFFmpegCore();
  const FS = core.FS;

  const inputName = "input_video";
  const outputPattern = "frame_%05d.png";

  // Write the blob into the virtual filesystem.
  onStage?.("reading video into memory…");
  const fileData = new Uint8Array(await blob.arrayBuffer());
  FS.writeFile(inputName, fileData);
  console.log(`[video-frames] ffmpeg: wrote input (${fileData.length} bytes)`);

  // Get duration by running ffmpeg with -f null and parsing stderr.
  let duration = 0;
  let logBuffer = "";
  const origSetLogger = core.setLogger;
  if (origSetLogger) {
    origSetLogger((data: { type: string; message: string }) => {
      logBuffer += data.message + "\n";
    });
  }

  try {
    core.setTimeout(-1);
    core.exec("-i", inputName, "-f", "null", "-");
    core.reset();
  } catch {
    // non-fatal
  }

  const m = logBuffer.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
  if (m) {
    duration = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
  }

  if (!duration) duration = 10;
  console.log(`[video-frames] ffmpeg: duration=${duration}s`);

  const total = Math.min(maxFrames, Math.ceil(duration * fps));
  console.log(`[video-frames] ffmpeg: extracting ${total} frames at ${fps} fps`);

  // Extract frames as PNG.
  onStage?.(`decoding ${total} frames with ffmpeg…`);
  core.setTimeout(-1);
  core.exec(
    "-i", inputName,
    "-vf", `fps=${fps}`,
    "-frames:v", String(total),
    "-f", "image2",
    outputPattern,
  );
  core.reset();

  // Read each PNG and decode to ImageData.
  onStage?.("converting frames to images…");
  const frames: VideoFrameData[] = [];
  for (let i = 1; i <= total; i++) {
    const name = `frame_${String(i).padStart(5, "0")}.png`;
    try {
      const data = FS.readFile(name) as Uint8Array;
      const pngBlob = new Blob([data], { type: "image/png" });
      const imageData = await pngToImageData(pngBlob);
      if (imageData) {
        frames.push({ data: imageData, delay: 1000 / fps });
      }
      try { FS.unlink(name); } catch {}
    } catch {
      console.log(`[video-frames] ffmpeg: frame ${i} not found, stopping`);
      break;
    }
    if (onProgress) onProgress(i, total);
  }

  // Clean up input.
  try { FS.unlink(inputName); } catch {}

  console.log(`[video-frames] ffmpeg: extracted ${frames.length} frames`);
  return frames;
}

/**
 * Decodes a PNG Blob to an ImageData object using an ImageBitmap.
 * Reuses a single canvas to avoid per-frame allocation.
 */
async function pngToImageData(pngBlob: Blob): Promise<ImageData | null> {
  const bitmap = await createImageBitmap(pngBlob);
  // Reuse a shared canvas instead of creating one per frame.
  if (!pngCanvas || pngCanvas.width !== bitmap.width || pngCanvas.height !== bitmap.height) {
    pngCanvas = document.createElement("canvas");
    pngCanvas.width = bitmap.width;
    pngCanvas.height = bitmap.height;
    pngCtx = pngCanvas.getContext("2d", { willReadFrequently: true })!;
  }
  pngCtx!.drawImage(bitmap, 0, 0);
  bitmap.close();
  return pngCtx!.getImageData(0, 0, pngCanvas.width, pngCanvas.height);
}

let pngCanvas: HTMLCanvasElement | null = null;
let pngCtx: CanvasRenderingContext2D | null = null;
