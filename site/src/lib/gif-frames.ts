/*
 * GIF frame extraction: parses a GIF's binary format in the browser to read
 * every frame, its delay, and its disposal method, drawing each onto a canvas
 * the way a browser plays a GIF — compositing frames with disposal — so each
 * result is a full ImageData you can read directly.
 *
 * The browser's createImageBitmap only reads the first frame of a GIF; this
 * reads all of them. It uses only the browser's ImageDecoder where available
 * (Chrome), and falls back to a manual GIF parser for other browsers.
 */

export interface GifFrame {
  /** The frame's pixels, as RGBA ImageData. */
  data: ImageData;
  /** Delay before the next frame, in milliseconds. */
  delay: number;
}

/**
 * Reads every frame of a GIF Blob. Returns an empty array for a non-GIF or a
 * GIF with one frame. Each frame's ImageData is the full composited picture at
 * that point, not just the sub-rectangle the GIF changed.
 */
export async function gifFrames(blob: Blob): Promise<GifFrame[]> {
  // Try ImageDecoder first (Chrome 94+): it handles all the compositing.
  if (typeof ImageDecoder !== "undefined") {
    try {
      const frames = await imageDecoderFrames(blob);
      console.log(`[gif-frames] ImageDecoder returned ${frames.length} frames`);
      if (frames.length > 0) return frames;
    } catch (e) {
      console.warn("[gif-frames] ImageDecoder failed, falling back to manual parser:", e);
    }
  } else {
    console.log("[gif-frames] ImageDecoder not available, using manual parser");
  }
  const manualFrames = await manualGifFrames(blob);
  console.log(`[gif-frames] manual parser returned ${manualFrames.length} frames`);
  return manualFrames;
}

// --- ImageDecoder path -----------------------------------------------------------

async function imageDecoderFrames(blob: Blob): Promise<GifFrame[]> {
  const decoder = new ImageDecoder({ type: "image/gif", data: await blob.arrayBuffer(), preferAnimation: true });
  // The frame count may not be known until the decoder has parsed the whole file.
  // Some implementations report 0 initially; we decode frame by frame until we
  // hit an error or the decoder signals completion.
  let count = decoder.tracks[0]?.frameCount ?? 0;
  console.log(`[gif-frames] ImageDecoder initial frameCount: ${count}`);

  // If frameCount is 0, try decoding frames incrementally.
  if (count === 0) {
    const frames: GifFrame[] = [];
    let i = 0;
    const first = await decoder.decode({ frameIndex: 0 });
    const W = first.image.codedWidth, H = first.image.codedHeight;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    // Draw the first frame
    ctx.clearRect(0, 0, W, H);
    const firstBitmap = await createImageBitmap(first.image);
    ctx.drawImage(firstBitmap, 0, 0, W, H);
    firstBitmap.close();
    first.image.close();
    frames.push({ data: ctx.getImageData(0, 0, W, H), delay: (first as any).duration / 1000 });
    // Try to decode more frames
    try {
      while (true) {
        i++;
        const result = await decoder.decode({ frameIndex: i });
        const img = result.image;
        const bitmap = await createImageBitmap(img);
        if ((img as any).displayFormat === "dispose") {
          ctx.clearRect(0, 0, W, H);
        }
        ctx.drawImage(bitmap, 0, 0, W, H);
        bitmap.close();
        img.close();
        frames.push({ data: ctx.getImageData(0, 0, W, H), delay: (result as any).duration / 1000 });
      }
    } catch {
      // No more frames
    }
    console.log(`[gif-frames] ImageDecoder incremental: decoded ${frames.length} frames`);
    return frames;
  }

  if (count <= 1) {
    // Single frame: still return it so the caller can use it.
    const first = await decoder.decode({ frameIndex: 0 });
    const W = first.image.codedWidth, H = first.image.codedHeight;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const bitmap = await createImageBitmap(first.image);
    ctx.drawImage(bitmap, 0, 0, W, H);
    bitmap.close();
    return [{ data: ctx.getImageData(0, 0, W, H), delay: (first as any).duration / 1000 }];
  }

  // Read the first frame to get the GIF's dimensions.
  const first = await decoder.decode({ frameIndex: 0 });
  const W = first.image.codedWidth, H = first.image.codedHeight;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

  const frames: GifFrame[] = [];
  for (let i = 0; i < count; i++) {
    const result = await decoder.decode({ frameIndex: i });
    const img = result.image;
    const bitmap = await createImageBitmap(img);
    if ((result.image as any).displayFormat === "dispose" || i === 0) {
      ctx.clearRect(0, 0, W, H);
    }
    ctx.drawImage(bitmap, 0, 0, W, H);
    bitmap.close();
    frames.push({ data: ctx.getImageData(0, 0, W, H), delay: (result as any).duration / 1000 });
  }
  return frames;
}

