/**
 * Deterministic legal-citation extraction and violation-taxonomy mapping.
 *
 * Same rule as extract.ts: nothing here is *generated*. Every citation is found by
 * regex over the literal document text (index = char offset of the matched token),
 * and only the taxonomy category/description are authored by this module — those
 * are fixed metadata about a known statute/regulation section, not content copied
 * from (or inferred about) the letter itself.
 */

export type CitationCategory =
  | "CGMP_finished_pharma"
  | "adulteration"
  | "misbranding"
  | "unapproved_new_drug"
  | "drug_definition"
  | "compounding"
  | "acidified_lacf_food"
  | "food_cgmp_preventive_controls"
  | "dietary_supplement_cgmp"
  | "device_qsr"
  | "device_mdr"
  | "biologics"
  | "bioresearch_gcp"
  | "tobacco"
  | "prohibited_acts"
  | "other";

export interface Citation {
  /** Reconstructed canonical citation text (from the extracted numbers, not free text). */
  raw: string;
  kind: "cfr" | "fdca" | "usc";
  title?: number;
  part?: number;
  /** e.g. "211.113(b)" — includes the CFR part prefix. */
  section?: string;
  /** e.g. "501(a)(2)(B)" */
  fdca_section?: string;
  /** e.g. "21 U.S.C. 351(a)(2)(B)" */
  usc?: string;
  category: CitationCategory;
  description: string;
  /** Char offset of the extracted token within the source text. */
  index: number;
  /** How many times this exact (kind, section) citation occurred in the text. */
  count: number;
}

// ---------------------------------------------------------------------------
// Taxonomy tables
// ---------------------------------------------------------------------------

const CGMP_SECTION_DESC: Record<string, string> = {
  "211.22": "Quality unit — organization and responsibilities",
  "211.42": "Facility design and control — aseptic processing areas",
  "211.67": "Equipment cleaning and maintenance",
  "211.84": "Testing and approval or rejection of components, containers, and closures",
  "211.100": "Written procedures / process validation",
  "211.113": "Control of microbiological contamination",
  "211.160": "Laboratory controls — general requirements",
  "211.165": "Testing and release for distribution",
  "211.166": "Stability testing",
  "211.188": "Batch production and control records",
  "211.192": "Production record review / investigation of discrepancies and failures",
  "211.194": "Laboratory records",
};

const ACIDIFIED_PART_NAMES: Record<number, string> = {
  108: "Emergency Permit Control",
  113: "Thermally Processed Low-Acid Foods Packaged in Hermetically Sealed Containers",
  114: "Acidified Foods",
};

const FDCA_TO_USC: Record<string, string> = {
  "501": "351",
  "502": "352",
  "402": "342",
  "403": "343",
  "505": "355",
  "301": "331",
  "201": "321",
  "503A": "353a",
  "503B": "353b",
};

const USC_TO_FDCA: Record<string, string> = Object.fromEntries(
  Object.entries(FDCA_TO_USC).map(([fdca, usc]) => [usc, fdca]),
);

