/**
 * Deterministic, high-recall product-candidate enumeration — the pure-Jev
 * replacement for the LLM proposer.
 *
 * Design (from cookbooks/semantic_find + pre_parsed_value_extraction): code
 * enumerates candidate spans verbatim from the letter with high recall, then
 * Jev SELECTS which are real subject products via the per-candidate subject
 * nouls (classify.ts). No generative model and no Vercel gateway are involved;
 * every candidate is a substring of the letter, so nothing is hallucinated.
 *
 * Recall over precision here on purpose: a spurious candidate costs one bounded
 * yes/no question that Jev answers "no"; a missed product can never be recovered
 * downstream. Candidates are ranked by a deterministic prior and capped so the
 * real products survive the classify.ts question budget.
 */

import type { Candidate } from "./types.js";

/** Dosage forms / routes that anchor a product name in FDA letters. */
const DOSAGE_FORM =
  "Injection|Injectable|Solution|Suspension|Tablets?|Capsules?|Powder|Concentrate|Gel|Cream|Ointment|Lotion|Spray|Drops|Ophthalmic|Otic|Syrup|Elixir|Patch|Suppositor(?:y|ies)|Inhalation|Nasal|Topical|Beverage|Syringe|Vial|Lozenges?|Wipes?|Serum";

/** Words that mark a Title-case phrase as boilerplate, not a product (case-insensitive). */
const STOP =
  /\b(Warning|Letter|Administration|Food|Drug|Cosmetic|Act|Section|Title|Code|Federal|Regulation|Establishment|Registration|Division|Office|Center|Guidance|Agency|Firm|Facility|Company|Corporation|Inc|LLC|Ltd|GmbH|Investigator|President|Owner|Director|Compliance|Enforcement|Current|Good|Manufacturing|Practice|Quality|Form|United|States|District|County|Street|Avenue|Road|Boulevard|Drive|Suite|Court|Lane|Way|Place|Plaza|Parkway|Circle|Terrace|Response|Inspection|January|February|March|April|May|June|July|August|September|October|November|December|Monday|Tuesday|Wednesday|Thursday|Friday)\b/i;

/**
 * Regulatory acronyms, citation fragments, and document boilerplate that the
 * greedy ALL-CAPS / title patterns pick up on CGMP letters (FDA, 21 CFR, SOP
 * codes, U.S.C., addresses). None is ever a product name.
 */
const NON_PRODUCT =
  /\b(FDA|CFR|C\.F\.R|FD&C|FDCA|U\.?S\.?C|USC|CGMP|GMP|QMS|SOP|SOPs|CAPA|HVAC|RABS|LAF|LAFH|LFH|WFI|HEPA|USP|CFU|FEI|MARCS|CMS|NDC|COA|CoA|EM|PM|QC|QA|QU|API|APIs|OTC|ISO|Stat|Attachment|Image|IMAGE|Dear|Regarding|Corrective|Actions|Establishment)\b/i;

/** A citation-shaped span like "21 CFR 211.113", "127 Stat. 587", "§ 351". */
const CITATION_SHAPE = /\d+\s*(?:CFR|U\.?S\.?C|Stat|§)|§|\bStat\.|\b\d{2,5}\s+Stat\b/i;

interface Raw {
  name: string;
  index: number;
  priority: number;
  source: string;
}

