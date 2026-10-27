// Starts a Demucs stem separation on Replicate for an uploaded track.
import { json, checkAccess, isOurUpload } from './_lib.js';

// cjwbw/demucs. Override with REPLICATE_DEMUCS_VERSION to pin a newer build.
const DEFAULT_VERSION = 'abf8fe28e407afa6d8e41e86a759caccc0af8e49c3c68016006b62cb0968441e';

const MODELS = {
  fast: 'htdemucs',
  best: 'htdemucs_ft', // fine-tuned: cleaner, roughly 4x slower
};

export async function POST(request) {
  const denied = checkAccess(request);
  if (denied) return denied;

  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) return json({ error: 'Server is missing REPLICATE_API_TOKEN.' }, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request.' }, 400);
  }

  const { audioUrl, quality } = body || {};
  if (!isOurUpload(audioUrl)) return json({ error: 'Unknown audio file.' }, 400);

  const res = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      version: process.env.REPLICATE_DEMUCS_VERSION || DEFAULT_VERSION,
      input: {
        audio: audioUrl,
        model_name: MODELS[quality] || MODELS.fast,
        output_format: 'mp3',
        mp3_bitrate: 320,
        clip_mode: 'rescale',
        shifts: 1,
        overlap: 0.25,
      },
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return json({ error: data.detail || `Replicate returned ${res.status}.` }, 502);
  }
  return json({ id: data.id });
}