function classifyCfr(part: number, section?: string): { category: CitationCategory; description: string } {
  if (part === 210 || part === 211) {
    if (section) {
      const base = section.match(/^\d{2,4}\.\d+/)?.[0];
      const desc = base ? CGMP_SECTION_DESC[base] : undefined;
      return {
        category: "CGMP_finished_pharma",
        description: desc ? `${desc} (21 CFR ${section})` : `CGMP requirement (21 CFR ${section})`,
      };
    }
    return {
      category: "CGMP_finished_pharma",
      description: `CGMP for finished pharmaceuticals (21 CFR Part ${part})`,
    };
  }
  if (part === 108 || part === 113 || part === 114) {
    const name = ACIDIFIED_PART_NAMES[part];
    return {
      category: "acidified_lacf_food",
      description: `${name} (21 CFR ${section ?? `Part ${part}`})`,
    };
  }
  if (part === 117) {
    return {
      category: "food_cgmp_preventive_controls",
      description: `Food CGMP / preventive controls (21 CFR ${section ?? `Part ${part}`})`,
    };
  }
  if (part === 111) {
    return {
      category: "dietary_supplement_cgmp",
      description: `Dietary supplement CGMP (21 CFR ${section ?? `Part ${part}`})`,
    };
  }
  if (part === 820) {
    return { category: "device_qsr", description: `Device quality system regulation (21 CFR ${section ?? `Part ${part}`})` };
  }
  if (part === 803) {
    return { category: "device_mdr", description: `Device medical device reporting (21 CFR ${section ?? `Part ${part}`})` };
  }
  if (part === 1271 || (part >= 600 && part <= 680)) {
    return { category: "biologics", description: `Biologics regulation (21 CFR ${section ?? `Part ${part}`})` };
  }
  if (part === 50 || part === 56 || part === 312 || part === 812) {
    return {
      category: "bioresearch_gcp",
      description: `Bioresearch / good clinical practice (21 CFR ${section ?? `Part ${part}`})`,
    };
  }
  if (part >= 1100 && part <= 1169) {
    return { category: "tobacco", description: `Tobacco product regulation (21 CFR ${section ?? `Part ${part}`})` };
  }
  return { category: "other", description: `21 CFR ${section ?? `Part ${part}`}` };
}

function classifyFdcaBase(base: string, firstSub?: string): { category: CitationCategory; description: string } {
  const sub = firstSub?.toLowerCase();
  switch (base) {
    case "501":
      return { category: "adulteration", description: "Adulterated drug" };
    case "502":
      return { category: "misbranding", description: "Misbranded drug" };
    case "402":
      return { category: "adulteration", description: "Adulterated food" };
    case "403":
      return { category: "misbranding", description: "Misbranded food" };
    case "505":
      return { category: "unapproved_new_drug", description: "New drug — approval requirement" };
    case "301":
      if (sub === "d") {
        return {
          category: "unapproved_new_drug",
          description: "Prohibited act — introducing an unapproved new drug into interstate commerce",
        };
      }
      return { category: "prohibited_acts", description: "Prohibited act" };
    case "201":
      if (sub === "p") return { category: "unapproved_new_drug", description: "New drug definition" };
      if (sub === "g") return { category: "drug_definition", description: "Drug definition" };
      return { category: "drug_definition", description: "Definitions" };
    case "503A":
    case "503a":
      return { category: "compounding", description: "Pharmacy compounding" };
    case "503B":
    case "503b":
      return { category: "compounding", description: "Outsourcing facility compounding" };
    default:
      return { category: "other", description: `FDCA § ${base}` };
  }
}

function parseFdcaLike(token: string): { base: string; firstSub?: string } {
  const m = token.match(/^(\d{3}[A-Za-z]?)((?:\([a-zA-Z0-9]+\))*)/);
  const base = m?.[1] ?? token;
  const subMatch = m?.[2]?.match(/\(([a-zA-Z0-9]+)\)/);
  return { base, firstSub: subMatch?.[1] };
}

function replaceBase(token: string, oldBase: string, newBase: string): string {
  return newBase + token.slice(oldBase.length);
}

// ---------------------------------------------------------------------------
// Regex-based extraction
// ---------------------------------------------------------------------------

type WithIndices = RegExpExecArray & { indices?: Array<[number, number] | undefined> };

/**
 * Runs a "cluster" regex (which must use the g+d flags and capture the entire
 * number-list as group 1), then re-scans that captured text with `tokenSource`
 * to split it into individual citation tokens, resolving each token's absolute
 * offset in `text` via the regex match-indices ('d' flag).
 */
