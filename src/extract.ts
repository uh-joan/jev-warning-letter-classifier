/**
 * Deterministic candidate extraction.
 *
 * This does the *span* work: company, facility, dates, organisms, and a set of
 * DRUG candidates. Jev never sees the raw job of "invent the drug name" — it only
 * chooses among what we extract here (plus any caller-supplied cross-reference list).
 */

import { productsForFacility, DRUG_KB } from "./drug-kb.js";
import type { Candidate, ExtractedCandidates } from "./types.js";

const MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
};

function extractDate(text: string): string | null {
  const m = text.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})\b/i,
  );
  if (!m) return null;
  const month = MONTHS[m[1]!.toLowerCase()]!;
  const day = m[2]!.padStart(2, "0");
  return `${m[3]}-${month}-${day}`;
}

function extractCompany(text: string): string | null {
  // e.g. "Bausch & Lomb Inc." — Title-cased phrase (with optional "&" connectors)
  // ending in a corporate suffix.
  const m = text.match(
    /\b([A-Z][A-Za-z.'-]+(?:[ \t]+(?:&[ \t]+)?[A-Z][A-Za-z.'-]+){0,5})[ \t]+(Inc\.?|LLC|L\.L\.C\.|Corp\.?|Corporation|Ltd\.?|Company|Co\.?|GmbH|S\.A\.|Pharmaceuticals?)\b/,
  );
  return m ? `${m[1]} ${m[2]}`.replace(/\s+/g, " ").trim() : null;
}

function extractFacilityLocation(text: string): string | null {
  // Street + City, ST ZIP.
  const m = text.match(
    /\b(\d{1,6}\s+[A-Z][\w.'-]*(?:\s+[A-Z][\w.'-]*){0,4}(?:\s+(?:Parkway|Pkwy|Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way))?)\s*,?\s*([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?,\s*[A-Z]{2}\s*\d{5}(?:-\d{4})?)/,
  );
  if (m) return `${m[1]}, ${m[2]}`.replace(/\s+/g, " ").trim();
  // Fallback: "City, ST".
  const c = text.match(/\b([A-Z][a-zA-Z]+),\s*([A-Z]{2})\b/);
  return c ? `${c[1]}, ${c[2]}` : null;
}

function extractFei(text: string): string | null {
  const m = text.match(
    /\b(?:FDA\s+Establishment\s+Identifier|FEI)\s*(?:number|no\.?|#|:)?\s*(\d{7,12})\b/i,
  );
  return m ? m[1]! : null;
}

function extractIssuingOffice(text: string): string | null {
  if (/\bCDER\b|Center for Drug Evaluation and Research/i.test(text)) return "CDER";
  if (/\bCBER\b|Center for Biologics/i.test(text)) return "CBER";
  if (/\bCDRH\b|Center for Devices/i.test(text)) return "CDRH";
  if (/\bCVM\b|Center for Veterinary/i.test(text)) return "CVM";
  return null;
}

/** Genus species pattern: capitalized genus + lowercase species. */
function extractOrganisms(text: string): string[] {
  const out = new Set<string>();
  const re = /\b([A-Z][a-z]{2,})\s([a-z]{3,})\b/g;
  const speciesHints =
    /aeruginosa|marcescens|maltophilia|brasiliensis|coli|aureus|cepacia|magiferae|obscurus|niger|albicans|subtilis|fluorescens/;
  // Genera that show up in sterility WLs; guards against false positives like "Warning Letter".
  const genusHints =
    /Pseudomonas|Serratia|Stenotrophomonas|Aspergillus|Escherichia|Staphylococcus|Burkholderia|Bacillus|Candida|Klebsiella|Ralstonia|Geodermatophilus|Neovaginatispora|Cutibacterium|Micrococcus/;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const genus = m[1]!;
    const species = m[2]!;
    if (genusHints.test(genus) || speciesHints.test(species)) {
      out.add(`${genus} ${species}`);
    }
  }
  return [...out];
}

// Words that signal a matched Title-case phrase is regulatory boilerplate, not a
// product name. Used to reject false positives from the prose/quote heuristics.
const NON_PRODUCT_WORDS =
  /\b(Warning|Letter|Response|Act|Inspection|Inspectional|School|Form|Establishment|Registration|Division|Office|Guidance|Federal|Code|Regulation|Agency|Firm|Facility|Company|Investigator|President|Owner|Director|Compliance|Enforcement)\b/i;

