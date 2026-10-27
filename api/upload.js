// Issues short-lived tokens so the browser can upload straight to Vercel Blob.
// This sidesteps the 4.5 MB request limit on Vercel Functions.
import { handleUpload } from '@vercel/blob/client';
import { json, accessOk } from './_lib.js';

const MAX_BYTES = 200 * 1024 * 1024; // audio extracted from video arrives as WAV

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request.' }, 400);
  }

  try {
    const result = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        if (!accessOk(clientPayload)) throw new Error('Access code required.');
        if (!pathname.startsWith('uploads/')) throw new Error('Invalid upload path.');
        return {
          allowedContentTypes: ['audio/*'],
          maximumSizeInBytes: MAX_BYTES,
          addRandomSuffix: true,
        };
      },
    });
    return json(result);
  } catch (err) {
    return json({ error: err.message || 'Upload was rejected.' }, 400);
  }
}
