import { replicateToken } from './_lib.js';

// Explains, in plain words, what's missing from a deployment's setup.
// Returned to the browser because the Blob upload client hides server errors.

// Vercel connects Blob stores in one of two ways:
// - a read-write token (BLOB_READ_WRITE_TOKEN) → client-token uploads
// - keyless OIDC (BLOB_STORE_ID + BLOB_WEBHOOK_PUBLIC_KEY) → presigned uploads
export function uploadMode() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return 'token';
  if (process.env.BLOB_STORE_ID && process.env.BLOB_WEBHOOK_PUBLIC_KEY) return 'presigned';
  return null;
}

export function uploadProblem() {
  if (!uploadMode()) {
    return "Uploads aren't set up: no Blob store is connected to this deployment. In Vercel, connect a Blob store to the project (Storage tab), then redeploy.";
  }
  return null;
}

export function separationProblem() {
  if (!process.env.REPLICATE_API_TOKEN) {
    return "Separation isn't set up: this deployment has no REPLICATE_API_TOKEN. Add it under Settings → Environment Variables, then redeploy.";
  }
  // Shape checks only; the token itself is never sent to the browser.
  const token = replicateToken();
  if (token.includes('*') || token.includes('•')) {
    return "REPLICATE_API_TOKEN contains the masked version of the token (asterisks). Create a new token at replicate.com/account/api-tokens, copy the full value with its copy button, update it in Vercel, then redeploy.";
  }
  if (!token.startsWith('r8_') || /\s/.test(token)) {
    return "REPLICATE_API_TOKEN doesn't look like a Replicate token (they start with r8_). Re-copy it from replicate.com/account/api-tokens, update it in Vercel, then redeploy.";
  }
  return null;
}
