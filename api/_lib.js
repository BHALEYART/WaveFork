// Shared helpers. Files starting with "_" in /api are not deployed as routes.

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// Optional gate so strangers can't run up the Replicate bill.
// Set WAVEFORK_ACCESS_CODE in Vercel to require it; leave unset for an open app.
export function accessRequired() {
  return Boolean(process.env.WAVEFORK_ACCESS_CODE);
}

export function accessOk(code) {
  const expected = process.env.WAVEFORK_ACCESS_CODE;
  return !expected || code === expected;
}

export function checkAccess(request) {
  if (accessOk(request.headers.get('x-access-code'))) return null;
  return json({ error: 'Access code required.' }, 401);
}

// Only accept audio that this app uploaded to its own Blob store.
export function isOurUpload(url) {
  try {
    const u = new URL(url);
    return (
      u.protocol === 'https:' &&
      u.hostname.endsWith('.public.blob.vercel-storage.com') &&
      u.pathname.startsWith('/uploads/')
    );
  } catch {
    return false;
  }
}

export function isReplicateFile(url) {
  try {
    const u = new URL(url);
    return (
      u.protocol === 'https:' &&
      (u.hostname === 'replicate.delivery' || u.hostname.endsWith('.replicate.delivery'))
    );
  } catch {
    return false;
  }
}
