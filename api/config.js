import { json, accessRequired } from './_lib.js';
import { uploadMode, uploadProblem, separationProblem } from './_setup.js';

export function GET() {
  return json({
    accessRequired: accessRequired(),
    uploadMode: uploadMode(),
    setupProblem: uploadProblem() || separationProblem(),
  });
}
