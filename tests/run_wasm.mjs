// Full Node-side integration test for the wasm photo pipeline.
//
// Covers: fixture decision codes, the p2 success payload (size, SOF, trailer,
// DQT, SSIM against the reference output), EXIF orientation handling, and the
// boundary inputs (too small, non-JPEG, truncated, empty, no face, 12MP).
//
// Run from anywhere:
//   node tests/run_wasm.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import createPhotoModule from '../web/pkg/photo.js';
import {
  readJpegSize,
  readJpegDqt,
  withExifOrientation,
  bgrToGray,
  ssimGray,
  OUTPUT_TRAILER,
} from './jpeg.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'tests/fixtures');

// Literal copy of the acceptance table: a silently edited manifest must not be
// able to weaken the test.
const EXPECTED_CODES = {
  p1_white: 4,
  p2_blue: 0,
  p3_warm: 3,
  p4_dim: 3,
  p5_red: 3,
  p6_fullbody: 4,
  p7_noface: 3,
  p8_two: 4,
};

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function fixturePath(relative) {
  return path.join(FIXTURES, relative);
}

function readFixture(relative) {
  return fs.readFileSync(fixturePath(relative));
}

const mod = await createPhotoModule();

// wasm alloc failures are silent (null pointer) unless checked explicitly.
function alloc(bytes, label) {
  if (bytes.length === 0) return 0;
  const ptr = mod._photo_alloc(bytes.length);
  if (ptr === 0) {
    throw new Error(`wasm alloc failed (${label}, ${bytes.length} bytes)`);
  }
  mod.HEAPU8.set(bytes, ptr);
  return ptr;
}

function copyError() {
  const len = mod._photo_error_len();
  if (len === 0) return '';
  const ptr = mod._photo_error_ptr();
  return Buffer.from(mod.HEAPU8.slice(ptr, ptr + len)).toString('utf8');
}

// Run photo_process and copy every buffer/metadata value immediately. The C++
// side reuses all of these on the next call, so no pointer or view is allowed
// to escape this function.
function runOn(bytes, label) {
  const ptr = alloc(bytes, label);
  const started = performance.now();
  const code = mod._photo_process(ptr, bytes.length);
  const elapsedMs = performance.now() - started;
  if (ptr !== 0) mod._photo_free(ptr, bytes.length);

  const outLen = mod._photo_output_len();
  const outPtr = mod._photo_output_ptr();
  const output =
    outLen === 0
      ? Buffer.alloc(0)
      : Buffer.from(mod.HEAPU8.slice(outPtr, outPtr + outLen));

  return {
    label,
    code,
    elapsedMs,
    output,
    error: copyError(),
    inputW: mod._photo_input_w(),
    inputH: mod._photo_input_h(),
    outputW: mod._photo_output_w(),
    outputH: mod._photo_output_h(),
    bgClass: mod._photo_bg_class(),
    faceW: mod._photo_face_w(),
    faceH: mod._photo_face_h(),
  };
}

function decodeForTest(bytes, label) {
  const ptr = alloc(bytes, label);
  const ok = mod._photo_test_decode(ptr, bytes.length) === 1;
  if (ptr !== 0) mod._photo_free(ptr, bytes.length);

  const width = mod._photo_test_bgr_w();
  const height = mod._photo_test_bgr_h();
  const bgrPtr = mod._photo_test_bgr_ptr();
  const bgr = ok
    ? Buffer.from(
        mod.HEAPU8.slice(bgrPtr, bgrPtr + width * height * 3),
      )
    : Buffer.alloc(0);
  return { ok, width, height, bgr, error: ok ? '' : copyError() };
}

function describe(result) {
  const detail = result.error ? ` error="${result.error}"` : '';
  return (
    `${result.label}: code=${result.code} ` +
    `input=${result.inputW}x${result.inputH} ` +
    `output=${result.outputW}x${result.outputH} ` +
    `bg=${result.bgClass} bytes=${result.output.length}${detail}`
  );
}

function expectCode(result, expected) {
  check(
    result.code === expected,
    `${describe(result)}; expected code ${expected}`,
  );
}

function expectRejected(result) {
  check(
    result.output.length === 0,
    `${describe(result)}; a rejected input must not leave output bytes`,
  );
}