// --- Manual GIF parser -----------------------------------------------------------
// GIF89a spec: each frame is an Image Descriptor with a local colour table,
// LZW-compressed data, and a Graphic Control Extension with the delay and
// disposal method. We decode the LZW data and composite frames on a canvas.

async function manualGifFrames(blob: Blob): Promise<GifFrame[]> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // Validate the GIF header.
  const isGif = bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61;
  if (!isGif) return [];

  let pos = 6; // past "GIF89a"

  // Logical Screen Descriptor.
  const W = bytes[pos] | (bytes[pos + 1] << 8);
  const H = bytes[pos + 2] | (bytes[pos + 3] << 8);
  const flags = bytes[pos + 4];
  const gctSize = flags & 0x80 ? 1 << ((flags & 0x07) + 1) : 0;
  pos += 7; // past the LSD (7 bytes)

  // Global Colour Table.
  let gct: Uint8Array | null = null;
  if (gctSize) {
    gct = bytes.subarray(pos, pos + gctSize * 3);
    pos += gctSize * 3;
  }

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  // The master frame, which we composite onto. Some disposals restore to this.
  let master = ctx.createImageData(W, H);
  let snapshot: ImageData | null = null;

  const frames: GifFrame[] = [];
  let frameCount = 0;

  while (pos < bytes.length) {
    const byte = bytes[pos];

    if (byte === 0x21) {
      // Extension Introducer.
      pos++;
      const label = bytes[pos++];
      if (label === 0xf9) {
        // Graphic Control Extension.
        const size = bytes[pos++]; // block size (4)
        const packed = bytes[pos++];
        const delay = (bytes[pos] | (bytes[pos + 1] << 8)) * 10; // centiseconds → ms
        pos += 2; // past delay
        const transparentIndex = bytes[pos++];
        pos++; // terminator
        const disposal = (packed >> 2) & 0x07;
        const transparent = packed & 0x01;

        // Read the next Image Descriptor (the frame this GCE applies to).
        if (bytes[pos] !== 0x2c) continue; // not an image descriptor
        pos++; // past 0x2c

        const left = bytes[pos] | (bytes[pos + 1] << 8);
        const top = bytes[pos + 2] | (bytes[pos + 3] << 8);
        const fw = bytes[pos + 4] | (bytes[pos + 5] << 8);
        const fh = bytes[pos + 6] | (bytes[pos + 7] << 8);
        const fflags = bytes[pos + 8];
        pos += 9; // past the Image Descriptor (9 bytes after 0x2c)

        const lctSize = fflags & 0x80 ? 1 << ((fflags & 0x07) + 1) : 0;
        let lct: Uint8Array | null = null;
        if (lctSize) {
          lct = bytes.subarray(pos, pos + lctSize * 3);
          pos += lctSize * 3;
        }
        const palette = lct ?? gct;
        if (!palette) break;

        // LZW minimum code size.
        const minCodeSize = bytes[pos++];

        // Read all sub-blocks of LZW data.
        const lzwData: number[] = [];
        let blockSize = bytes[pos++];
        while (blockSize > 0 && pos < bytes.length) {
          for (let i = 0; i < blockSize; i++) lzwData.push(bytes[pos + i]);
          pos += blockSize;
          blockSize = bytes[pos++];
        }

        // Decode LZW.
        const indices = lzwDecode(new Uint8Array(lzwData), minCodeSize);

        // Save state before compositing (for "restore to previous" disposal).
        if (disposal === 3) snapshot = ctx.getImageData(0, 0, W, H);

        // Composite the frame's pixels onto the master ImageData.
        const px = master.data;
        for (let y = 0; y < fh; y++) {
          for (let x = 0; x < fw; x++) {
            const idx = indices[y * fw + x];
            const di = (idx << 1) + idx; // idx * 3
            const pi = ((top + y) * W + left + x) * 4;
            if (transparent && idx === transparentIndex) {
              // Leave the pixel as-is (transparent).
              continue;
            }
            px[pi] = palette[di];
            px[pi + 1] = palette[di + 1];
            px[pi + 2] = palette[di + 2];
            px[pi + 3] = 255;
          }
        }

        ctx.putImageData(master, 0, 0);
        frames.push({ data: ctx.getImageData(0, 0, W, H), delay });

        // Apply disposal after the frame.
        if (disposal === 2) {
          // Restore to background: clear the frame's area.
          ctx.clearRect(left, top, fw, fh);
          master = ctx.getImageData(0, 0, W, H);
        } else if (disposal === 3 && snapshot) {
          // Restore to previous.
          master = snapshot;
          ctx.putImageData(master, 0, 0);
        }

        frameCount++;
      } else {
        // Skip other extensions (comment, application, plain text).
        let size = bytes[pos++];
        while (size > 0 && pos < bytes.length) {
          pos += size;
          size = bytes[pos++];
        }
      }
    } else if (byte === 0x2c) {
      // An Image Descriptor without a preceding GCE (no delay/disposal).
      pos++; // past 0x2c
      const left = bytes[pos] | (bytes[pos + 1] << 8);
      const top = bytes[pos + 2] | (bytes[pos + 3] << 8);
      const fw = bytes[pos + 4] | (bytes[pos + 5] << 8);
      const fh = bytes[pos + 6] | (bytes[pos + 7] << 8);
      const fflags = bytes[pos + 8];
      pos += 9;
      const lctSize = fflags & 0x80 ? 1 << ((fflags & 0x07) + 1) : 0;
      let lct: Uint8Array | null = null;
      if (lctSize) {
        lct = bytes.subarray(pos, pos + lctSize * 3);
        pos += lctSize * 3;
      }
      const palette = lct ?? gct;
      if (!palette) break;
      const minCodeSize = bytes[pos++];
      const lzwData: number[] = [];
      let blockSize = bytes[pos++];
      while (blockSize > 0 && pos < bytes.length) {
        for (let i = 0; i < blockSize; i++) lzwData.push(bytes[pos + i]);
        pos += blockSize;
        blockSize = bytes[pos++];
      }
      const indices = lzwDecode(new Uint8Array(lzwData), minCodeSize);
      const px = master.data;
      for (let y = 0; y < fh; y++) {
        for (let x = 0; x < fw; x++) {
          const idx = indices[y * fw + x];
          const di = (idx << 1) + idx;
          const pi = ((top + y) * W + left + x) * 4;
          if (idx >= 0 && di + 2 < palette.length) {
            px[pi] = palette[di];
            px[pi + 1] = palette[di + 1];
            px[pi + 2] = palette[di + 2];
            px[pi + 3] = 255;
          }
        }
      }
      ctx.putImageData(master, 0, 0);
      frames.push({ data: ctx.getImageData(0, 0, W, H), delay: 100 });
      frameCount++;
    } else if (byte === 0x3b) {
      // Trailer.
      break;
    } else {
      pos++;
    }
  }

  return frames.length > 0 ? frames : [];
}

