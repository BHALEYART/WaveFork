// Copies the runtime files WaveFork serves itself into vendor/ and fonts/.
// Run after changing versions in package.json: npm install && npm run vendor
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const nm = (p) => new URL(`../node_modules/${p}`, import.meta.url);
const out = (p) => new URL(`../${p}`, import.meta.url);

rmSync(out('vendor'), { recursive: true, force: true });
mkdirSync(out('vendor/ort'), { recursive: true });
mkdirSync(out('fonts'), { recursive: true });

// ONNX Runtime Web, WebGPU build (falls back to its WASM backend)
for (const f of ['ort.webgpu.bundle.min.mjs', 'ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']) {
  cpSync(nm(`onnxruntime-web/dist/${f}`), out(`vendor/ort/${f}`));
}
// demucs-web: STFT, chunking and stem assembly around the Demucs ONNX model
cpSync(nm('demucs-web/src'), out('vendor/demucs-web'), { recursive: true });
cpSync(nm('demucs-web/LICENSE'), out('vendor/demucs-web/LICENSE'));

// Self-hosted fonts (cross-origin isolation blocks most third-party font CSS)
const fonts = {
  'chakra-petch': ['400', '500', '600', '700'],
  'ibm-plex-mono': ['400', '500'],
};
for (const [family, weights] of Object.entries(fonts)) {
  for (const w of weights) {
    const file = `${family}-latin-${w}-normal.woff2`;
    cpSync(nm(`@fontsource/${family}/files/${file}`), out(`fonts/${file}`));
  }
}
console.log('vendored runtime files and fonts');
