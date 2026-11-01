// Module worker: owns the wasm instance and the Haar cascade. The main thread
// never imports photo.js, so decoding/detection cannot block the UI.
import createPhotoModule from './pkg/photo.js';

const CASCADE_URL = new URL(
  './assets/haarcascade_frontalface_alt2.xml',
  import.meta.url,
);

let photoModule = null;
let initError = null;

function errorText(error) {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function copyError(mod) {
  const len = mod._photo_error_len();
  if (len === 0) return '';
  const ptr = mod._photo_error_ptr();
  return new TextDecoder().decode(mod.HEAPU8.slice(ptr, ptr + len));
}

async function fetchCascade() {
  const response = await fetch(CASCADE_URL);
  if (!response.ok) {
    throw new Error(`人脸检测模型加载失败（HTTP ${response.status}）`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function load() {
  // Both requests are independent; start them together to keep first paint
  // responsive while the 1.4 MB wasm and 861 KB cascade are fetched.
  const [mod, cascade] = await Promise.all([createPhotoModule(), fetchCascade()]);

  const ptr = mod._photo_alloc(cascade.length);
  if (ptr === 0) {
    throw new Error('人脸检测模型缓冲区分配失败');
  }
  try {
    mod.HEAPU8.set(cascade, ptr);
    if (mod._photo_init_cascade(ptr, cascade.length) !== 1) {
      throw new Error(copyError(mod) || '人脸检测模型初始化失败');
    }
  } finally {
    mod._photo_free(ptr, cascade.length);
  }

  photoModule = mod;
  return mod;
}

// Kick off initialization as soon as the worker is evaluated. The main thread
// still sends {type:'init'} so it can observe ready/init-error explicitly.
const initPromise = load().catch((error) => {
  initError = error;
});

async function ensureReady() {
  await initPromise;
  if (initError) throw initError;
  if (!photoModule) throw new Error('处理引擎未初始化');
  return photoModule;
}

function processBuffer(mod, buffer) {
  const bytes =
    buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer)
      : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  const inputPtr = bytes.length === 0 ? 0 : mod._photo_alloc(bytes.length);
  if (bytes.length > 0 && inputPtr === 0) {
    throw new Error('输入照片缓冲区分配失败');
  }
  if (inputPtr !== 0) mod.HEAPU8.set(bytes, inputPtr);

  let code;
  try {
    code = mod._photo_process(inputPtr, bytes.length);
  } finally {
    // photo_free only accepts buffers returned by photo_alloc. Output and
    // test buffers are owned by the C++ side and must never be freed here.
    if (inputPtr !== 0) mod._photo_free(inputPtr, bytes.length);
  }

  const outLen = code === 0 ? mod._photo_output_len() : 0;
  let out = new ArrayBuffer(0);
  if (outLen > 0) {
    const outPtr = mod._photo_output_ptr();
    // Copy immediately: the next photo_process call reuses this buffer.
    out = mod.HEAPU8.slice(outPtr, outPtr + outLen).buffer;
  }

  return {
    code,
    buffer: out,
    w: mod._photo_output_w(),
    h: mod._photo_output_h(),
    size: out.byteLength,
    face: [
      mod._photo_face_x(),
      mod._photo_face_y(),
      mod._photo_face_w(),
      mod._photo_face_h(),
    ],
    crop: [
      mod._photo_crop_x(),
      mod._photo_crop_y(),
      mod._photo_crop_w(),
      mod._photo_crop_h(),
    ],
    elapsed: 0,
    error: copyError(mod),
  };
}

self.addEventListener('message', async (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  if (data.type === 'init') {
    try {
      await ensureReady();
      self.postMessage({ type: 'ready' });
    } catch (error) {
      self.postMessage({ type: 'init-error', message: errorText(error) });
    }
    return;
  }

  if (data.type === 'process') {
    try {
      const mod = await ensureReady();
      const started = performance.now();
      const result = processBuffer(mod, data.buffer);
      result.elapsed = Math.round(performance.now() - started);
      self.postMessage(
        { type: 'result', ...result },
        result.buffer.byteLength > 0 ? [result.buffer] : [],
      );
    } catch (error) {
      self.postMessage({
        type: 'result',
        code: -1,
        buffer: new ArrayBuffer(0),
        w: 0,
        h: 0,
        size: 0,
        face: null,
        crop: null,
        elapsed: 0,
        error: errorText(error),
      });
    }
  }
});
