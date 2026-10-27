// Streams a separated stem from Replicate through this origin, so the browser
// can decode and mix it (and download it with a proper filename) without
// depending on Replicate's CORS headers.
import { checkAccess, isReplicateFile } from './_lib.js';

export const config = { runtime: 'edge' };

export default async function handler(request) {
  const denied = checkAccess(request);
  if (denied) return denied;

  const url = new URL(request.url).searchParams.get('url');
  if (!isReplicateFile(url)) return new Response('Not allowed.', { status: 400 });

  const upstream = await fetch(url);
  if (!upstream.ok || !upstream.body) {
    return new Response('Stem not available.', { status: 502 });
  }
  return new Response(upstream.body, {
    headers: {
      'Content-Type': upstream.headers.get('content-type') || 'audio/mpeg',
      'Cache-Control': 'private, no-store',
    },
  });
}