const clean = (s: string) => s.replace(/\s+/g, " ").replace(/[.,;:'"()]+$/, "").trim();

/**
 * Function/verb words that mark a span as running PROSE, not a product name.
 * The greedy list/cue/title patterns otherwise grab clauses like "Studied for
 * effects on sexual arousal" or "introducing or delivering these", which Jev
 * then rates as subject-related and floods the results. A real name almost never
 * contains these; the few that do (e.g. "…concentrate for hemodialysis") are an
 * acceptable loss for the precision gained.
 */
const PROSE =
  /\b(for|on|in|at|by|from|as|to|with|these|this|that|which|can|pose|sale|use[ds]?|their|your|our|has|have|are|is|be|been|will|not|any|all|other|such|including|namely|section|sections|studied|explored|investigated|introduc\w*|deliver\w*|violat\w*|market\w*|sell|sold|distribut\w*|potential|effects?|impact|influence|modulat\w*|stimulat\w*|reduc\w*|risks?|unapproved|new|adulterat\w*|misbrand\w*)\b/i;

/** A phrase looks like a product name (not boilerplate, not a bare common word). */
function plausible(name: string): boolean {
  if (name.length < 3 || name.length > 90) return false;
  if (STOP.test(name)) return false;
  if (PROSE.test(name)) return false; // reject running-prose fragments
  if (NON_PRODUCT.test(name) || CITATION_SHAPE.test(name)) return false; // acronyms / citations
  if (/\d{3,}\s+[A-Z]/.test(name)) return false; // street addresses ("3801 Mojave Court")
  // A capital / digit / internal-cap is the usual product signal. All-lowercase
  // names ("vancomycin", "flunixin meglumine injection") are plausible too:
  // they only reach here from the specific INN / lowercase-form patterns, never
  // the broad title pattern (which requires a capital start).
  return /[A-Z0-9]/.test(name) || /^[a-z]{4,}(?:\s+[a-z]+){0,4}$/.test(name);
}

export function enumerateProductCandidates(text: string): Candidate[] {
  const raws: Raw[] = [];
  const push = (name: string, index: number, priority: number, source: string) => {
    const n = clean(name);
    if (plausible(n)) raws.push({ name: n, index, priority, source });
  };

  const titleRun = `[A-Z][A-Za-z0-9®™&/-]*(?:[ ](?:[A-Z0-9][A-Za-z0-9®™%./-]*|of|and|de|the)){0,6}`;

  // 1) Dosage-form-anchored: a Title/number run ending in (or beginning) a form word.
  //    "Fluorescein 2% Ophthalmic Solution", "Semaglutide 2.5mg/mL Injection".
  const formRe = new RegExp(
    `\\b(${titleRun}\\s+(?:${DOSAGE_FORM}))(?:\\s+[0-9][A-Za-z0-9%./ -]{0,20})?`,
    "g",
  );
  for (const m of text.matchAll(formRe)) push(m[1]!, m.index!, 3, "dosage-form");
  // Lowercase-tolerant form anchor: "<lower-word(s)> injection/solution/…".
  const lcFormRe = new RegExp(`\\b([a-z][a-z]+(?:\\s+[a-z]+){0,3}\\s+(?:${DOSAGE_FORM}))\\b`, "gi");
  for (const m of text.matchAll(lcFormRe)) push(m[1]!, m.index!, 2, "dosage-form-lc");

  // 2) A capitalized/mixed run carrying a concentration (mg, mL, %, mcg, IU).
  const concRe = new RegExp(
    `\\b(${titleRun})\\s+([0-9][0-9.,]*\\s*(?:mg|mcg|g|IU|%|mg/mL|mg/ml|MG/ML)[A-Za-z0-9/. -]*)`,
    "g",
  );
  for (const m of text.matchAll(concRe)) push(`${m[1]} ${m[2]}`, m.index!, 3, "concentration");

  // 3) Quoted strings.
  for (const m of text.matchAll(/["“”']([A-Z0-9][^"“”']{2,70})["“”']/g))
    push(m[1]!, m.index!, 2, "quoted");

  // 4) Possessive product reference: "your <X> product(s)".
  for (const m of text.matchAll(new RegExp(`\\byour\\s+(${titleRun})\\s+products?\\b`, "g")))
    push(m[1]!, m.index!, 2, "possessive");

  // 5) Enumeration lists: "including A, B, C, and D" / "products: A, B".
  for (const m of text.matchAll(
    /\b(?:including|such as|products?(?:\s+include)?[:,]|namely)\s+([A-Z0-9][^.;]{3,220})/g,
  )) {
    for (const item of m[1]!.split(/,|\band\b|\bor\b/)) push(item, m.index!, 2, "list");
  }

  // 6) Brand-shaped tokens only (NOT every capitalized word): an internal
  //    capital/digit (ReBellaWJ, MedicaLyte, Halo 2.0) or an ALL-CAPS run
  //    (ZIIP, ROODRA, 2CP, CRP-20H, GLP-1), optionally with a following token.
  for (const m of text.matchAll(/\b([A-Z][a-z]+(?:[A-Z][A-Za-z0-9]*|[0-9][A-Za-z0-9.]*)+)\b/g))
    push(m[1]!, m.index!, 2, "camel");
  for (const m of text.matchAll(/\b([A-Z0-9][A-Z0-9+]{1,}(?:[ -][A-Z0-9][A-Za-z0-9.+-]*){0,3})\b/g)) {
    if (/[A-Z]/.test(m[1]!) && !STOP.test(m[1]!)) push(m[1]!, m.index!, 2, "caps");
  }

  // 7) Lowercase INN-suffix drug substances (semaglutide, vancomycin, tadalafil).
  for (const m of text.matchAll(
    /\b([a-z]{4,}(?:afil|il|ide|ine|ium|statin|parin|mycin|cillin|azole|profen|olol|pril|sartan|prazole|dronate|tinib|mab|nib|bucil))\b/g,
  ))
    push(m[1]!, m.index!, 2, "inn");

  // 7b) Single Title-case OR lowercase tokens adjacent to a product cue word.
  //     Catches Collagen, Epithalon, Rapamycin, "ZIIP Device" near "product".
  const CUE = "products?|drug|drugs|formulations?|marketed?|brand|dietary supplement|device|sell|distribute";
  for (const m of text.matchAll(
    new RegExp(`\\b([A-Z][A-Za-z0-9+®™-]{2,}(?:[ ][A-Z0-9][A-Za-z0-9+®™.-]*){0,3})\\s+(?:${CUE})\\b`, "gi"),
  ))
    push(m[1]!, m.index!, 2, "cue-before");
  for (const m of text.matchAll(
    new RegExp(`\\b(?:${CUE})[,: ]+([A-Z][A-Za-z0-9+®™-]{2,}(?:[ ][A-Z0-9][A-Za-z0-9+®™.-]*){0,3})\\b`, "gi"),
  ))
    push(m[1]!, m.index!, 2, "cue-after");

  // 8) Plain Title-case multiword runs (broadest — low priority, filtered by STOP).
  for (const m of text.matchAll(new RegExp(`\\b(${titleRun})\\b`, "g"))) {
    if (m[1]!.includes(" ")) push(m[1]!, m.index!, 0, "title");
  }

  // Dedupe: keep the highest-priority occurrence per normalized name. The key
  // ignores case, trailing plural, ® and punctuation so "INSTI® HIV Self-Test"
  // and "INSTI HIV Self-Test" collapse.
  const key = (s: string) =>
    s.toLowerCase().replace(/[®™]/g, "").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").replace(/s$/, "").trim();
  const best = new Map<string, Raw>();
  for (const r of raws) {
    const k = key(r.name);
    const prev = best.get(k);
    if (!prev || r.priority > prev.priority) best.set(k, r);
  }

  // Prefer a longer, more specific span when one contains another of equal-ish
  // standing (e.g. keep "Semaglutide Injection" over bare "Semaglutide" only if
  // both survive; the subject noul can still pick either — but drop a candidate
  // that is a strict substring of a higher-priority one to cut duplicates).
  const kept = [...best.values()].sort((a, b) => b.priority - a.priority || a.index - b.index);
  const MAX = 80;
  const out: Candidate[] = [];
  const seen: string[] = [];
  for (const r of kept) {
    if (out.length >= MAX) break;
    const lk = key(r.name);
    if (seen.some((s) => s === lk)) continue;
    seen.push(lk);
    out.push({
      id: `drug_e_${lk.replace(/\W+/g, "_")}`,
      text: `${r.name} — named in the letter`,
      payload: { source: "letter-text", name: r.name, enum_source: r.source },
    });
  }
  return out;
}
