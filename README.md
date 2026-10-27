# WaveFork

Split any song into vocals and instrumental. Free, and nothing is uploaded: the separation runs in the visitor's browser.

- **Keep instrumental** removes the vocals.
- **Keep vocals** removes the music.

One separation produces both halves, so you can flip between them (playback keeps its place) and download either as a WAV. You can start from a song or a video; for video, the browser reads the soundtrack.

## How it works

1. The browser decodes the file (audio, or a video's soundtrack) to 44.1 kHz stereo.
2. `separator.worker.js` runs **HTDemucs** (Meta's Demucs v4, 4 stems) in a Web Worker with **ONNX Runtime Web**: WebGPU when the device has it, otherwise multi-threaded WASM. If the GPU fails mid-run, it retries on the CPU.
3. The model (~172 MB, `timcsy/demucs-web-onnx` on Hugging Face) downloads on the first split and is kept in Cache Storage, so later splits and visits skip the download.
4. The worker returns drums, bass, other and vocals. The page keeps **vocals** and sums the rest into the **instrumental**, then writes both as 16-bit WAV (scaled down only if the sum would clip).

```
index.html, styles.css, app.js   UI, decoding, playback, WAV export
audio.js                         stem mixing, WAV encoding, waveform peaks (no DOM, testable in Node)
separator.worker.js              model download/cache and separation, off the main thread
vendor/ort/                      ONNX Runtime Web 1.31.1, WebGPU build + its WASM
vendor/demucs-web/               demucs-web 1.0.2 (MIT): STFT, chunking, overlap-add
fonts/                           Chakra Petch, IBM Plex Mono (self-hosted)
vercel.json                      cross-origin isolation headers (enables WASM threads)
```

To update the vendored runtime: change versions in `package.json`, then `npm install && npm run vendor`.

## Hosting

It's a static site. On Vercel, import the repo with no framework preset or build command; `vercel.json` sets the `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers. No environment variables, storage or API keys are needed.

Other static hosts work too. Without those two headers (GitHub Pages can't set them), the WASM fallback runs single-threaded and is slower; WebGPU is unaffected.

## Notes

- Speed depends on the visitor's device. A recent computer with WebGPU (Chrome, Edge, Safari) is fastest. Phones work for short clips but can run out of memory on long tracks.
- Tracks are limited to 20 minutes to keep memory use reasonable.
- Expect some bleed between halves on dense or heavily reverbed mixes.
- The model file is hosted by a third party on Hugging Face. To remove that dependency, copy `htdemucs_embedded.onnx` to a Hugging Face repo of your own and update `MODEL_URL` in `separator.worker.js`.