function collectCluster(
  text: string,
  cluster: RegExp,
  tokenSource: string,
  build: (token: string, index: number) => Citation,
  out: Citation[],
): void {
  cluster.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = cluster.exec(text))) {
    const wm = m as WithIndices;
    const group = m[1];
    const groupRange = wm.indices?.[1];
    if (!group || !groupRange) continue;
    const groupStart = groupRange[0];
    const tokenRe = new RegExp(tokenSource, "g");
    let tm: RegExpExecArray | null;
    while ((tm = tokenRe.exec(group))) {
      out.push(build(tm[0], groupStart + tm.index));
    }
  }
}

const TOKEN_CFR_DOTTED = String.raw`\d{2,4}\.\d+[a-zA-Z]?(?:\([a-zA-Z0-9]+\))*`;
const TOKEN_CFR_PART = String.raw`\d{2,4}`;
const TOKEN_FDCA_USC = String.raw`\d{3}[A-Za-z]?(?:\([a-zA-Z0-9]+\))*`;

// "21 CFR 211.42(c)(10)", "21 CFR Part 108.25", "21 CFR 211.84(d)(1) and 211.84(d)(2)"
const CFR_DOTTED = new RegExp(
  String.raw`\b21\s*C\.?F\.?R\.?\s+(?:parts?\s+)?(${TOKEN_CFR_DOTTED}(?:\s*(?:,\s*|and\s+)${TOKEN_CFR_DOTTED})*)`,
  "gid",
);

// "21 CFR Part 114", "21 CFR parts 210 and 211" (rejects "Part 108.25" — handled above)
const CFR_PART_ONLY = new RegExp(
  String.raw`\b21\s*C\.?F\.?R\.?\s+parts?\s+(\b${TOKEN_CFR_PART}\b(?!\.\d)(?:\s*(?:,\s*|and\s+)\b${TOKEN_CFR_PART}\b(?!\.\d))*)`,
  "gid",
);

// "Title 21, Code of Federal Regulations, Part 108"
const CFR_SPELLED = new RegExp(
  String.raw`\bTitle\s+21,?\s+Code\s+of\s+Federal\s+Regulations,?\s+Part\s+(\b${TOKEN_CFR_PART}\b(?!\.\d))`,
  "gid",
);

// "section 501(a)(2)(B) of the Federal Food, Drug, and Cosmetic Act", "sections 301(d) and 505(a) of the Act"
const FDCA_CLUSTER = new RegExp(
  String.raw`\bsections?\s+(${TOKEN_FDCA_USC}(?:\s*(?:,\s*|and\s+)${TOKEN_FDCA_USC})*)\s+of\s+the\s+(?:Federal\s+Food,\s+Drug,\s+and\s+Cosmetic\s+Act|Act)\b`,
  "gid",
);

// "[21 U.S.C. § 342(a)(4)]", "21 U.S.C. 351(a)(2)(B)", "21 U.S.C. §§ 331(d), 355(a)"
const USC_CLUSTER = new RegExp(
  String.raw`\b21\s*U\.?S\.?C\.?\s*§{0,2}\s*(${TOKEN_FDCA_USC}(?:\s*(?:,\s*|and\s+)§{0,2}\s*${TOKEN_FDCA_USC})*)`,
  "gid",
);

function buildCfrDotted(token: string, index: number): Citation {
  const part = Number(token.split(".")[0]);
  const { category, description } = classifyCfr(part, token);
  return { raw: `21 CFR ${token}`, kind: "cfr", title: 21, part, section: token, category, description, index, count: 1 };
}

function buildCfrPart(token: string, index: number): Citation {
  const part = Number(token);
  const { category, description } = classifyCfr(part);
  return { raw: `21 CFR Part ${part}`, kind: "cfr", title: 21, part, category, description, index, count: 1 };
}

function buildFdca(token: string, index: number): Citation {
  const { base, firstSub } = parseFdcaLike(token);
  const { category, description } = classifyFdcaBase(base, firstSub);
  const uscBase = FDCA_TO_USC[base];
  return {
    raw: `FDCA § ${token}`,
    kind: "fdca",
    fdca_section: token,
    usc: uscBase ? `21 U.S.C. ${replaceBase(token, base, uscBase)}` : undefined,
    category,
    description,
    index,
    count: 1,
  };
}