function compareDqt(actual, expected, label) {
  check(
    actual.length === expected.length,
    `${label}: found ${actual.length} DQT table(s), reference has ` +
      `${expected.length}`,
  );
  for (let t = 0; t < actual.length; t += 1) {
    const a = actual[t];
    const e = expected[t];
    check(
      a.tableId === e.tableId && a.precision === e.precision,
      `${label}: DQT table ${t} is id=${a.tableId}/precision=${a.precision}, ` +
        `reference is id=${e.tableId}/precision=${e.precision}`,
    );
    for (let k = 0; k < 64; k += 1) {
      check(
        a.values[k] === e.values[k],
        `${label}: DQT table ${a.tableId} zigzag[${k}] is ${a.values[k]}, ` +
          `reference is ${e.values[k]}`,
      );
    }
  }
}

function assertJpegEnvelope(output, label) {
  check(
    output.length >= 4 && output[0] === 0xff && output[1] === 0xd8,
    `${label}: output does not start with FF D8`,
  );
  check(
    output.subarray(-OUTPUT_TRAILER.length).equals(OUTPUT_TRAILER),
    `${label}: output does not end with the 10-byte trailer`,
  );
}

// ---------------------------------------------------------------------------
// 1. Cascade.
// ---------------------------------------------------------------------------
const xml = fs.readFileSync(
  path.join(ROOT, 'web/assets/haarcascade_frontalface_alt2.xml'),
);
const xmlPtr = alloc(xml, 'cascade XML');
const initStarted = performance.now();
const initOk = mod._photo_init_cascade(xmlPtr, xml.length);
const initMs = performance.now() - initStarted;
mod._photo_free(xmlPtr, xml.length);
check(initOk === 1, `cascade init failed: ${copyError() || 'no message'}`);

// ---------------------------------------------------------------------------
// 2. The eight baseline fixtures must match the manifest.
// ---------------------------------------------------------------------------
const manifest = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, 'manifest.json'), 'utf8'),
);
check(
  Array.isArray(manifest.cases) && manifest.cases.length === 8,
  `manifest.json must contain 8 cases, found ${
    Array.isArray(manifest.cases) ? manifest.cases.length : 'none'
  }`,
);

const seenNames = new Set();
const codeSummary = [];
for (const testCase of manifest.cases) {
  const expected = EXPECTED_CODES[testCase.name];
  check(
    expected !== undefined,
    `manifest.json has an unexpected case "${testCase.name}"`,
  );
  check(
    !seenNames.has(testCase.name),
    `manifest.json lists "${testCase.name}" more than once`,
  );
  seenNames.add(testCase.name);
  check(
    testCase.expected && testCase.expected.code === expected,
    `manifest.json says ${testCase.name} => ${testCase.expected?.code}, ` +
      `acceptance table says ${expected}`,
  );

  const bytes = readFixture(testCase.input);
  const result = runOn(bytes, testCase.name);
  expectCode(result, expected);
  if (expected !== 0) expectRejected(result);
  codeSummary.push(`${testCase.name}=${result.code}`);
}
check(
  seenNames.size === Object.keys(EXPECTED_CODES).length,
  `manifest.json covers ${seenNames.size}/8 expected fixtures`,
);

// ---------------------------------------------------------------------------
// 3. p2 success payload, DQT and SSIM against the reference output.
// ---------------------------------------------------------------------------
const p2Bytes = readFixture('jpg/p2_blue.jpg');
const p2SourceSize = readJpegSize(p2Bytes);
check(
  p2SourceSize.width === 1024 && p2SourceSize.height === 1536,
  `p2_blue.jpg is ${p2SourceSize.width}x${p2SourceSize.height}, expected ` +
    '1024x1536',
);

const p2 = runOn(p2Bytes, 'p2_blue');
expectCode(p2, 0);
assertJpegEnvelope(p2.output, 'p2_blue');
check(
  p2.inputW === 1024 && p2.inputH === 1536,
  `p2_blue input metadata is ${p2.inputW}x${p2.inputH}, expected 1024x1536`,
);
check(
  p2.outputW === 295 && p2.outputH === 413,
  `p2_blue output metadata is ${p2.outputW}x${p2.outputH}, expected 295x413`,
);

