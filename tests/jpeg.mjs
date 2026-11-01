// Small, dependency-free JPEG inspection helpers shared by the Node tests.
//
// These functions deliberately parse the byte stream instead of trusting the
// wasm getters, so an assertion failure points at the encoded output rather
// than at a stale metadata mirror.

// Trailer appended by photo_process after the JPEG stream: FF 02 00 08 plus the
// ASCII marker "gjgwy2". Shared so both tests compare against one definition.
export const OUTPUT_TRAILER = Buffer.from([
  0xff, 0x02, 0x00, 0x08, 0x67, 0x6a, 0x67, 0x77, 0x79, 0x32,
]);

function assertJpegStart(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    throw new Error('not a JPEG: missing SOI marker');
  }
}

function isStandaloneMarker(marker) {
  return (
    marker === 0x01 ||
    marker === 0xd8 ||
    marker === 0xd9 ||
    (marker >= 0xd0 && marker <= 0xd7)
  );
}

function isSofMarker(marker) {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 && // DHT
    marker !== 0xc8 && // JPG
    marker !== 0xcc // DAC
  );
}

// Read the frame size from the first SOF segment (SOF0/SOF1/SOF2/...).
export function readJpegSize(buf) {
  assertJpegStart(buf);
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) {
      throw new Error(`malformed JPEG: expected a marker at byte ${i}`);
    }
    const marker = buf[i + 1];
    if (isStandaloneMarker(marker)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const length = (buf[i + 2] << 8) | buf[i + 3];
    if (length < 2 || i + 2 + length > buf.length) {
      throw new Error(`malformed JPEG segment at byte ${i}`);
    }
    if (isSofMarker(marker)) {
      if (length < 7) {
        throw new Error(`SOF segment at byte ${i} is too short`);
      }
      const height = (buf[i + 5] << 8) | buf[i + 6];
      const width = (buf[i + 7] << 8) | buf[i + 8];
      return { marker, width, height };
    }
    i += 2 + length;
  }
  throw new Error('no SOF marker found in JPEG');
}

// Parse every DQT segment. Values stay in the on-disk zigzag order so a
// comparison against the reference file is a plain byte/array equality check.
export function readJpegDqt(buf) {
  assertJpegStart(buf);
  const tables = [];
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) {
      throw new Error(`malformed JPEG: expected a marker at byte ${i}`);
    }
    const marker = buf[i + 1];
    if (isStandaloneMarker(marker)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const length = (buf[i + 2] << 8) | buf[i + 3];
    if (length < 2 || i + 2 + length > buf.length) {
      throw new Error(`malformed JPEG segment at byte ${i}`);
    }
    if (marker === 0xdb) {
      let p = i + 4;
      const end = i + 2 + length;
      while (p + 1 <= end) {
        const info = buf[p];
        const precision = info >> 4;
        const tableId = info & 0x0f;
        if (precision > 1) {
          throw new Error(`unsupported DQT precision ${precision}`);
        }
        const bytesPerValue = precision === 0 ? 1 : 2;
        const size = 64 * bytesPerValue;
        if (p + 1 + size > end) {
          throw new Error(`truncated DQT table ${tableId} at byte ${p}`);
        }
        const values = new Array(64);
        for (let k = 0; k < 64; k += 1) {
          const off = p + 1 + k * bytesPerValue;
          values[k] =
            bytesPerValue === 1 ? buf[off] : (buf[off] << 8) | buf[off + 1];
        }
        tables.push({ tableId, precision, values });
        p += 1 + size;
      }
      if (p !== end) {
        throw new Error(`malformed DQT segment at byte ${i}`);
      }
    }
    i += 2 + length;
  }
  return tables;
}

// Copy every segment up to (and excluding) SOS, dropping APP1 (EXIF/XMP).
// Entropy-coded data after SOS is copied verbatim.
function withoutApp1(jpeg) {
  assertJpegStart(jpeg);
  const parts = [jpeg.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= jpeg.length) {
    if (jpeg[i] !== 0xff) {
      throw new Error(`malformed JPEG: expected a marker at byte ${i}`);
    }
    const marker = jpeg[i + 1];
    if (marker === 0xda) {
      parts.push(jpeg.subarray(i));
      return Buffer.concat(parts);
    }
    if (isStandaloneMarker(marker)) {
      parts.push(jpeg.subarray(i, i + 2));
      i += 2;
      continue;
    }
    const length = (jpeg[i + 2] << 8) | jpeg[i + 3];
    if (length < 2 || i + 2 + length > jpeg.length) {
      throw new Error(`malformed JPEG segment at byte ${i}`);
    }
    if (marker !== 0xe1) parts.push(jpeg.subarray(i, i + 2 + length));
    i += 2 + length;
  }
  throw new Error('no SOS marker found in JPEG');
}

