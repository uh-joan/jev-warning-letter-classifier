/**
 * Jev classification step.
 *
 * One evaluate() call to typesafe-ai/jev over the AI Gateway. Jev makes bounded
 * judgments only: which candidate is the drug, which indication, and a set of
 * boolean/score signals. It generates no free text.
 */

import { experimental_evaluate as evaluate } from "ai";
import type { Candidate, ExtractedCandidates } from "./types.js";

export const JEV_MODEL = "typesafe-ai/jev";

/** Build a Choice `criteria` map from candidates, always adding an `unknown` escape hatch. */
function criteriaFrom(candidates: Candidate[]): Record<string, string> {
  const c: Record<string, string> = {};
  for (const cand of candidates) c[cand.id] = cand.text;
  c.unknown = "Cannot be identified or supported by the document";
  return c;
}

/** Key of the per-candidate "is this a subject of the letter?" boolean question. */
export const subjectKey = (candidateId: string): `subj_${string}` => `subj_${candidateId}`;

/** Jev answers one request; keep the per-candidate question count bounded. */
const MAX_SUBJECT_QUESTIONS = 40;

/** Candidates whose name is stated verbatim in the letter (i.e. not cross-reference leads). */
export function candidatesInLetter(text: string, cands: Candidate[]): Candidate[] {
  const haystack = text.toLowerCase();
  return cands.filter((c) => {
    const name = c.payload?.name;
    return typeof name === "string" && haystack.includes(name.toLowerCase());
  });
}

const LETTER_SOURCES = new Set(["letter-text", "letter-quote", "letter-prose"]);

/**
 * Whether a candidate is eligible to be selected as THE confirmed drug product
 * (the `drug_candidate` choice). Borrowed from the Tetris agent's "only
 * advertise reachable targets", and bounded by this project's core rule that a
 * confirmed span must come from the letter itself:
 *  - a confirmed product name must be stated verbatim in the letter, so
 *    cross-reference leads (openFDA / facility KB) are never eligible — they are
 *    surfaced as drug.cross_reference_leads for a reviewer instead;
 *  - an active ingredient or a product *class* is never the finished product;
 *  - when the product name is redacted (b)(4), the letter states no product to
 *    confirm, so nothing is eligible and drug.name stays null.
 * Ineligible candidates are still offered to the per-candidate subject questions.
 */
export function eligibleAsProduct(c: Candidate, productNameRedacted: boolean): boolean {
  if (productNameRedacted) return false;
  const kind = c.payload?.kind;
  if (kind === "active_ingredient" || kind === "generic_product_class") return false;
  return LETTER_SOURCES.has(String(c.payload?.source));
}

const CROSSREF_SOURCES = new Set(["openfda-labeler", "openfda-name", "facility-crossref"]);

/** Cross-reference leads (not stated in the letter): possible products for a reviewer / Cortellis. */
export function crossReferenceLeads(cands: Candidate[]): string[] {
  const out: string[] = [];
  for (const c of cands) {
    if (CROSSREF_SOURCES.has(String(c.payload?.source)) && typeof c.payload?.name === "string") {
      if (!out.includes(c.payload.name)) out.push(c.payload.name);
    }
  }
  return out;
}

export interface JevRawAnswers {
  document_type: { choice: string; probabilities?: Record<string, number> };
  drug_candidate: { choice: string; probabilities?: Record<string, number> };
  indication_candidate: { choice: string; probabilities?: Record<string, number> };
  is_sterile_product: { probability: number };
  has_cgmp_violation: { probability: number };
  has_aseptic_violation: { probability: number };
  has_env_monitoring_violation: { probability: number };
  has_contamination: { probability: number };
  contamination_linked_to_complaints: { probability: number };
  has_recall_concern: { probability: number };
  severity: { score: number; probabilities?: Record<number, number> };
  /** `subj_<candidateId>` → P(candidate is a subject of the letter). */
  [subjectQuestion: `subj_${string}`]: { probability: number };
}

export interface JevResult {
  answers: JevRawAnswers;
  confidence: number | undefined;
  raw: unknown;
}

/**
 * @param text     Full warning-letter text (state).
 * @param cands    Extracted candidates (drug/indication choice sets come from here).
 */
