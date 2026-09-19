/**
 * Redaction analysis.
 *
 * FDA Warning Letters redact trade-secret information behind FOIA exemption
 * markers: "(b)(4)" (confidential commercial info), "(b)(6)" (personal
 * privacy), "(b)(7)(C)" (law-enforcement personal privacy), etc.
 *
 * The critical question for downstream classification is *what* got redacted.
 * Often "(b)(4)" hides the product name itself ("drug products, including
 * (b)(4)"). Just as often it hides a lot number, temperature, quantity, or
 * supplier name while the product is named in clear elsewhere in the letter.
 * `analyzeRedactions` gives a deterministic signal distinguishing the two:
 * each marker is classified by the words immediately around it, and
 * `product_name_redacted` / `product_redaction_score` summarize whether any
 * marker plausibly stands in for the product name.
 */

export interface RedactionSpan {
  index: number;
  marker: string;
  /** ~80 chars each side of the marker, from the original text. */
  context: string;
  role:
    | "product_name"
    | "api_or_ingredient"
    | "lot_or_batch"
    | "quantity_or_parameter"
    | "supplier_or_party"
    | "date_or_time"
    | "unknown";
}

export interface RedactionReport {
  total: number;
  spans: RedactionSpan[];
  by_role: Record<string, number>;
  product_name_redacted: boolean;
  /** 0..1 — strength/count-weighted confidence that the product name is among the redacted spans. */
  product_redaction_score: number;
  /** Context snippets for the spans that drove `product_name_redacted`. */
  evidence: string[];
}

// Matches "(b)(4)", "(b)(6)", "(b)(7)(C)" and whitespace variants like "(b) (4)".
const MARKER_PATTERN = /\(\s*b\s*\)\s*\(\s*(\d)\s*\)(?:\s*\(\s*([A-Za-z])\s*\))?/g;

const CONTEXT_RADIUS = 80;

function normalizeQuotes(s: string): string {
  return s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
}

