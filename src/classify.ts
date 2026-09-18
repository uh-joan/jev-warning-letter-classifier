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
  const drugCriteria = criteriaFrom(cands.drugs);
  const indicationCriteria = criteriaFrom(cands.indications);

  const result = await evaluate({
    model: JEV_MODEL,
    // State can be a string or a JSON object; give Jev the text plus structured hints.
    state: {
      warning_letter: text,
      extracted: {
        company: cands.company,
        facility: cands.facility,
        organisms: cands.organisms,
      },
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

      drug_candidate: {
        type: "choice",
        instructions:
          "Which candidate is the drug product that is the primary subject of this warning letter? " +
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
    providerOptions: {
      gateway: { zeroDataRetention: true },
    },
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
