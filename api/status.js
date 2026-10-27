// Reports separation progress. Once the job ends, deletes the uploaded track.
import { del } from '@vercel/blob';
import { json, checkAccess, isOurUpload } from './_lib.js';

const DONE = new Set(['succeeded', 'failed', 'canceled']);

// Demucs logs tqdm bars like " 45%|████". Take the latest percentage.
function progressFromLogs(logs) {
  if (!logs) return null;
  const matches = [...logs.matchAll(/(\d{1,3})%\|/g)];
  if (!matches.length) return null;
  return Math.min(100, Number(matches[matches.length - 1][1]));
}

export async function GET(request) {
  const denied = checkAccess(request);
  if (denied) return denied;

  const params = new URL(request.url).searchParams;
  const id = params.get('id') || '';
  const blob = params.get('blob');
  if (!/^[a-z0-9]+$/i.test(id)) return json({ error: 'Invalid job id.' }, 400);

  const res = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
    headers: { Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return json({ error: data.detail || `Replicate returned ${res.status}.` }, 502);

  if (DONE.has(data.status) && blob && isOurUpload(blob)) {
    await del(blob).catch(() => {}); // already gone is fine
  }

  return json({
    status: data.status,
    progress: progressFromLogs(data.logs),
    output: data.status === 'succeeded' ? data.output : null,
    error: data.error || null,
  });
}
