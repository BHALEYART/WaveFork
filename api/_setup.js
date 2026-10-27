// Explains, in plain words, what's missing from a deployment's setup.
// Returned to the browser because the Blob upload client hides server errors.

export function uploadProblem() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return "Uploads aren't set up: this deployment has no BLOB_READ_WRITE_TOKEN. In Vercel, connect a Blob store to the project (Storage tab), then redeploy.";
  }
  return null;
}

export function separationProblem() {
  if (!process.env.REPLICATE_API_TOKEN) {
    return "Separation isn't set up: this deployment has no REPLICATE_API_TOKEN. Add it under Settings → Environment Variables, then redeploy.";
  }
  return null;
}
