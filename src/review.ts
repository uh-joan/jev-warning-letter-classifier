/**
 * Uncertainty / human-review routing.
 *
 * Best practice from TypeSafe's docs, applied to a regulatory tool where a wrong
 * silent answer is costly:
 *  - Self-consistency (cookbooks/consistency_noul): a Noul probability in the
 *    uncertain band [0.30, 0.70] is a "not sure" signal — surface it for review
 *    instead of silently thresholding at 0.5, and keep the raw probability.
 *  - Confidence-gated routing (patterns/confidence-routing): a Choice's own
 *    `confidence` says whether to act; below a threshold, route to a human.
 * Nothing here changes an answer; it only flags which answers a person should
 * check. Raw probabilities stay in `_jev`.
 */

/** Noul band: P(true) inside [LOW, HIGH] is "uncertain" (consistency_noul cookbook). */
export const NOUL_UNCERTAIN_LOW = 0.3;
export const NOUL_UNCERTAIN_HIGH = 0.7;

/** A Choice answered below this confidence is routed to review (confidence-routing). */
export const CHOICE_REVIEW_BELOW = 0.65;

export interface ReviewFlag {
  /** Output field the flag concerns, e.g. "drug", "products[2].is_subject". */
  field: string;
  kind: "noul" | "choice" | "score";
  /** The value we are reporting for that field (the answer that is uncertain). */
  value: string | number | boolean | null;
  /** Noul P(true), or Choice/Score confidence — whichever drove the flag, 0..1. */
  certainty: number;
  reason: string;
}

export const noulUncertain = (p: number): boolean =>
  p >= NOUL_UNCERTAIN_LOW && p <= NOUL_UNCERTAIN_HIGH;

export const choiceUncertain = (confidence: number | undefined): boolean =>
  (confidence ?? 0) < CHOICE_REVIEW_BELOW;