const p2Sof = readJpegSize(p2.output);
check(
  p2Sof.width === 295 && p2Sof.height === 413,
  `p2_blue SOF says ${p2Sof.width}x${p2Sof.height}, expected 295x413`,
);
check(
  p2.output.length > 5 * 1024 && p2.output.length < 15 * 1024,
  `p2_blue output is ${p2.output.length} bytes, expected between 5KB and 15KB`,
);

const referenceBytes = fs.readFileSync(
  path.join(ROOT, 'tests/reference/p2_blue_reference.jpg'),
);
const p2Dqt = readJpegDqt(p2.output);
const referenceDqt = readJpegDqt(referenceBytes);
compareDqt(p2Dqt, referenceDqt, 'p2_blue');
check(
  p2Dqt.length > 0,
  'p2_blue output has no DQT tables; cannot verify the q40 tables',
);

const decodedOutput = decodeForTest(p2.output, 'p2 output');
check(
  decodedOutput.ok,
  `photo_test_decode failed on the p2 output: ${decodedOutput.error}`,
);
const decodedReference = decodeForTest(referenceBytes, 'p2 reference');
check(
  decodedReference.ok,
  `photo_test_decode failed on the reference: ${decodedReference.error}`,
);
check(
  decodedOutput.width === decodedReference.width &&
    decodedOutput.height === decodedReference.height,
  `decoded sizes differ: output ${decodedOutput.width}x${decodedOutput.height}, ` +
    `reference ${decodedReference.width}x${decodedReference.height}`,
);

const ssim = ssimGray(
  bgrToGray(decodedOutput.bgr, decodedOutput.width, decodedOutput.height),
  bgrToGray(decodedReference.bgr, decodedReference.width, decodedReference.height),
  decodedOutput.width,
  decodedOutput.height,
);
check(
  ssim >= 0.95,
  `p2_blue SSIM is ${ssim.toFixed(4)}, expected >= 0.95 (do not lower the ` +
    'threshold without investigating the diff)',
);

// ---------------------------------------------------------------------------
// 4. EXIF Orientation=6 must be ignored (stored orientation wins).
// ---------------------------------------------------------------------------
const exifBytes = withExifOrientation(p2Bytes, 6);
check(
  exifBytes[2] === 0xff && exifBytes[3] === 0xe1,
  'withExifOrientation did not insert an APP1 segment right after SOI',
);
check(
  exifBytes.includes(
    Buffer.from([
      0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00,
      0x00,
    ]),
  ),
  'withExifOrientation did not write the Orientation=6 IFD entry',
);
// Re-tagging must replace the existing APP1 instead of stacking another one.
const retagged = withExifOrientation(exifBytes, 3);
check(
  retagged.length === exifBytes.length,
  `withExifOrientation stacked APP1 segments (${retagged.length} vs ` +
    `${exifBytes.length} bytes)`,
);
check(
  retagged[30] === 3,
  `withExifOrientation left orientation byte ${retagged[30]}, expected 3`,
);
const exifStoredSize = readJpegSize(exifBytes);
check(
  exifStoredSize.width === 1024 && exifStoredSize.height === 1536,
  `the EXIF-tagged fixture says ${exifStoredSize.width}x` +
    `${exifStoredSize.height}, expected stored 1024x1536`,
);

const exif = runOn(exifBytes, 'p2_blue + EXIF Orientation=6');
expectCode(exif, 0);
check(
  exif.inputW === 1024 && exif.inputH === 1536,
  `EXIF orientation was not ignored: decoded input is ${exif.inputW}x` +
    `${exif.inputH}, expected the stored 1024x1536`,
);
check(
  exif.output.equals(p2.output),
  'EXIF Orientation=6 changed the output bytes; the tag must be ignored',
);

// ---------------------------------------------------------------------------
// 5. Boundary inputs.
// ---------------------------------------------------------------------------
const small = runOn(readFixture('small/200x300.jpg'), 'small/200x300');
expectCode(small, 2);
expectRejected(small);
check(
  small.inputW === 200 && small.inputH === 300,
  `small/200x300 decoded as ${small.inputW}x${small.inputH}`,
);
check(small.bgClass === -1, `small/200x300 reached background sampling`);

