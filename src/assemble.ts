/**
 * Deterministic assembler.
 *
 * Takes Jev's *selections* and copies the corresponding candidate spans through
 * verbatim, enriching the drug from the KB. Jev decides "which one"; this code
 * decides nothing about the actual text of the answer.
 */

import { lookup } from "./drug-kb.js";
import type { JevResult } from "./classify.js";
import type {
  Candidate,
  ExtractedCandidates,
  ViolationCategory,
  WarningLetter,
} from "./types.js";

const P = (p: number | undefined, t = 0.5) => (p ?? 0) >= t;

function findCandidate(list: Candidate[], id: string): Candidate | undefined {
  return list.find((c) => c.id === id);
}

/** True when `name` appears verbatim (case-insensitive) in the letter text. */
function nameInText(text: string | undefined, name: string): boolean {
  return text ? text.toLowerCase().includes(name.toLowerCase()) : false;
}

export function assemble(
  cands: ExtractedCandidates,
  jev: JevResult,
  letterText?: string,
): WarningLetter {
  const a = jev.answers;
  const conf = jev.confidence ?? 0;

  // --- Drug (Jev selects, we copy + enrich) ---
  const chosenDrugId = a.drug_candidate.choice;
  const drugProb = a.drug_candidate.probabilities?.[chosenDrugId] ?? conf;
  const chosen = chosenDrugId === "unknown" ? undefined : findCandidate(cands.drugs, chosenDrugId);
  const chosenName = (chosen?.payload?.name as string | undefined) ?? null;
  const rec = chosenName ? lookup(chosenName) : undefined;
  // The name is "in the letter" when it is stated verbatim there — regardless of
  // whether the candidate came from extraction or a cross-reference list. A
  // cross-reference lead whose name also appears in the letter is not a redaction.
  const fromLetter = chosenName != null && nameInText(letterText, chosenName);

  // --- Indication (Jev selects, we copy) ---
  const chosenIndId = a.indication_candidate.choice;
  const chosenInd = chosenIndId === "unknown" ? undefined : findCandidate(cands.indications, chosenIndId);
  const indicationText =
    (chosenInd?.payload?.indication as string | undefined) ?? rec?.indication ?? null;

  // --- Violations ---
  // Legal citations are deterministic, so they are authoritative for the
  // categories they can express. Jev's CGMP judgment is only a fallback for
  // letters in which no citation was recognised at all.
  const cited = new Set(cands.citations.categories);
  const violations: ViolationCategory[] = [];
  const cgmpCited = ["CGMP_finished_pharma", "dietary_supplement_cgmp", "device_qsr"].some((c) =>
    cited.has(c),
  );
  if (cited.size > 0 ? cgmpCited : P(a.has_cgmp_violation.probability)) violations.push("CGMP");
  if (cited.has("adulteration")) violations.push("adulteration");
  if (cited.has("misbranding")) violations.push("misbranding");
  if (cited.has("unapproved_new_drug")) violations.push("unapproved_new_drug");
  if (cited.has("compounding")) violations.push("compounding");
  if (P(a.is_sterile_product.probability) && P(a.has_contamination.probability))
    violations.push("sterility");
  if (P(a.has_aseptic_violation.probability)) violations.push("aseptic_processing");
  if (P(a.has_env_monitoring_violation.probability)) violations.push("environmental_monitoring");

  return {
    document_type: a.document_type.choice as WarningLetter["document_type"],
    regulator: "FDA",
    issuing_office: cands.issuing_office,
    reference: cands.reference,
    marcs_cms: cands.marcs_cms,
    company: cands.company,
    facility: cands.facility,
    warning_letter_date: cands.date,

    drug: {
      name: chosenName,
      active_ingredient: rec?.active_ingredient ?? null,
      indication: indicationText,
      route: rec?.route ?? null,
      dosage_form: rec?.dosage_form ?? null,
      confidence: Number(drugProb.toFixed(3)),
      redaction_note:
        chosenName == null
          ? cands.redaction.product_name_redacted
            ? "product name redacted (b)(4) in the letter"
            : cands.drugs.length === 0
              ? "no product name found in letter and no cross-reference candidates supplied"
              : "no candidate supported by the letter"
          : fromLetter
            ? null
            : "selected from cross-reference candidates; not stated verbatim in the letter",
    },

    products: cands.drugs
      .filter((c) => typeof c.payload?.name === "string" && nameInText(letterText, c.payload.name))
      .map((c) => ({
        name: c.payload!.name as string,
        kind: (c.payload?.kind as string | undefined) ?? null,
        role: (c.payload?.role as string | undefined) ?? null,
      })),

    is_sterile_product: P(a.is_sterile_product.probability),
    violation_categories: violations,
    contamination: {
      present: P(a.has_contamination.probability),
      organisms: cands.organisms,
      linked_to_complaints: P(a.contamination_linked_to_complaints.probability),
    },
    recall_concern: P(a.has_recall_concern.probability),

    redaction: cands.redaction,
    citations: cands.citations,

    _jev: {
      confidence: conf,
      severity: a.severity.score,
      drug_probabilities: a.drug_candidate.probabilities,
      indication_probabilities: a.indication_candidate.probabilities,
      booleans: {
        is_sterile_product: a.is_sterile_product.probability,
        has_cgmp_violation: a.has_cgmp_violation.probability,
        has_aseptic_violation: a.has_aseptic_violation.probability,
        has_env_monitoring_violation: a.has_env_monitoring_violation.probability,
        has_contamination: a.has_contamination.probability,
        contamination_linked_to_complaints: a.contamination_linked_to_complaints.probability,
        has_recall_concern: a.has_recall_concern.probability,
      },
    },
  };
}