function buildUsc(token: string, index: number): Citation {
  const { base, firstSub } = parseFdcaLike(token);
  const fdcaBase = USC_TO_FDCA[base];
  const { category, description } = fdcaBase
    ? classifyFdcaBase(fdcaBase, firstSub)
    : { category: "other" as CitationCategory, description: `21 U.S.C. § ${token}` };
  return {
    raw: `21 U.S.C. ${token}`,
    kind: "usc",
    title: 21,
    usc: `21 U.S.C. ${token}`,
    fdca_section: fdcaBase ? replaceBase(token, base, fdcaBase) : undefined,
    category,
    description,
    index,
    count: 1,
  };
}

function dedupeKey(c: Citation): string {
  if (c.kind === "cfr") return `cfr|${c.part}|${c.section ?? ""}`;
  if (c.kind === "fdca") return `fdca|${c.fdca_section ?? ""}`;
  return `usc|${c.usc ?? ""}`;
}

export function extractCitations(text: string): Citation[] {
  const found: Citation[] = [];

  collectCluster(text, CFR_DOTTED, TOKEN_CFR_DOTTED, buildCfrDotted, found);
  collectCluster(text, CFR_PART_ONLY, TOKEN_CFR_PART, buildCfrPart, found);
  collectCluster(text, CFR_SPELLED, TOKEN_CFR_PART, buildCfrPart, found);
  collectCluster(text, FDCA_CLUSTER, TOKEN_FDCA_USC, buildFdca, found);
  collectCluster(text, USC_CLUSTER, TOKEN_FDCA_USC, buildUsc, found);

  found.sort((a, b) => a.index - b.index);

  const seen = new Map<string, Citation>();
  const result: Citation[] = [];
  for (const c of found) {
    const key = dedupeKey(c);
    const existing = seen.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    seen.set(key, c);
    result.push(c);
  }
  return result;
}

export function summarizeViolations(citations: Citation[]): {
  categories: CitationCategory[];
  cgmp_sections: string[];
  by_category: Record<string, string[]>;
} {
  const categories = new Set<CitationCategory>();
  const cgmpSections = new Set<string>();
  const byCategory: Record<string, string[]> = {};

  for (const c of citations) {
    categories.add(c.category);
    (byCategory[c.category] ??= []).push(c.raw);
    if (c.category === "CGMP_finished_pharma" && c.section) {
      cgmpSections.add(c.section);
    }
  }

  return {
    categories: [...categories],
    cgmp_sections: [...cgmpSections],
    by_category: byCategory,
  };
}

/**
 * Data-integrity failures are usually described in language, not a distinct
 * citation (they ride on 21 CFR 211.194 / 211.68 / 211.180 / 212). Detect them
 * deterministically: FDA uses recognizable phrasing.
 */
export function detectDataIntegrity(text: string): boolean {
  return /\bdata integrity\b|\baudit trail|\bbackdat|\b(deleted|overwrit|altered|discarded|manipulat)\w*\s+(data|records?|results?)|\bshared (?:login|password|account)|\buncontrolled\s+(?:access|spreadsheet)|\b(?:results?|data)\s+(?:were|was)?\s*not recorded|\btrial (?:injection|run)|\btesting into compliance|\b211\.194\b/i.test(
    text,
  );
}

/**
 * Compounding letters cite section 503A/503B, but some write "section 503",
 * "outsourcing facility", or only describe compounding in prose. Detect it so
 * the compounding category (and its suppression of a separate new-drug charge)
 * applies consistently.
 */
export function detectCompounding(text: string): boolean {
  // High-precision signals only — bare "503" matches too much (page nums, 503(a)
  // cross-refs), so require the compounding-specific forms.
  return /\b503[AB]\b|\bsection 503[AB]\b|\b353[ab]\b|\boutsourcing facilit|\bcompounded (?:drug|sterile|human|preparation)|\bsterile compounding|\bcompounding pharmac/i.test(
    text,
  );
}

