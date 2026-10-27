import { json, accessRequired } from './_lib.js';

export function GET() {
  return json({ accessRequired: accessRequired() });
}
