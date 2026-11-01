// Phase 0 smoke test: init the cascade, process one known-good JPEG, verify
// the output is 295x413 with the expected 10-byte trailer, then repeat the
// run on a derived JPEG carrying an EXIF Orientation=6 tag to prove the
// decoder ignores EXIF orientation (matching the original tool).
//
// Run from anywhere:
//   node tests/smoke.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import createPhotoModule from '../web/pkg/photo.js';
import { readJpegSize, withExifOrientation, OUTPUT_TRAILER } from './jpeg.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const mod = await createPhotoModule();

// wasm alloc failures are silent (null pointer) unless checked explicitly.
function alloc(bytes, label) {
  const ptr = mod._photo_alloc(bytes.length);
  if (!ptr) {
    throw new Error(`wasm alloc failed (${label}, ${bytes.length} bytes)`);
  }
  mod.HEAPU8.set(bytes, ptr);
  return ptr;
}

function processJpeg(bytes) {
  const ptr = alloc(bytes, 'JPEG input');
  const started = performance.now();
  const code = mod._photo_process(ptr, bytes.length);
  const elapsedMs = performance.now() - started;
  mod._photo_free(ptr, bytes.length);
  return { code, elapsedMs };
}

function copyOutput() {
  const len = mod._photo_output_len();
  if (len === 0) throw new Error('wasm produced no output');
  const ptr = mod._photo_output_ptr();
  // HEAPU8.slice returns a Uint8Array; wrap it so Buffer's byte comparison is
  // available (and so the copy is already detached from wasm memory).
  return Buffer.from(mod.HEAPU8.slice(ptr, ptr + len));
}

// Read the frame size straight from the output's SOF0/SOF2 segment (shared
// with run_wasm.mjs), so the assertion does not depend on the getters agreeing
// with the encoded bytes.

const xml = fs.readFileSync(
  path.join(ROOT, 'web/assets/haarcascade_frontalface_alt2.xml'),
);
let ptr = alloc(xml, 'cascade XML');
const tInit = performance.now();
const ok = mod._photo_init_cascade(ptr, xml.length);
const initMs = performance.now() - tInit;
mod._photo_free(ptr, xml.length);
if (!ok) throw new Error('cascade init failed');

const jpg = fs.readFileSync(
  path.join(ROOT, 'tests/fixtures/jpg/p2_blue.jpg'),
);
const p2 = processJpeg(jpg);
if (p2.code !== 0) throw new Error(`p2_blue code=${p2.code}`);
const p2InputW = mod._photo_input_w();
const p2InputH = mod._photo_input_h();
const p2FaceW = mod._photo_face_w();
const p2FaceH = mod._photo_face_h();
const p2Crop = [
  mod._photo_crop_x(),
  mod._photo_crop_y(),
  mod._photo_crop_w(),
  mod._photo_crop_h(),
];
const p2Bg = mod._photo_bg_class();

const out = copyOutput();
if (out[0] !== 0xff || out[1] !== 0xd8) throw new Error('not jpeg');
if (!out.subarray(-OUTPUT_TRAILER.length).equals(OUTPUT_TRAILER)) {
  throw new Error('bad trailer');
}

const sof = readJpegSize(out);
if (sof.width !== 295 || sof.height !== 413) {
  throw new Error(
    `SOF says ${sof.width}x${sof.height}, expected 295x413`,
  );
}
const outW = mod._photo_output_w();
const outH = mod._photo_output_h();
if (outW !== 295 || outH !== 413) {
  throw new Error(`bad size getters ${outW}x${outH}, expected 295x413`);
}

// Derived EXIF fixture: p2_blue's stored size is 1024x1536. With Orientation=6
// a decoder that honours EXIF would rotate it to 1536x1024; ignoring EXIF
// (the original tool's behavior) must keep the stored dimensions and produce
// exactly the same output bytes.
const exifJpg = withExifOrientation(jpg, 6);
const exif = processJpeg(exifJpg);
if (exif.code !== 0) throw new Error(`EXIF Orientation=6 code=${exif.code}`);
const exifInputW = mod._photo_input_w();
const exifInputH = mod._photo_input_h();
if (exifInputW !== 1024 || exifInputH !== 1536) {
  throw new Error(
    `EXIF orientation was not ignored: input=${exifInputW}x${exifInputH}, ` +
      'expected stored 1024x1536',
  );
}
const exifOut = copyOutput();
if (!exifOut.equals(out)) {
  throw new Error('EXIF-tagged input changed the output bytes');
}

console.log('smoke ok', out.length, outW, outH);
console.error(
  `timing init=${initMs.toFixed(0)}ms process=${p2.elapsedMs.toFixed(0)}ms ` +
    `exif=${exif.elapsedMs.toFixed(0)}ms ` +
    `input=${p2InputW}x${p2InputH} ` +
    `face=${p2FaceW}x${p2FaceH} ` +
    `crop=${p2Crop.join(',')} bg=${p2Bg} ` +
    `exif_input=${exifInputW}x${exifInputH}`,
);
