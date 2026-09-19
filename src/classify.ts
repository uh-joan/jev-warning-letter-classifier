/**
 * Jev classification step.
 *
 * One systemOne() call to jev via the official TypeSafe SDK (@typesafe-ai/sdk),
 * authenticated with TYPESAFE_AI_API_KEY — direct, not through the Vercel AI
 * Gateway, so it is not subject to the gateway's free-tier throttle. Jev makes
 * bounded judgments only (noul / choice / score); it generates no free text.
 */

import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { Candidate, ExtractedCandidates } from "./types.js";

export const JEV_MODEL = "jev-latest";

let client: TypeSafeClient | undefined;
/** Lazily built so the extract-only path (no key needed) can import this module. */
function jevClient(): TypeSafeClient {
  if (!client) {
    const apiKey = process.env.TYPESAFE_AI_API_KEY ?? process.env.TYPESAFE_API_KEY;
    client = new TypeSafeClient(apiKey ? { apiKey } : {});
  }
  return client;
}

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

interface ChoiceAnswer {
  choice: string;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export interface JevRawAnswers {
  document_type: ChoiceAnswer;
  drug_candidate: ChoiceAnswer;
  indication_candidate: ChoiceAnswer;
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
/**
 * jev-1.13 allows 32k tokens for state + the longest question, and its accuracy
 * falls as state grows with irrelevant detail (jaggedness #5). Warning letters
 * run ~8k tokens, but guard the tail: keep the head (header + violations, where
 * the subject products live) at a safe budget. ~3.5 chars/token, kept conservative.
 */
const STATE_CHAR_BUDGET = 90_000;
function boundLetter(text: string): string {
  if (text.length <= STATE_CHAR_BUDGET) return text;
  return (
    text.slice(0, STATE_CHAR_BUDGET) +
    "\n\n[letter truncated for length; deterministic extraction already ran on the full text]"
  );
}

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
  // its own bounded Noul (yes/no) judgment; the single choice below still handles
  // the primary product for letters that name one.
  const questions: Record<string, unknown> = {
    document_type: {
      type: "choice",
      instructions: "What type of regulatory document is this?",
      criteria: {
        warning_letter: "An FDA Warning Letter",
        other_regulatory: "Another FDA regulatory communication (e.g. 483, untitled letter)",
        unknown: "Cannot determine",
      },
    },
  };

  for (const c of candidatesInLetter(text, cands.drugs).slice(0, MAX_SUBJECT_QUESTIONS)) {
    const name = String(c.payload?.name);
    // Noul with true/false criteria (idea #2: spell out the boundary cases the
    // question exists to exclude) plus the candidate's evidence in instructions.
    questions[subjectKey(c.id)] = {
      type: "noul",
      instructions: {
        question: `Is "${name}" a subject of this warning letter?`,
        evidence: c.text,
        note: "Judge only from the letter; do not infer products the letter does not discuss.",
      },
      criteria: {
        true:
          "A drug, biologic, device or consumable product — or a drug substance/API — that this firm " +
          "makes, markets, compounds, labels or distributes, AND that FDA discusses in this letter as " +
          "violative or as part of the violations (adulterated, misbranded, an unapproved new drug, or " +
          "made under the cited CGMP failures).",
        false: [
          "A test reagent, growth medium, control, standard, or comparator product.",
          "A competitor or reference product named only for contrast.",
          "Equipment, a facility area, a supplier, or a regulation — not a product at all.",
          "A term merely mentioned in passing with no tie to the violations.",
        ],
      },
    };
  }

  // A choice needs at least one real option beside `unknown`; otherwise skip the
  // question and synthesise `unknown` rather than send a degenerate 1-option choice.
  const askDrug = Object.keys(drugCriteria).length > 1;
  const askIndication = Object.keys(indicationCriteria).length > 1;
  if (askDrug) {
    questions.drug_candidate = {
      type: "choice",
      instructions:
        "Which candidate is the drug product that is the primary subject of this warning letter? " +
        "If several products are equally the subject, choose the one FDA discusses first or most. " +
        "Choose a candidate ONLY if it is explicitly supported by the document. " +
        "If the product name cannot be identified, choose unknown.",
      criteria: drugCriteria,
    };
  }
  if (askIndication) {
    questions.indication_candidate = {
      type: "choice",
      instructions:
        "Which candidate best represents the indication of the drug that is the subject of this letter? " +
        "Choose only an indication supported by the document or the supplied candidate context; otherwise unknown.",
      criteria: indicationCriteria,
    };
  }

  Object.assign(questions, {
    is_sterile_product: {
      type: "noul",
      instructions:
        "The letter concerns a sterile drug product or a sterile / aseptic drug manufacturing process.",
    },
    has_cgmp_violation: {
      type: "noul",
      instructions: "The letter cites violations of current good manufacturing practice (CGMP) requirements.",
    },
    has_aseptic_violation: {
      type: "noul",
      instructions: "The letter describes deficiencies in aseptic processing or aseptic technique.",
    },
    has_env_monitoring_violation: {
      type: "noul",
      instructions:
        "The letter describes inadequate environmental or personnel monitoring of classified areas.",
    },
    has_contamination: {
      type: "noul",
      instructions:
        "The letter describes actual microbial or particulate contamination of the product or process.",
    },
    contamination_linked_to_complaints: {
      type: "noul",
      instructions:
        "The letter states that organisms from the facility match organisms found in consumer complaint samples.",
    },
    has_recall_concern: {
      type: "noul",
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
  });

  const result = await jevClient().systemOne({
    model: JEV_MODEL,
    // Lead with the facts the code already measured; the raw letter is reference
    // (idea #4: Jev's accuracy drops as irrelevant state grows).
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
      warning_letter: boundLetter(text),
    },
    questions: questions as never,
  });

  const answers = normalizeAnswers(result.answers as Record<string, RawAnswer>, {
    askDrug,
    askIndication,
  });
  return { answers, confidence: answers.drug_candidate.confidence, raw: result };
}

/** One answer as returned by the SDK, before normalising to JevRawAnswers. */
type RawAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number; probabilities: Record<number, number> };