const notJpeg = runOn(readFixture('bad/notjpeg.jpg'), 'bad/notjpeg');
expectCode(notJpeg, 1);
expectRejected(notJpeg);
check(
  notJpeg.inputW === 0 && notJpeg.inputH === 0,
  `non-JPEG input has decoded metadata ${notJpeg.inputW}x${notJpeg.inputH}`,
);
check(notJpeg.bgClass === -1, 'non-JPEG input reached background sampling');

const truncated = runOn(
  readFixture('corrupt/truncated.jpg'),
  'corrupt/truncated',
);
expectCode(truncated, 1);
expectRejected(truncated);
check(
  truncated.inputW === 0 && truncated.inputH === 0,
  `truncated input has decoded metadata ${truncated.inputW}x` +
    `${truncated.inputH}; a partially decoded frame must not be used`,
);
check(truncated.bgClass === -1, 'truncated input reached background sampling');

const empty = runOn(Buffer.alloc(0), 'empty input');
expectCode(empty, 1);
expectRejected(empty);
check(
  empty.inputW === 0 && empty.inputH === 0,
  `empty input has decoded metadata ${empty.inputW}x${empty.inputH}`,
);

const flat = runOn(readFixture('flat/blue_400x600.jpg'), 'flat/blue_400x600');
expectCode(flat, 5);
expectRejected(flat);
check(
  flat.inputW === 400 && flat.inputH === 600,
  `flat/blue_400x600 decoded as ${flat.inputW}x${flat.inputH}`,
);
check(
  flat.bgClass === 1,
  `flat/blue_400x600 background class is ${flat.bgClass}, expected blue (1)`,
);
check(
  flat.faceW === 0 && flat.faceH === 0,
  'flat/blue_400x600 reported a face without one being present',
);

const large = runOn(readFixture('large/p2_blue_12mp.jpg'), 'large/12MP');
expectCode(large, 0);
check(
  large.inputW === 3000 && large.inputH === 4500,
  `large fixture decoded as ${large.inputW}x${large.inputH}, expected 3000x4500`,
);
check(
  large.outputW === 295 && large.outputH === 413,
  `large output metadata is ${large.outputW}x${large.outputH}, expected 295x413`,
);
assertJpegEnvelope(large.output, 'large/12MP');
const largeSof = readJpegSize(large.output);
check(
  largeSof.width === 295 && largeSof.height === 413,
  `large SOF says ${largeSof.width}x${largeSof.height}, expected 295x413`,
);

// ---------------------------------------------------------------------------
// 6. Summary.
// ---------------------------------------------------------------------------
const largeRisk =
  large.elapsedMs > 30000
    ? ` [RISK: ${(large.elapsedMs / 1000).toFixed(1)}s > 30s budget]`
    : '';

console.log('wasm integration ok');
console.log(`fixtures: 8/8 match manifest (${codeSummary.join(', ')})`);
console.log(
  `p2: ${p2.outputW}x${p2.outputH}, ${p2.output.length}B, SOI ok, trailer ok, ` +
    `DQT ${p2Dqt.length} table(s) match reference ` +
    `(luma zigzag[0..7]=${p2Dqt[0].values.slice(0, 8).join(',')}), ` +
    `SSIM=${ssim.toFixed(6)}`,
);
console.log(
  `exif: input=${exif.inputW}x${exif.inputH} stored orientation kept, ` +
    'output identical to the untagged run',
);
console.log(
  `boundaries: small=${small.code}, notjpeg=${notJpeg.code}, ` +
    `truncated=${truncated.code}, empty=${empty.code}, ` +
    `flat=${flat.code} (bg=${flat.bgClass}), large=${large.code} ` +
    `(${large.outputW}x${large.outputH})`,
);
console.log(
  `timing: init=${initMs.toFixed(0)}ms p2=${p2.elapsedMs.toFixed(0)}ms ` +
    `exif=${exif.elapsedMs.toFixed(0)}ms ` +
    `large=${large.elapsedMs.toFixed(0)}ms${largeRisk}`,
);
