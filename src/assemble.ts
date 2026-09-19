/**
 * Deterministic assembler.
 *
 * Takes Jev's *selections* and copies the corresponding candidate spans through
 * verbatim, enriching the drug from the KB. Jev decides "which one"; this code
 * decides nothing about the actual text of the answer.
 */

import { lookup } from "./drug-kb.js";
import { subjectKey, crossReferenceLeads, type JevResult } from "./classify.js";
import { noulUncertain, choiceUncertain, type ReviewFlag } from "./review.js";
import type {
  Candidate,
  ExtractedCandidates,
  ProductMention,
  ViolationCategory,
  WarningLetter,
} from "./types.js";

const P = (p: number | undefined, t = 0.5) => (p ?? 0) >= t;

/** Jev's `confidence` may be a number, an object (per-question), or undefined. */
const asNumber = (v: unknown, fallback = 0): number => (typeof v === "number" ? v : fallback);

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

  // --- Products (Jev answers one yes/no per candidate named in the letter) ---
  // Warning letters routinely name several subject products; the single choice
  // below collapses to `unknown` for them, so the per-candidate subject
  // questions are the real signal.
  const products: ProductMention[] = cands.drugs
    .filter((c) => typeof c.payload?.name === "string" && nameInText(letterText, c.payload.name))
    .map((c) => {
      const p = a[subjectKey(c.id)]?.probability;
      return {
        name: c.payload!.name as string,
        kind: (c.payload?.kind as string | undefined) ?? null,
        is_subject: P(p),
        subject_probability: p == null ? null : Number(p.toFixed(3)),
        needs_review: p != null && noulUncertain(p),
      };
    })
    .sort((x, y) => (y.subject_probability ?? 0) - (x.subject_probability ?? 0));

  // --- Drug (Jev selects, we copy + enrich) ---
  // Prefer the single choice; if it abstained (`unknown`) only because several
  // products tie, fall back to the highest-scoring subject product. Never
  // fabricate one when the product name is redacted.
  const chosenDrugId = a.drug_candidate.choice;
  const singleChoice = chosenDrugId === "unknown" ? undefined : findCandidate(cands.drugs, chosenDrugId);
  const topSubject = products.find((p) => p.is_subject);
  const fallback =
    !singleChoice && !cands.redaction.product_name_redacted && topSubject
      ? findCandidate(cands.drugs, cands.drugs.find((c) => c.payload?.name === topSubject.name)?.id ?? "")
      : undefined;
  const chosen = singleChoice ?? fallback;
  const chosenName = (chosen?.payload?.name as string | undefined) ?? null;
  const drugProb = asNumber(
    singleChoice
      ? a.drug_candidate.probabilities?.[chosenDrugId] ?? conf
      : topSubject?.subject_probability ?? conf,
  );
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

  // --- Uncertainty routing (consistency_noul + confidence-routing) ---
  const review: ReviewFlag[] = [];
  const signalNouls: [string, number][] = [
    ["is_sterile_product", a.is_sterile_product.probability],
    ["has_cgmp_violation", a.has_cgmp_violation.probability],
    ["has_aseptic_violation", a.has_aseptic_violation.probability],
    ["has_env_monitoring_violation", a.has_env_monitoring_violation.probability],
    ["has_contamination", a.has_contamination.probability],
    ["contamination_linked_to_complaints", a.contamination_linked_to_complaints.probability],
    ["has_recall_concern", a.has_recall_concern.probability],
  ];
  for (const [field, p] of signalNouls) {
    if (noulUncertain(p))
      review.push({ field, kind: "noul", value: P(p), certainty: Number(p.toFixed(3)), reason: "probability in the uncertain band [0.30, 0.70]" });
  }
  for (const prod of products) {
    if (prod.needs_review)
      review.push({
        field: `product:${prod.name}`,
        kind: "noul",
        value: prod.is_subject,
        certainty: prod.subject_probability ?? 0,
        reason: "subject probability in the uncertain band [0.30, 0.70]",
      });
  }
  // The drug selection is a Choice: gate on its confidence, but only when a real
  // product was in play (a redacted letter legitimately resolves to null).
  if (chosenName != null && choiceUncertain(a.drug_candidate.confidence))
    review.push({
      field: "drug",
      kind: "choice",
      value: chosenName,
      certainty: Number((a.drug_candidate.confidence ?? 0).toFixed(3)),
      reason: `drug selection confidence below ${0.65}`,
    });
  if (choiceUncertain(a.document_type.confidence))
    review.push({
      field: "document_type",
      kind: "choice",
      value: a.document_type.choice,
      certainty: Number((a.document_type.confidence ?? 0).toFixed(3)),
      reason: `document_type confidence below ${0.65}`,
    });

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
      cross_reference_leads: crossReferenceLeads(cands.drugs),
    },

    products,

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

    needs_review: review.length > 0,
    review,

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
