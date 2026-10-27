import { json, accessRequired } from './_lib.js';
import { uploadProblem, separationProblem } from './_setup.js';

export function GET() {
  return json({
    accessRequired: accessRequired(),
    setupProblem: uploadProblem() || separationProblem(),
  });
}