const noulProb = (a: RawAnswer | undefined) => (a?.type === "noul" ? a.noul : 0);

/**
 * Convert the SDK's native answers into the internal JevRawAnswers shape
 * (Noul → `{probability}`, Choice → `{choice, probabilities, confidence}`,
 * Score → `{score, probabilities}`), synthesising `unknown` for any choice that
 * was skipped because it had no real candidates.
 */
function normalizeAnswers(
  raw: Record<string, RawAnswer>,
  opts: { askDrug: boolean; askIndication: boolean },
): JevRawAnswers {
  const choice = (key: string): { choice: string; probabilities: Record<string, number>; confidence: number } => {
    const a = raw[key];
    return a?.type === "choice"
      ? { choice: a.choice, probabilities: a.probabilities, confidence: a.confidence }
      : { choice: "unknown", probabilities: { unknown: 1 }, confidence: 1 };
  };
  const score = raw.severity;
  const answers: JevRawAnswers = {
    document_type: choice("document_type"),
    drug_candidate: opts.askDrug
      ? choice("drug_candidate")
      : { choice: "unknown", probabilities: { unknown: 1 }, confidence: 1 },
    indication_candidate: opts.askIndication
      ? choice("indication_candidate")
      : { choice: "unknown", probabilities: { unknown: 1 }, confidence: 1 },
    is_sterile_product: { probability: noulProb(raw.is_sterile_product) },
    has_cgmp_violation: { probability: noulProb(raw.has_cgmp_violation) },
    has_aseptic_violation: { probability: noulProb(raw.has_aseptic_violation) },
    has_env_monitoring_violation: { probability: noulProb(raw.has_env_monitoring_violation) },
    has_contamination: { probability: noulProb(raw.has_contamination) },
    contamination_linked_to_complaints: { probability: noulProb(raw.contamination_linked_to_complaints) },
    has_recall_concern: { probability: noulProb(raw.has_recall_concern) },
    severity: {
      score: score?.type === "score" ? score.score : 0,
      probabilities: score?.type === "score" ? score.probabilities : {},
    },
  };
  for (const [key, a] of Object.entries(raw)) {
    if (key.startsWith("subj_") && a.type === "noul") {
      (answers as unknown as Record<string, { probability: number }>)[key] = { probability: a.noul };
    }
  }
  return answers;
}
