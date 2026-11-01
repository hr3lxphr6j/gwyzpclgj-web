// Main thread: file selection, state machine, preview and download. All image
// work happens in worker.js; this file only moves bytes and updates the DOM.
import { MESSAGES } from './messages.js';

const fileInput = document.getElementById('file-input');
const drop = document.getElementById('drop');
const statusEl = document.getElementById('status');
const errorEl = document.getElementById('error');
const resultEl = document.getElementById('result');
const previewEl = document.getElementById('preview');
const metaEl = document.getElementById('meta');
const downloadEl = document.getElementById('download');

const isTestMode = new URLSearchParams(window.location.search).get('test') === '1';

const INIT_TIMEOUT_MS = 45000;
// The 13.5 MP fixture finishes in ~1 s; 60 s means a hung worker, not a slow photo.
const PROCESS_TIMEOUT_MS = 60000;

// loading -> idle -> processing -> success | error
let phase = 'loading';
let previewUrl = '';
let pending = null;
let worker = null;

let initSettled = false;
let engineReady = false;
let engineFailed = false;
let initTimer = null;
let resolveReady = null;
let rejectReady = null;
let ready = null;

function resetReady() {
  ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // The UI also renders this rejection; this catch only prevents an unhandled
  // rejection when no file was chosen before initialization failed.
  ready.catch(() => {});
}

resetReady();

function setStatus(text, state) {
  statusEl.textContent = text;
  statusEl.dataset.state = state;
}

function showError(text) {
  errorEl.textContent = text;
  errorEl.hidden = false;
}

function clearError() {
  errorEl.textContent = '';
  errorEl.hidden = true;
}

function clearResult() {
  resultEl.hidden = true;
  metaEl.textContent = '';
  downloadEl.removeAttribute('href');
  previewEl.removeAttribute('src');
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
    previewUrl = '';
  }
}

function setInteractive(enabled) {
  fileInput.disabled = !enabled;
  drop.classList.toggle('is-disabled', !enabled);
  drop.setAttribute('aria-disabled', enabled ? 'false' : 'true');
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return `${kb >= 100 ? Math.round(kb) : kb.toFixed(1)} KB`;
}

function markReady() {
  if (initSettled) return;
  initSettled = true;
  engineReady = true;
  clearTimeout(initTimer);
  initTimer = null;
  resolveReady();
  if (phase === 'loading') {
    phase = 'idle';
    setStatus('选择一张 JPG 照片开始处理', 'idle');
    setInteractive(true);
  }
}

function markInitFailed(error) {
  if (initSettled) return;
  initSettled = true;
  engineFailed = true;
  // A failed init would otherwise keep fetching/compiling the 2.3 MB
  // wasm + cascade in the background.
  disposeWorker();
  rejectReady(error);
  if (phase === 'loading') {
    phase = 'error';
    setStatus('处理引擎加载失败', 'error');
    showError(`处理失败：${error.message}`);
    setInteractive(false);
  }
  if (pending) {
    const request = pending;
    pending = null;
    clearTimeout(request.timer);
    request.reject(error);
  }
}

function failAfterReady(error) {
  engineFailed = true;
  engineReady = false;
  const wasProcessing = Boolean(pending);
  if (pending) {
    const request = pending;
    pending = null;
    clearTimeout(request.timer);
    request.reject(error);
  }
  disposeWorker();
  // While processing, handleFile's catch renders the same failure. If the
  // worker dies while idle, no request will report it, so surface it here.
  if (!wasProcessing) {
    const hasResult = phase === 'success' && !resultEl.hidden;
    phase = 'error';
    setStatus('处理引擎已停止', 'error');
    // Do not show a bare "failed" next to a still-visible "处理成功" card:
    // explain that the existing result can still be saved.
    showError(
      hasResult
        ? '处理引擎已停止；已有结果仍可保存。刷新页面后可继续处理。'
        : '处理引擎已停止；刷新页面后可继续处理。',
    );
    setInteractive(false);
  }
}

