// Pure audio helpers: mixing stems, WAV encoding, waveform peaks.
// Kept free of DOM APIs so they can be tested in Node.

// An empty stereo mix buffer.
export function createMix(length, sampleRate) {
  return {
    sampleRate,
    length,
    channels: [new Float32Array(length), new Float32Array(length)],
  };
}

// Add an AudioBuffer-like stem ({ numberOfChannels, length, getChannelData })
// into the mix. Mono stems are spread to both sides.
export function addInto(mix, stem) {
  const n = Math.min(mix.length, stem.length);
  for (let c = 0; c < 2; c++) {
    const src = stem.getChannelData(Math.min(c, stem.numberOfChannels - 1));
    const dst = mix.channels[c];
    for (let i = 0; i < n; i++) dst[i] += src[i];
  }
}

// Wrap an AudioBuffer-like object as plain channel arrays.
export function channelsOf(buffer) {
  const out = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) out.push(buffer.getChannelData(c));
  return out;
}

// 16-bit PCM WAV. Summed stems can exceed full scale slightly, so the mix is
// scaled down only when it would otherwise clip.
export function encodeWav({ channels, sampleRate, length }) {
  const numCh = channels.length;
  let peak = 0;
  for (const ch of channels) {
    for (let i = 0; i < length; i++) {
      const v = Math.abs(ch[i]);
      if (v > peak) peak = v;
    }
  }
  const gain = peak > 1 ? 0.999 / peak : 1;

  const bytesPerSample = 2;
  const dataSize = length * numCh * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);              // fmt chunk size
  view.setUint16(20, 1, true);               // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numCh * bytesPerSample, true);
  view.setUint16(32, numCh * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let off = 44;
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < numCh; c++) {
      let s = channels[c][i] * gain;
      s = s < -1 ? -1 : s > 1 ? 1 : s;
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return buffer;
}

// Max absolute amplitude per bucket across all channels.
export function computePeaks(channels, buckets = 1200) {
  const length = channels[0].length;
  const out = new Float32Array(buckets);
  const size = length / buckets;
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * size);
    const end = Math.max(start + 1, Math.floor((b + 1) * size));
    let max = 0;
    for (const ch of channels) {
      for (let i = start; i < end && i < length; i++) {
        const v = Math.abs(ch[i]);
        if (v > max) max = v;
      }
    }
    out[b] = max;
  }
  return out;
}
