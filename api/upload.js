// Lets the browser upload straight to Vercel Blob, which sidesteps the
// 4.5 MB request limit on Vercel Functions. Supports both ways Vercel can
// connect a Blob store (see _setup.js).
import { handleUpload, handleUploadPresigned } from '@vercel/blob/client';
import { issueSignedToken } from '@vercel/blob';
import { json, accessOk } from './_lib.js';
import { uploadMode, uploadProblem } from './_setup.js';

const MAX_BYTES = 200 * 1024 * 1024; // audio extracted from video arrives as WAV
const AUDIO_TYPES = [
  'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave',
  'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/aac',
  'audio/flac', 'audio/x-flac', 'audio/ogg', 'audio/opus', 'audio/webm',
  'audio/aiff', 'audio/x-aiff',
];

function checkUpload(pathname, clientPayload) {
  if (!accessOk(clientPayload)) throw new Error('Access code required.');
  if (!/^uploads\/[\w.-]+$/.test(pathname)) throw new Error('Invalid upload path.');
}

// The Blob client discards error bodies, so the page calls this after a
// refused upload to find out why.
export function GET(request) {
  if (!accessOk(request.headers.get('x-access-code'))) {
    return json({ problem: 'That access code was not accepted. Check it and try again.' });
  }
  return json({ problem: uploadProblem() });
}

export async function POST(request) {
  const problem = uploadProblem();
  if (problem) return json({ error: problem }, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request.' }, 400);
  }

  try {
    if (body?.type === 'blob.generate-presigned-url' || (uploadMode() === 'presigned' && body?.type === 'blob.upload-completed')) {
      const result = await handleUploadPresigned({
        body,
        request,
        getSignedToken: async (pathname, clientPayload) => {
          checkUpload(pathname, clientPayload);
          // Scoped to this one file, upload only, for one hour.
          const token = await issueSignedToken({
            pathname,
            operations: ['put'],
            allowedContentTypes: AUDIO_TYPES,
            maximumSizeInBytes: MAX_BYTES,
            validUntil: Date.now() + 60 * 60 * 1000,
          });
          return { token, urlOptions: { allowedContentTypes: AUDIO_TYPES, maximumSizeInBytes: MAX_BYTES } };
        },
      });
      return json(result);
    }

    const result = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        checkUpload(pathname, clientPayload);
        return { allowedContentTypes: AUDIO_TYPES, maximumSizeInBytes: MAX_BYTES };
      },
    });
    return json(result);
  } catch (err) {
    console.error('upload refused:', err);
    return json({ error: err.message || 'Upload was rejected.' }, 400);
  }
}