/** Product/brand candidates mentioned literally in the letter. */
function extractDrugMentions(text: string): Candidate[] {
  const out = new Map<string, Candidate>();

  // 1) Known brands from the KB that literally appear in the text.
  for (const d of DRUG_KB) {
    const names = [d.name, ...(d.aliases ?? [])];
    for (const n of names) {
      const re = new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      if (re.test(text)) {
        out.set(d.name.toLowerCase(), {
          id: `drug_${d.name.toLowerCase().replace(/\W+/g, "_")}`,
          text: `${d.name} (${d.active_ingredient}) — mentioned in the letter`,
          payload: { source: "letter-text", name: d.name },
        });
      }
    }
  }

  // 2) Product names named in prose as a possessive: "your <Name> product(s)".
  //    Catches brands that are neither in the KB nor quoted (common in
  //    unapproved-drug / marketing letters). Bounded to 1..6 Title/number words.
  const prose = text.matchAll(
    /\byour\s+([A-Z][A-Za-z0-9][\w'-]*(?:\s+[A-Z0-9][\w'-]*){1,6})\s+products?\b/g,
  );
  for (const p of prose) {
    const name = p[1]!.trim().replace(/\s+/g, " ");
    const key = name.toLowerCase();
    if (out.has(key) || NON_PRODUCT_WORDS.test(name)) continue;
    out.set(key, {
      id: `drug_p_${key.replace(/\W+/g, "_")}`,
      text: `${name} — product named in the letter`,
      payload: { source: "letter-text", name },
    });
  }

  // 3) Quoted product-like tokens: "NAME (ingredient)" or bare Title-case near
  //    "drug product". Reject ALL-CAPS spans (marketing slogans/headers) and
  //    regulatory boilerplate.
  const quoted = text.matchAll(/["“]([A-Z][A-Za-z0-9 -]{2,40})["”]/g);
  for (const q of quoted) {
    const name = q[1]!.trim();
    const key = name.toLowerCase();
    if (
      !out.has(key) &&
      /[a-z]/.test(name) && // has a lowercase letter → not an ALL-CAPS slogan
      !NON_PRODUCT_WORDS.test(name)
    ) {
      out.set(key, {
        id: `drug_q_${key.replace(/\W+/g, "_")}`,
        text: `${name} — quoted product name in the letter`,
        payload: { source: "letter-quote", name },
      });
    }
  }

  return [...out.values()];
}

export interface ExtractOptions {
  /**
   * Extra drug candidates from a cross-reference step (facility → product line),
   * e.g. pulled from Cortellis / Drugs@FDA / DailyMed. Critical when the letter
   * redacts the product name as (b)(4).
   */
  extraDrugCandidates?: Candidate[];
  /** If true, seed candidates from the KB using the extracted FEI/location. */
  seedFromFacility?: boolean;
}

export function extractCandidates(text: string, opts: ExtractOptions = {}): ExtractedCandidates {
  const fei = extractFei(text);
  const location = extractFacilityLocation(text);

  const drugs = new Map<string, Candidate>();
  for (const c of extractDrugMentions(text)) drugs.set(c.id, c);

  // Optional facility-based seeding (cross-reference lead), only if the letter
  // gave us little to go on.
  if (opts.seedFromFacility) {
    const hint = fei ?? location ?? "";
    for (const d of hint ? productsForFacility(hint) : []) {
      const id = `drug_fac_${d.name.toLowerCase().replace(/\W+/g, "_")}`;
      if (![...drugs.values()].some((x) => x.payload?.name === d.name)) {
        drugs.set(id, {
          id,
          text: `${d.name} (${d.active_ingredient}) — documented at this facility (cross-reference lead, not stated in letter)`,
          payload: { source: "facility-crossref", name: d.name },
        });
      }
    }
  }

  for (const c of opts.extraDrugCandidates ?? []) drugs.set(c.id, c);

  // Indication candidates aligned to whatever drug candidates we have.
  const indications: Candidate[] = [];
  for (const c of drugs.values()) {
    const name = c.payload?.name as string | undefined;
    if (!name) continue;
    // Enrichment source provides the indication text; Jev may still pick "unknown".
    const rec = DRUG_KB.find((d) => d.name.toLowerCase() === name.toLowerCase());
    if (rec) {
      indications.push({
        id: `ind_${rec.name.toLowerCase().replace(/\W+/g, "_")}`,
        text: `${rec.indication} (indication of ${rec.name})`,
        payload: { name: rec.name, indication: rec.indication },
      });
    }
  }

  return {
    company: extractCompany(text),
    facility: { name: extractCompany(text), location, fei },
    date: extractDate(text),
    issuing_office: extractIssuingOffice(text),
    organisms: extractOrganisms(text),
    drugs: [...drugs.values()],
    indications,
  };
}