/** Strip trailing whitespace/quote characters, keeping other punctuation. */
function trimLeft(s: string): string {
  return normalizeQuotes(s).replace(/[\s"']+$/, "");
}

/** Strip leading whitespace/quote characters, keeping other punctuation. */
function trimRight(s: string): string {
  return normalizeQuotes(s).replace(/^[\s"']+/, "");
}

interface RoleMatch {
  role: RedactionSpan["role"];
  /** Only meaningful for role === "product_name"; used for product_redaction_score. */
  strength: number;
}

const TIME_UNITS = /^(minutes?|mins?|hours?|hrs?|seconds?|secs?|days?|weeks?|months?)\b/i;

function classifyRole(leftTrimmed: string, rightTrimmed: string): RoleMatch {
  // 1) quantity_or_parameter — temperatures, durations, percentages, counts of
  //    batches/units. Checked first: these patterns are tight and specific,
  //    and should win over broader "manufacture (b)(4)"-style product signals.
  if (/^°\s*[cf]\b/i.test(rightTrimmed)) return { role: "quantity_or_parameter", strength: 0 };
  if (/^%/.test(rightTrimmed)) return { role: "quantity_or_parameter", strength: 0 };
  if (TIME_UNITS.test(rightTrimmed)) return { role: "quantity_or_parameter", strength: 0 };
  if (/\bfor$/i.test(leftTrimmed) && (/^at\b/i.test(rightTrimmed) || TIME_UNITS.test(rightTrimmed))) {
    return { role: "quantity_or_parameter", strength: 0 };
  }
  if (/^(?:[a-z]+\s+){0,2}batch(?:es)?\b/i.test(rightTrimmed)) {
    return { role: "quantity_or_parameter", strength: 0 };
  }
  if (/^(batches|units|tablets|capsules|lots|kg|kilograms|grams|liters|litres|gallons|ml|mg)\b/i.test(rightTrimmed)) {
    return { role: "quantity_or_parameter", strength: 0 };
  }
  if (/\b(temperature|stored at|held at|storage condition)$/i.test(leftTrimmed)) {
    return { role: "quantity_or_parameter", strength: 0 };
  }

  // 2) lot_or_batch — an identifier for a specific lot/batch is redacted.
  if (/\b(lot|batch)\s*#?\s*:?\s*$/i.test(leftTrimmed)) return { role: "lot_or_batch", strength: 0 };
  if (/^(lot|batch)\s*(codes?|numbers?|no\.?|#)?\b/i.test(rightTrimmed)) {
    return { role: "lot_or_batch", strength: 0 };
  }

  // 3) api_or_ingredient
  if (/^(API|active\s+ingredient|drug\s+substance)\b/i.test(rightTrimmed)) {
    return { role: "api_or_ingredient", strength: 0 };
  }
  if (/\bactive\s+(pharmaceutical\s+)?ingredient\s*$/i.test(leftTrimmed)) {
    return { role: "api_or_ingredient", strength: 0 };
  }

  // 4) supplier_or_party
  if (
    /\b(your|the)$/i.test(leftTrimmed) &&
    /^(supplier|vendor|contract\s+manufacturer|manufacturer|distributor|laboratory|lab)\b/i.test(rightTrimmed)
  ) {
    return { role: "supplier_or_party", strength: 0 };
  }
  if (/\b(contract\s+manufacturer|supplier|vendor|distributor)\s*$/i.test(leftTrimmed)) {
    return { role: "supplier_or_party", strength: 0 };
  }

  // 5) date_or_time
  if (/\bon$/i.test(leftTrimmed) && /^,/.test(rightTrimmed)) {
    return { role: "date_or_time", strength: 0 };
  }

  // 6) product_name — broader signals, checked last since they can overlap
  //    with the more specific categories above.
  if (/product[s]?\b[\s\S]{0,25}including$/i.test(leftTrimmed)) {
    return { role: "product_name", strength: 0.75 };
  }
  if (/\byour$/i.test(leftTrimmed) && /^products?\b/i.test(rightTrimmed)) {
    return { role: "product_name", strength: 0.85 };
  }
  if (
    /^(ophthalmic|oral|topical|injectable|sterile|parenteral)?\s*(solutions?|tablets?|capsules?|injections?|creams?|ointments?|suspensions?|drug\s+products?|products?)\b/i.test(
      rightTrimmed,
    )
  ) {
    return { role: "product_name", strength: 0.8 };
  }
  if (/\bbatches\s+of$/i.test(leftTrimmed)) {
    return { role: "product_name", strength: 0.7 };
  }
  if (/\bmanufacture[sd]?$/i.test(leftTrimmed)) {
    return { role: "product_name", strength: 0.55 };
  }

  return { role: "unknown", strength: 0 };
}

export function analyzeRedactions(text: string): RedactionReport {
  const spans: RedactionSpan[] = [];
  const productStrengths: number[] = [];
  const evidence: string[] = [];

  let m: RegExpExecArray | null;
  while ((m = MARKER_PATTERN.exec(text))) {
    const index = m.index;
    const end = index + m[0]!.length;
    const digit = m[1]!;
    const letter = m[2];
    const marker = `(b)(${digit})${letter ? `(${letter.toUpperCase()})` : ""}`;

    const contextStart = Math.max(0, index - CONTEXT_RADIUS);
    const contextEnd = Math.min(text.length, end + CONTEXT_RADIUS);
    const context = text.slice(contextStart, contextEnd);

    const leftTrimmed = trimLeft(text.slice(contextStart, index));
    const rightTrimmed = trimRight(text.slice(end, contextEnd));

    const { role, strength } = classifyRole(leftTrimmed, rightTrimmed);

    spans.push({ index, marker, context, role });

    if (role === "product_name") {
      productStrengths.push(strength);
      evidence.push(context);
    }
  }

  const by_role: Record<string, number> = {};
  for (const s of spans) {
    by_role[s.role] = (by_role[s.role] ?? 0) + 1;
  }

  // Probabilistic OR across independent product-name signals, so repeated or
  // stronger evidence pushes the score up without exceeding 1.
  const product_redaction_score =
    productStrengths.length === 0
      ? 0
      : Math.round((1 - productStrengths.reduce((acc, s) => acc * (1 - s), 1)) * 100) / 100;

  return {
    total: spans.length,
    spans,
    by_role,
    product_name_redacted: product_redaction_score >= 0.5,
    product_redaction_score,
    evidence,
  };
}