export async function classifyWithJev(
  text: string,
  cands: ExtractedCandidates,
): Promise<JevResult> {
  const redacted = cands.redaction.product_name_redacted;
  // Only offer candidates that could actually BE the product (idea #3).
  const drugCriteria = criteriaFrom(cands.drugs.filter((c) => eligibleAsProduct(c, redacted)));
  const indicationCriteria = criteriaFrom(cands.indications);

  // Warning letters routinely cite several products at once, so "which ONE is the
  // subject" has no right answer for them. Each product named in the letter gets
  // its own bounded yes/no judgment; the single choice below still handles
  // cross-reference leads for letters whose product name is redacted.
  const subjectQuestions: Record<
    string,
    { type: "boolean"; instructions: Record<string, unknown> }
  > = {};
  for (const c of candidatesInLetter(text, cands.drugs).slice(0, MAX_SUBJECT_QUESTIONS)) {
    const name = String(c.payload?.name);
    subjectQuestions[subjectKey(c.id)] = {
      type: "boolean",
      // Structured, ordered instructions (idea #2), so the boundary cases the
      // question exists to exclude are spelled out rather than left to prose.
      instructions: {
        question: `Is "${name}" a subject of this warning letter?`,
        true_when:
          "A drug, biologic, device or consumable product — or a drug substance/API — that this firm " +
          "makes, markets, compounds, labels or distributes, AND that FDA discusses in this letter as " +
          "violative or as part of the violations (adulterated, misbranded, an unapproved new drug, or " +
          "made under the cited CGMP failures).",
        false_when: [
          "A test reagent, growth medium, control, standard, or comparator product.",
          "A competitor or reference product named only for contrast.",
          "Equipment, a facility area, a supplier, or a regulation — not a product at all.",
          "A term merely mentioned in passing with no tie to the violations.",
        ],
        evidence: c.text,
        note: "Judge only from the letter; do not infer products the letter does not discuss.",
      },
    };
  }

  const result = await evaluate({
    model: JEV_MODEL,
    // State can be a string or a JSON object; give Jev the text plus structured hints.
    // Lead with the facts the code already measured; the raw letter is reference
    // (idea #4: Jev's accuracy drops as irrelevant state grows, so the measured
    // signals go first and the full text follows, not the other way round).
    state: {
      extracted: {
        company: cands.company,
        facility: cands.facility,
        organisms: cands.organisms,
        product_name_redacted: redacted,
        citation_categories: cands.citations.categories,
        products_named_in_letter: candidatesInLetter(text, cands.drugs).map((c) =>
          String(c.payload?.name),
        ),
      },
      warning_letter: text,
    },
    questions: {
      document_type: {
        type: "choice",
        instructions: "What type of regulatory document is this?",
        criteria: {
          warning_letter: "An FDA Warning Letter",
          other_regulatory: "Another FDA regulatory communication (e.g. 483, untitled letter)",
          unknown: "Cannot determine",
        },
      },

      ...subjectQuestions,

      drug_candidate: {
        type: "choice",
        instructions:
          "Which candidate is the drug product that is the primary subject of this warning letter? " +
          "If several products are equally the subject, choose the one FDA discusses first or most. " +
          "Choose a candidate ONLY if it is explicitly supported by the document. " +
          "If the product name is redacted (e.g. (b)(4)) or cannot be identified, choose unknown.",
        criteria: drugCriteria,
      },

      indication_candidate: {
        type: "choice",
        instructions:
          "Which candidate best represents the indication of the drug that is the subject of this letter? " +
          "Choose only an indication supported by the document or the supplied candidate context; otherwise unknown.",
        criteria: indicationCriteria,
      },

      is_sterile_product: {
        type: "boolean",
        instructions:
          "The letter concerns a sterile drug product or a sterile / aseptic drug manufacturing process.",
      },
      has_cgmp_violation: {
        type: "boolean",
        instructions:
          "The letter cites violations of current good manufacturing practice (CGMP) requirements.",
      },
      has_aseptic_violation: {
        type: "boolean",
        instructions:
          "The letter describes deficiencies in aseptic processing or aseptic technique.",
      },
      has_env_monitoring_violation: {
        type: "boolean",
        instructions:
          "The letter describes inadequate environmental or personnel monitoring of classified areas.",
      },
      has_contamination: {
        type: "boolean",
        instructions:
          "The letter describes actual microbial or particulate contamination of the product or process.",
      },
      contamination_linked_to_complaints: {
        type: "boolean",
        instructions:
          "The letter states that organisms from the facility match organisms found in consumer complaint samples.",
      },
      has_recall_concern: {
        type: "boolean",
        instructions:
          "FDA identifies a potential need to recall, withdraw, quarantine, or assess distributed product.",
      },

      severity: {
        type: "score",
        instructions: "Overall severity of the compliance situation described.",
        criteria: [
          "Minor / administrative",
          "Moderate CGMP gaps, no clear patient risk",
          "Serious quality-system failure with potential patient risk",
          "Severe: confirmed contamination reaching distributed product",
        ],
      },
    },
    // ZDR (data not retained by the provider) requires a Vercel Pro/Enterprise
    // plan. Opt in with JEV_ZERO_DATA_RETENTION=1; default off so hobby plans work.
    ...(process.env.JEV_ZERO_DATA_RETENTION === "1"
      ? { providerOptions: { gateway: { zeroDataRetention: true } } }
      : {}),
  });

  const confidence = (
    result as unknown as {
      providerMetadata?: { typesafe?: { confidence?: number } };
    }
  ).providerMetadata?.typesafe?.confidence;

  return {
    answers: result.answers as unknown as JevRawAnswers,
    confidence,
    raw: result,
  };
}