function disposeWorker() {
  clearTimeout(initTimer);
  initTimer = null;
  if (worker) {
    // terminate() stops in-flight wasm/cascade loading; it never fires an
    // error event, so callers must settle any pending request themselves.
    worker.terminate();
    worker = null;
  }
}

function startWorker() {
  disposeWorker();
  initSettled = false;
  engineReady = false;
  engineFailed = false;
  resetReady();

  let spawned;
  try {
    spawned = new Worker(new URL('./worker.js', import.meta.url), {
      type: 'module',
    });
  } catch (error) {
    markInitFailed(error instanceof Error ? error : new Error(String(error)));
    return;
  }
  worker = spawned;

  initTimer = setTimeout(() => {
    markInitFailed(new Error('处理引擎加载超时'));
  }, INIT_TIMEOUT_MS);

  spawned.addEventListener('message', (event) => {
    if (worker !== spawned) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;

    if (data.type === 'ready') {
      markReady();
      return;
    }
    if (data.type === 'init-error') {
      markInitFailed(new Error(data.message || '处理引擎初始化失败'));
      return;
    }
    if (data.type === 'result') {
      const request = pending;
      pending = null;
      if (request) {
        clearTimeout(request.timer);
        request.resolve(data);
      }
    }
  });

  spawned.addEventListener('error', (event) => {
    if (worker !== spawned) return;
    // The worker is dead at this point; do not fall back to the main thread.
    event.preventDefault();
    const error = new Error(event.message || '处理引擎加载失败');
    if (!engineReady) markInitFailed(error);
    else failAfterReady(error);
  });

  spawned.addEventListener('messageerror', () => {
    if (worker !== spawned) return;
    const error = new Error('处理引擎返回了无法读取的数据');
    if (!engineReady) markInitFailed(error);
    else failAfterReady(error);
  });

  spawned.postMessage({ type: 'init' });
}

function restartEngine() {
  phase = 'loading';
  setStatus('正在重启处理引擎…', 'loading');
  setInteractive(false);
  startWorker();
}

startWorker();

ready.then(
  () => {},
  (error) => {
    if (phase === 'loading') {
      phase = 'error';
      setStatus('处理引擎加载失败', 'error');
      showError(`处理失败：${error.message}`);
      setInteractive(false);
    }
  },
);

// Selection stays disabled until the wasm module and cascade are ready.
setInteractive(false);

function engineStoppedError() {
  const error = new Error('处理引擎已停止；刷新页面后可继续处理。');
  error.engineStopped = true;
  return error;
}

function runWorker(buffer) {
  return new Promise((resolve, reject) => {
    // The worker can die while handleFile is still awaiting file.arrayBuffer(),
    // leaving `worker` null. Fail with the engine message instead of a
    // TypeError from postMessage.
    if (!worker || engineFailed) {
      reject(engineStoppedError());
      return;
    }
    const request = { resolve, reject, timer: null };
    request.timer = setTimeout(() => {
      if (pending !== request) return;
      pending = null;
      // The worker is wedged (or the wasm call never returned). Terminate it
      // so no CPU/memory stays pinned, then let the caller restart the engine.
      disposeWorker();
      engineFailed = true;
      const error = new Error(`处理超时（${PROCESS_TIMEOUT_MS / 1000} 秒）`);
      error.workerTimeout = true;
      reject(error);
    }, PROCESS_TIMEOUT_MS);
    pending = request;
    try {
      worker.postMessage({ type: 'process', buffer }, [buffer]);
    } catch (error) {
      pending = null;
      clearTimeout(request.timer);
      // The worker can disappear between the guard above and this call.
      reject(!worker || engineFailed ? engineStoppedError() : error);
    }
  });
}

