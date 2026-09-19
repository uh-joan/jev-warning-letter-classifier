/**
 * Public API: classifyWarningLetter(text, opts) -> WarningLetter
 *
 * Pipeline:  text -> gather candidates -> Jev selects -> assemble -> (optional) openFDA enrichment
 */

import { gatherCandidates, type GatherOptions } from "./candidates.js";
import { classifyWithJev } from "./classify.js";
import { assemble } from "./assemble.js";
import { lookupDrug } from "./openfda.js";
import type { WarningLetter } from "./types.js";

export interface ClassifyOptions extends GatherOptions {
  /** Fill ingredient / route / dosage form from openFDA when the local KB has no record. */
  enrichFromOpenFda?: boolean;
}

export async function classifyWarningLetter(
  text: string,
  opts: ClassifyOptions = {},
): Promise<WarningLetter> {
  const { cands, trace } = await gatherCandidates(text, opts);
  const jev = await classifyWithJev(text, cands);
  const result = assemble(cands, jev, text);

  if (opts.enrichFromOpenFda && result.drug.name && !result.drug.active_ingredient) {
    const rec = await lookupDrug(result.drug.name, { offline: opts.offline });
    if (rec) {
      result.drug.active_ingredient = rec.active_ingredient || null;
      result.drug.route = rec.route || null;
      result.drug.dosage_form = rec.dosage_form || null;
      result.drug.indication ??= rec.indication || null;
    }
  }

  result._candidates = trace;
  return result;
}

export { extractCandidates } from "./extract.js";
export { gatherCandidates } from "./candidates.js";
export * from "./types.js";
