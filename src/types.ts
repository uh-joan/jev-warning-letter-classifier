/**
 * Target output schema for the classifier.
 *
 * Design note: none of these string values are *generated* by Jev. Every span
 * (company, drug name, indication, organisms, dates) is produced by deterministic
 * extraction; Jev only *selects* among candidates and answers bounded judgments.
 * See classify.ts / assemble.ts.
 */

export interface Confidenced {
  /** 0..1 model confidence for the classification that produced this field. */
  confidence: number;
}

export interface DrugEntity extends Confidenced {
  /** Brand/product name, verbatim from the letter or a supplied candidate. null when redacted/unknown. */
  name: string | null;
  /** Active ingredient, enriched from the local KB once a drug is chosen. */
  active_ingredient: string | null;
  /** Approved indication, from candidate selection or KB enrichment. */
  indication: string | null;
  route: string | null;
  dosage_form: string | null;
  /** Why name is null, when it is: e.g. "redacted (b)(4)" or "not identifiable". */
  redaction_note: string | null;
}

export type ViolationCategory =
  | "CGMP"
  | "sterility"
  | "aseptic_processing"
  | "environmental_monitoring"
  | "data_integrity"
  | "labeling"
  | "adulteration"
  | "other";

export interface Contamination {
  present: boolean;
  /** Organism names extracted deterministically from the letter text. */
  organisms: string[];
  /** True when the letter links facility organisms to consumer-complaint samples. */
  linked_to_complaints: boolean;
}

export interface WarningLetter {
  document_type: "warning_letter" | "other_regulatory" | "unknown";
  regulator: string; // "FDA"
  issuing_office: string | null; // e.g. "CDER"
  company: string | null;
  facility: {
    name: string | null;
    location: string | null;
    fei: string | null;
  };
  warning_letter_date: string | null; // ISO where possible

  drug: DrugEntity;

  is_sterile_product: boolean;
  violation_categories: ViolationCategory[];
  contamination: Contamination;
  recall_concern: boolean;

  /** Full raw probability/confidence detail from Jev, for auditing. */
  _jev: unknown;
}

/** A single extraction candidate handed to Jev as a Choice option. */
export interface Candidate {
  id: string; // stable key used as the Choice criterion key
  text: string; // human-readable description shown to Jev
  /** Optional payload copied through verbatim once selected. */
  payload?: Record<string, unknown>;
}

export interface ExtractedCandidates {
  company: string | null;
  facility: { name: string | null; location: string | null; fei: string | null };
  date: string | null;
  issuing_office: string | null;
  organisms: string[];
  /** Drug candidates: from the letter text + any caller-supplied cross-reference list. */
  drugs: Candidate[];
  /** Indication candidates aligned to drug candidates (may be empty). */
  indications: Candidate[];
}
