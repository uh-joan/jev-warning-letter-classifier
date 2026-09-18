/**
 * Public API: classifyWarningLetter(text, opts) -> WarningLetter
 *
 * Pipeline:  text -> extract candidates -> Jev selects -> assemble structured object
 */

import { extractCandidates, type ExtractOptions } from "./extract.js";
import { classifyWithJev } from "./classify.js";
import { assemble } from "./assemble.js";
import type { WarningLetter } from "./types.js";

export interface ClassifyOptions extends ExtractOptions {}

export async function classifyWarningLetter(
  text: string,
  opts: ClassifyOptions = {},
): Promise<WarningLetter> {
  const candidates = extractCandidates(text, opts);
  const jev = await classifyWithJev(text, candidates);
  return assemble(candidates, jev);
}

export { extractCandidates } from "./extract.js";
export * from "./types.js";