// Build a minimal EXIF APP1 segment: "Exif\0\0", little-endian TIFF header,
// one IFD0 entry (Orientation, SHORT, count 1, value), no next IFD. The
// segment length covers the payload plus its own two bytes (32 + 2 = 0x0022).
function exifOrientationSegment(orientation) {
  if (!Number.isInteger(orientation) || orientation < 1 || orientation > 8) {
    throw new Error(`invalid EXIF orientation ${orientation}`);
  }
  return Buffer.from([
    0xff, 0xe1, 0x00, 0x22,
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
    0x01, 0x00,
    0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00,
    orientation & 0xff, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ]);
}

// Remove existing APP1 segments, then insert a new EXIF Orientation tag right
// after SOI. Returns a Buffer; the input buffer is not modified.
export function withExifOrientation(jpeg, orientation) {
  const stripped = withoutApp1(jpeg);
  return Buffer.concat([
    stripped.subarray(0, 2),
    exifOrientationSegment(orientation),
    stripped.subarray(2),
  ]);
}

// BGR8 (OpenCV channel order) to 8-bit luma using the ITU-R BT.601 weights.
export function bgrToGray(bgr, width, height) {
  const pixels = width * height;
  if (bgr.length !== pixels * 3) {
    throw new Error(
      `BGR buffer is ${bgr.length} bytes, expected ${pixels * 3} for ` +
        `${width}x${height}`,
    );
  }
  const gray = new Uint8Array(pixels);
  for (let p = 0, i = 0; p < pixels; p += 1, i += 3) {
    gray[p] = Math.round(
      0.114 * bgr[i] + 0.587 * bgr[i + 1] + 0.299 * bgr[i + 2],
    );
  }
  return gray;
}

// Sliding-window grayscale SSIM (8x8 window, stride 4). The formula and the
// stabilization constants C1/C2 follow the original SSIM paper with the usual
// 8-bit dynamic range. Windows are clipped at the image border.
export function ssimGray(grayA, grayB, width, height, options = {}) {
  const windowSize = options.windowSize ?? 8;
  const stride = options.stride ?? 4;
  if (grayA.length !== width * height || grayB.length !== width * height) {
    throw new Error('SSIM inputs do not match the given dimensions');
  }
  if (width < windowSize || height < windowSize) {
    throw new Error(
      `image ${width}x${height} is smaller than the ${windowSize}x${windowSize} ` +
        'SSIM window',
    );
  }

  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;

  const positions = (size) => {
    const out = [];
    for (let p = 0; p + windowSize <= size; p += stride) out.push(p);
    const last = size - windowSize;
    if (out[out.length - 1] !== last) out.push(last);
    return out;
  };
  const xs = positions(width);
  const ys = positions(height);

  let total = 0;
  let count = 0;
  const n = windowSize * windowSize;
  for (const y0 of ys) {
    for (const x0 of xs) {
      let sumA = 0;
      let sumB = 0;
      let sumAA = 0;
      let sumBB = 0;
      let sumAB = 0;
      for (let y = y0; y < y0 + windowSize; y += 1) {
        const row = y * width;
        for (let x = x0; x < x0 + windowSize; x += 1) {
          const a = grayA[row + x];
          const b = grayB[row + x];
          sumA += a;
          sumB += b;
          sumAA += a * a;
          sumBB += b * b;
          sumAB += a * b;
        }
      }
      const meanA = sumA / n;
      const meanB = sumB / n;
      const varA = Math.max(0, sumAA / n - meanA * meanA);
      const varB = Math.max(0, sumBB / n - meanB * meanB);
      const cov = sumAB / n - meanA * meanB;
      total +=
        ((2 * meanA * meanB + c1) * (2 * cov + c2)) /
        ((meanA * meanA + meanB * meanB + c1) * (varA + varB + c2));
      count += 1;
    }
  }
  return total / count;
}