/**
 * LZW decode for GIF: reads variable-length codes from the byte stream,
 * building the dictionary as it goes, and outputs palette indices.
 */
function lzwDecode(data: Uint8Array, minCodeSize: number): Uint8Array {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let dict: number[][] = [];

  const reset = () => {
    dict = [];
    for (let i = 0; i < clearCode; i++) dict.push([i]);
    dict[clearCode] = []; // clear
    dict[endCode] = []; // end
    codeSize = minCodeSize + 1;
  };
  reset();

  const out: number[] = [];
  let bitPos = 0;
  let prev: number[] | null = null;

  const readCode = () => {
    let byte = bitPos >> 3;
    let bit = bitPos & 7;
    let code = 0;
    for (let i = 0; i < codeSize; i++) {
      if (byte >= data.length) return -1;
      code |= ((data[byte] >> bit) & 1) << i;
      bit++;
      if (bit === 8) {
        bit = 0;
        byte++;
      }
    }
    bitPos += codeSize;
    return code;
  };

  let code = readCode();
  while (code !== endCode && code !== -1) {
    if (code === clearCode) {
      reset();
      prev = null;
      code = readCode();
      continue;
    }
    let entry: number[];
    if (code < dict.length) {
      entry = dict[code];
    } else if (prev) {
      entry = [...prev, prev[0]];
    } else {
      break;
    }
    out.push(...entry);
    if (prev) {
      dict.push([...prev, entry[0]]);
      if (dict.length === 1 << codeSize && codeSize < 12) codeSize++;
    }
    prev = entry;
    code = readCode();
  }

  return new Uint8Array(out);
}