/** Broad product category a letter regulates, for scope-gating the drug fields. */
export type RegulatedProduct =
  | "drug"
  | "biologic"
  | "device"
  | "compounding"
  | "food_or_supplement"
  | "veterinary"
  | "tobacco"
  | "other";

/**
 * Classify what the letter regulates, from the issuing office and the citation
 * categories (both already extracted). `drug_relevant` says whether a drug-type
 * product is at issue — when false (a pure food/produce/sanitation letter), the
 * drug fields don't apply and code should not assert a drug.
 */
export function classifyRegulatedProduct(
  issuingOffice: string | null,
  citationCategories: string[],
): { product: RegulatedProduct; drug_relevant: boolean } {
  const c = new Set(citationCategories);
  const office = (issuingOffice ?? "").toUpperCase();

  let product: RegulatedProduct;
  if (c.has("device_qsr") || c.has("device_mdr") || office === "CDRH") product = "device";
  else if (c.has("biologics") || office === "CBER") product = "biologic";
  else if (c.has("compounding")) product = "compounding";
  else if (office === "CVM") product = "veterinary";
  else if (office === "CTP" || c.has("tobacco")) product = "tobacco";
  else if (
    c.has("CGMP_finished_pharma") ||
    c.has("unapproved_new_drug") ||
    c.has("drug_definition") ||
    office === "CDER"
  )
    product = "drug";
  else if (
    c.has("acidified_lacf_food") ||
    c.has("food_cgmp_preventive_controls") ||
    c.has("dietary_supplement_cgmp") ||
    /FOOD/.test(office) ||
    /INSPECTIONS/.test(office)
  )
    product = "food_or_supplement";
  else product = "other";

  // Whether the letter has a specific regulated product the drug fields can
  // name. True for drug/biologic/device/compounding/veterinary letters, and for
  // any letter charging a product theory (unapproved new drug, drug definition,
  // drug/supplement CGMP, misbranding) — supplement letters name their products.
  // Only a pure food-manufacturing / produce-safety / sanitation letter (generic
  // food, no product charge) has nothing to name.
  const drug_relevant =
    ["drug", "biologic", "device", "compounding", "veterinary"].includes(product) ||
    c.has("unapproved_new_drug") ||
    c.has("drug_definition") ||
    c.has("CGMP_finished_pharma") ||
    c.has("dietary_supplement_cgmp") ||
    c.has("misbranding");

  return { product, drug_relevant };
}

/**
 * Adulteration / misbranding are often charged in prose ("your products are
 * adulterated…") on short or foreign letters that don't carry a section-501/502
 * citation the parser recognizes. Detect the charge from language so the
 * category isn't lost.
 */
export function detectAdulteration(text: string): boolean {
  return /\b(?:are|is|were|was|been|deemed|considered|remain)\s+adulterated\b|\badulterated within the meaning\b|\badulterated drugs?\b|\brenders?\b[^.]{0,40}\badulterated\b/i.test(
    text,
  );
}
export function detectMisbranding(text: string): boolean {
  return /\b(?:are|is|were|was|been|deemed|considered|remain)\s+misbranded\b|\bmisbranded within the meaning\b|\bmisbranded drugs?\b/i.test(
    text,
  );
}

/**
 * Drug CGMP charged in prose ("current good manufacturing practice") on letters
 * that don't carry a parseable 21 CFR 210/211 citation — common on foreign
 * manufacturers. The caller must gate this to drug-center (CDER) letters, since
 * the same phrase covers food (21 CFR 117) and supplement (111) CGMP.
 */
export function detectDrugCgmp(text: string): boolean {
  return /\bcurrent good manufacturing practice\b|\bCGMP\s+(?:regulations?|requirements?)\b|\bconform to (?:the )?CGMP\b|\bviolations? of (?:the )?CGMP\b/i.test(
    text,
  );
}