function decodePreview() {
  if (typeof previewEl.decode !== 'function') return Promise.resolve();
  return previewEl.decode().catch(
    () =>
      new Promise((resolve) => {
        if (previewEl.complete) {
          resolve();
          return;
        }
        const done = () => resolve();
        previewEl.addEventListener('load', done, { once: true });
        previewEl.addEventListener('error', done, { once: true });
      }),
  );
}

async function showSuccess(data) {
  const blob = new Blob([data.buffer], { type: 'image/jpeg' });
  previewUrl = URL.createObjectURL(blob);

  previewEl.src = previewUrl;
  metaEl.textContent = `${data.w} × ${data.h} · ${formatBytes(data.size)}`;
  downloadEl.href = previewUrl;
  downloadEl.setAttribute('download', '报名照片.jpg');
  resultEl.hidden = false;

  phase = 'success';
  setStatus('已生成报名照片', 'success');
  setInteractive(true);

  // Resolve __photoTest.process only after naturalWidth/naturalHeight are
  // available, so browser automation does not need to poll the image.
  await decodePreview();
}

function showFailure(data) {
  const message =
    (data.code >= 1 && data.code <= 5 && MESSAGES[data.code]) ||
    `处理失败：${data.error || `内部错误（${data.code}）`}`;
  showError(message);
  phase = 'error';
  setStatus('处理失败，请重新选择照片', 'error');
  setInteractive(true);
}

async function handleFile(file) {
  if (!file) throw new Error('未选择照片文件');
  if (phase === 'processing') {
    throw new Error('上一张照片还在处理，请稍候');
  }
  if (engineFailed) {
    throw engineStoppedError();
  }

  clearResult();
  clearError();
  phase = 'processing';
  setInteractive(false);
  setStatus('处理中… 请稍候', 'processing');

  try {
    await ready;
    const buffer = await file.arrayBuffer();
    const result = await runWorker(buffer);

    if (result.code === 0) {
      await showSuccess(result);
      return {
        code: 0,
        w: result.w,
        h: result.h,
        size: result.size,
        face: result.face,
        crop: result.crop,
        elapsed: result.elapsed,
      };
    }

    showFailure(result);
    return { code: result.code, error: result.error || '' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error && error.workerTimeout) {
      showError(`${message}，处理引擎已重新启动，请重新选择照片。`);
      restartEngine();
      throw error;
    }
    if (engineFailed || (error && error.engineStopped)) {
      // Covers both an init failure and an idle crash while this file was
      // being read; never surface the raw TypeError/engine error text.
      showError('处理引擎已停止；刷新页面后可继续处理。');
      phase = 'error';
      setStatus('处理引擎已停止', 'error');
      setInteractive(false);
      throw engineStoppedError();
    }
    showError(`处理失败：${message}`);
    phase = 'error';
    setStatus('处理失败，请重新选择照片', 'error');
    setInteractive(true);
    throw error;
  }
}

function pickFile(file) {
  if (!file) return;
  // handleFile renders every expected failure itself; swallow only the
  // rejected promise so the browser console stays clean.
  handleFile(file).catch(() => {});
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files && fileInput.files[0];
  fileInput.value = '';
  pickFile(file);
});

drop.addEventListener('dragover', (event) => {
  event.preventDefault();
  if (!drop.classList.contains('is-disabled')) {
    drop.classList.add('is-dragover');
  }
});

drop.addEventListener('dragleave', () => {
  drop.classList.remove('is-dragover');
});

drop.addEventListener('drop', (event) => {
  event.preventDefault();
  drop.classList.remove('is-dragover');
  if (drop.classList.contains('is-disabled')) return;
  const file = event.dataTransfer && event.dataTransfer.files[0];
  pickFile(file);
});

// <label> opens the picker on click; make the same affordance work from the
// keyboard without relying on label activation quirks.
drop.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  if (!fileInput.disabled) fileInput.click();
});

if (isTestMode) {
  // Automation-only hook. Never exposed on the production page.
  window.__photoTest = { process: handleFile };
}
