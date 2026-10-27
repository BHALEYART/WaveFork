# WaveFork

Split any song into vocals and instrumental.

- **Keep instrumental** removes the vocals.
- **Keep vocals** removes the music.

One separation produces both halves, so you can flip between them (playback keeps its place) and download either.

## How it works

1. The browser uploads the track straight to **Vercel Blob**, which avoids the 4.5 MB request limit on Vercel Functions. For a **video** (MP4, MOV, WebM, and MKV where the browser supports it, up to 500 MB), the browser extracts the soundtrack locally and uploads only that as a WAV. The video itself is never uploaded.
2. `/api/separate` starts **Demucs** (`cjwbw/demucs` on Replicate) with Fast = `htdemucs` and Best = `htdemucs_ft`, which is cleaner but roughly 4× slower.
3. `/api/status` is polled for progress. When the job ends, the uploaded track is deleted from Blob.
4. The stems are streamed through `/api/stem`, a same-origin proxy that avoids relying on Replicate's CORS settings.
5. The browser keeps `vocals` as an MP3. It sums drums, bass and other into the **instrumental** and saves it as a 16-bit WAV, scaling it down only if the sum would clip.

```
index.html, styles.css, app.js   UI
audio.js                         stem mixing, WAV encoding, waveform peaks (no DOM, testable in Node)
vendor/blob-client.js            bundled @vercel/blob upload client (rebuild with `npm run vendor`)
api/upload.js                    Blob client-upload tokens (audio only, 200 MB max)
api/separate.js                  starts the Replicate prediction
api/status.js                    polls the prediction, deletes the upload when done
api/stem.js                      edge proxy for stem files (replicate.delivery only)
api/config.js                    tells the UI whether an access code is required
```

## Setup on Vercel

1. Import the repo into Vercel. No framework preset or build command is needed.
2. Go to **Storage → Create → Blob** (choose **Public** access, since Replicate downloads the upload by URL) and connect the store to this project. Either connection style works: a `BLOB_READ_WRITE_TOKEN`, or Vercel's keyless setup (`BLOB_STORE_ID` + `BLOB_WEBHOOK_PUBLIC_KEY`), which uses presigned uploads.
3. Add these environment variables:

| Variable | Required | Purpose |
|---|---|---|
| `REPLICATE_API_TOKEN` | Yes | From replicate.com/account/api-tokens |
| `WAVEFORK_ACCESS_CODE` | Recommended | If set, the UI asks for this code before uploading. This stops strangers from running up your Replicate bill. |
| `REPLICATE_DEMUCS_VERSION` | No | Pins a different `cjwbw/demucs` version id |

4. Redeploy.

For local development, run `vercel env pull` and then `vercel dev`.

## Notes

- Each run costs a few cents on Replicate. The first run after an idle period waits for a GPU to boot, which can take a minute or two.
- Expect some bleed between halves on dense or heavily reverbed mixes.
- Users are responsible for having the rights to the music they upload.
