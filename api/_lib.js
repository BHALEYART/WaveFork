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

// REPLICATE_API_TOKEN as pasted into Vercel, forgiving common paste mistakes:
// surrounding whitespace or quotes, or a leading "Bearer ".
export function replicateToken() {
  const raw = process.env.REPLICATE_API_TOKEN || '';
  return raw.trim().replace(/^["']|["']$/g, '').replace(/^Bearer\s+/i, '').trim();
}

export function replicateError(status, data) {
  if (status === 401) {
    return 'Replicate rejected the API token. In Vercel, re-copy REPLICATE_API_TOKEN from replicate.com/account/api-tokens (just the r8_… value), then redeploy.';
  }
  if (status === 402) {
    return 'Replicate needs billing set up on your account before it can run models (replicate.com/account/billing).';
  }
  return data?.detail || `Replicate returned ${status}.`;
}
