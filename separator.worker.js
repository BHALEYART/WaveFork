// Runs Demucs (HTDemucs, 4 stems) in the visitor's browser, off the main thread.
// Uses WebGPU when available and ONNX Runtime's WASM backend otherwise.
import * as ort from './vendor/ort/ort.webgpu.bundle.min.mjs';
import { DemucsProcessor } from './vendor/demucs-web/processor.js';

const MODEL_URL = 'https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx';
const MODEL_CACHE = 'wavefork-model-v1';
const APPROX_MODEL_BYTES = 172 * 1024 * 1024; // used only if the server omits Content-Length

ort.env.wasm.wasmPaths = new URL('./vendor/ort/', import.meta.url).href;
// Threads need cross-origin isolation (set by vercel.json); otherwise run single-threaded.
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

let processor = null;
let modelBytes = null;
let backend = null; // 'webgpu' | 'wasm'

// Download the model once, then serve it from Cache Storage on later visits.
async function getModelBytes() {
  if (modelBytes) return modelBytes;

  let cache = null;
  try { cache = await caches.open(MODEL_CACHE); } catch { /* storage unavailable */ }
  const cached = cache && (await cache.match(MODEL_URL));
  if (cached) {
    post({ type: 'status', phase: 'loading' });
    modelBytes = await cached.arrayBuffer();
    return modelBytes;
  }

  post({ type: 'status', phase: 'downloading', progress: 0 });
  const res = await fetch(MODEL_URL);
  if (!res.ok || !res.body) throw new Error(`The separation model could not be downloaded (${res.status}).`);
  const total = Number(res.headers.get('content-length')) || APPROX_MODEL_BYTES;
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  let lastPct = -1;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    const pct = Math.min(100, Math.floor((loaded / total) * 100));
    if (pct !== lastPct) {
      lastPct = pct;
      post({ type: 'status', phase: 'downloading', progress: pct });
    }
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.length; }

  try {
    await cache?.put(MODEL_URL, new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } }));
  } catch { /* quota or private mode: works, just re-downloads next visit */ }

  modelBytes = bytes.buffer;
  return modelBytes;
}

async function createProcessor(providers) {
  post({ type: 'status', phase: 'loading' });
  const p = new DemucsProcessor({
    ort,
    sessionOptions: { executionProviders: providers, graphOptimizationLevel: 'basic' },
    onProgress: ({ progress }) => post({ type: 'status', phase: 'separating', progress: Math.round(progress * 100) }),
  });
  // ONNX Runtime may take ownership of the buffer, so give it a copy.
  await p.loadModel((await getModelBytes()).slice(0));
  modelBytes = null; // free ~170 MB; a CPU fallback re-reads it from the cache
  return p;
}

async function ensureProcessor() {
  if (processor) return;
  const hasGpu = Boolean(self.navigator?.gpu && (await self.navigator.gpu.requestAdapter().catch(() => null)));
  if (hasGpu) {
    try {
      processor = await createProcessor(['webgpu']);
      backend = 'webgpu';
      return;
    } catch { /* fall through to WASM */ }
  }
  processor = await createProcessor(['wasm']);
  backend = 'wasm';
}

async function separate(left, right) {
  await ensureProcessor();
  post({ type: 'status', phase: 'separating', progress: 0, backend });
  try {
    return await processor.separate(left, right);
  } catch (err) {
    if (backend !== 'webgpu') throw err;
    // Some GPUs fail mid-run (memory, driver). Retry once on the CPU.
    processor = await createProcessor(['wasm']);
    backend = 'wasm';
    post({ type: 'status', phase: 'separating', progress: 0, backend });
    return processor.separate(left, right);
  }
}

self.onmessage = async ({ data }) => {
  if (data?.type !== 'separate') return;
  try {
    const stems = await separate(data.left, data.right);
    const transfer = [];
    for (const s of Object.values(stems)) transfer.push(s.left.buffer, s.right.buffer);
    post({ type: 'done', stems, backend }, transfer);
  } catch (err) {
    post({ type: 'error', message: err?.message || String(err) });
  }
};
