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
  /**
   * Possible product names from a cross-reference source (openFDA / facility KB)
   * that are NOT stated in the letter — leads for a reviewer or Cortellis, never
   * asserted as the confirmed name. Populated mainly when the name is redacted.
   */
  cross_reference_leads: string[];
}

export interface ProductMention {
  name: string;
  /** "brand_product" | "active_ingredient" | … when known (proposer-supplied). */
  kind: string | null;
  /** Jev: this product is a subject of the violations (P >= 0.5). */
  is_subject: boolean;
  /** Jev's P(subject); null when the question was not asked. */
  subject_probability: number | null;
  /** P(subject) fell in the uncertain band [0.30, 0.70] — a person should confirm. */
  needs_review: boolean;
}

/** A field whose Jev answer is uncertain enough to route to a human (see review.ts). */
export interface ReviewFlag {
  field: string;
  kind: "noul" | "choice" | "score";
  value: string | number | boolean | null;
  certainty: number;
  reason: string;
}

export type ViolationCategory =
  | "CGMP"
  | "sterility"
  | "aseptic_processing"
  | "environmental_monitoring"
  | "data_integrity"
  | "labeling"
  | "adulteration"
  | "misbranding"
  | "unapproved_new_drug"
  | "compounding"
  | "bioresearch_gcp"
  | "other";

export interface Contamination {
  present: boolean;
  /** Organism names extracted deterministically from the letter text. */
  organisms: string[];
  /** True when the letter links facility organisms to consumer-complaint samples. */
  linked_to_complaints: boolean;
}

/**
 * Structured metadata published alongside the letter on fda.gov (written by
 * scripts/fetch-letter.ts as `<slug>.meta.json`). When present it is preferred
 * over regex extraction from the body: FDA already labels these fields.
 */
export interface LetterMeta {
  url?: string;
  company?: string | null;
  marcs_cms?: string | null;
  issue_date?: string | null; // ISO
  reference?: string | null; // e.g. "320-26-121"
  product?: string[]; // FDA product categories, e.g. ["Drugs", "Over-the-Counter Drugs"]
  issuing_office?: string | null;
}

/** Deterministic summary of what the letter's (b)(4) redactions hide. */
export interface RedactionSummary {
  total: number;
  by_role: Record<string, number>;
  product_name_redacted: boolean;
  score: number;
  evidence: string[];
}

/** Deterministic summary of the legal citations in the letter. */
export interface CitationSummary {
  categories: string[];
  cgmp_sections: string[];
  by_category: Record<string, string[]>;
}

export interface WarningLetter {
  document_type: "warning_letter" | "other_regulatory" | "unknown";
  regulator: string; // "FDA"
  /** What the letter regulates — drug/biologic/device/compounding/food/etc. The
   *  drug-specific fields (drug, is_sterile_product, sterility …) are meaningful
   *  only when this is a drug-type letter; on a pure food/produce letter they
   *  are suppressed. */
  regulated_product: string;
  issuing_office: string | null; // e.g. "CDER"
  /** FDA reference number / MARCS-CMS id, from page metadata when available. */
  reference: string | null;
  marcs_cms: string | null;
  company: string | null;
  facility: {
    name: string | null;
    location: string | null;
    fei: string | null;
  };
  warning_letter_date: string | null; // ISO where possible

  /** Primary subject product, selected by Jev. */
  drug: DrugEntity;
  /**
   * Every product/ingredient name found verbatim in the letter (regex, KB or
   * LLM-proposed-then-verified), each with Jev's judgment of whether it is a
   * subject of the violations. Cross-reference leads are not listed here.
   */
  products: ProductMention[];

  is_sterile_product: boolean;
  violation_categories: ViolationCategory[];
  contamination: Contamination;
  recall_concern: boolean;

  /** What the (b)(4) redactions hide — deterministic, no model involved. */
  redaction: RedactionSummary;
  /** Legal citations mapped to a violation taxonomy — deterministic. */
  citations: CitationSummary;

  /** True if any field is uncertain enough to warrant human review. */
  needs_review: boolean;
  /** The specific uncertain fields, with the probability/confidence that flagged each. */
  review: ReviewFlag[];

  /** Full raw probability/confidence detail from Jev, for auditing. */
  _jev: unknown;
  /** How the candidate set was built (proposer model, rejected proposals, openFDA seeds). */
  _candidates?: unknown;
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
  reference: string | null;
  marcs_cms: string | null;
  organisms: string[];
  redaction: RedactionSummary;
  citations: CitationSummary;
  /** Drug candidates: from the letter text + any caller-supplied cross-reference list. */
  drugs: Candidate[];
  /** Indication candidates aligned to drug candidates (may be empty). */
  indications: Candidate[];
}
