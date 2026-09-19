/**
 * Candidate gathering: deterministic extraction plus the two optional,
 * network-backed candidate sources.
 *
 *   extractCandidates()            deterministic spans (always)
 *   + proposeProductCandidates()   LLM proposes names, code keeps only verbatim
 *                                  substrings of the letter            (opts.propose)
 *   + productsForLabeler()         openFDA NDC products for the company, only
 *                                  when the product name is redacted   (opts.seedFromOpenFda)
 *
 * Jev still only *selects*; nothing here lets a model author an output span.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractCandidates, type ExtractOptions } from "./extract.js";
import { enumerateProductCandidates } from "./enumerate.js";
import { productsForLabeler, toCandidate } from "./openfda.js";
import {
  DEFAULT_PROPOSER_MODEL,
  proposeProductCandidates,
  type ProposeResult,
  type RejectedProposal,
} from "./propose.js";
import type { Candidate, ExtractedCandidates } from "./types.js";

export interface GatherOptions extends ExtractOptions {
  /**
   * Enumerate candidate product spans deterministically (enumerate.ts) and let
   * Jev's subject nouls select — the pure-Jev, gateway-free default. Set false
   * to fall back to the extract.ts regex candidates only.
   */
  enumerate?: boolean;
  /** Propose product names with an LLM via the gateway (comparison only; off by default). */
  propose?: boolean;
  proposerModel?: string;
  /** When the product name is redacted, seed candidates from openFDA by labeler. */
  seedFromOpenFda?: boolean;
  /** Serve proposer/openFDA results from the on-disk cache only. */
  offline?: boolean;
}

export interface GatherTrace {
  enumerate?: { candidates: number };
  proposer?:
    | { model: string; accepted: number; rejected: RejectedProposal[]; cached: boolean }
    | { error: string };
  redaction_override?: boolean;
  openfda?: { labeler: string; seeded: number };
}

const PROPOSE_CACHE_DIR = path.join(process.cwd(), ".cache", "propose");
const PROPOSE_SRC = fileURLToPath(new URL("./propose.ts", import.meta.url));

/** Proposer calls are cached on (letter, model, proposer source) so evals are repeatable and free. */
async function cachedPropose(
  text: string,
  model: string,
  offline: boolean,
): Promise<{ result: ProposeResult; cached: boolean }> {
  const key = createHash("sha256")
    .update(text)
    .update(model)
    .update(readFileSync(PROPOSE_SRC, "utf8"))
    .digest("hex");
  const file = path.join(PROPOSE_CACHE_DIR, `${key}.json`);
  if (existsSync(file)) {
    return { result: JSON.parse(readFileSync(file, "utf8")) as ProposeResult, cached: true };
  }
  if (offline) throw new Error("proposer result not cached and offline=true");
  const result = await proposeProductCandidates(text, { model });
  mkdirSync(PROPOSE_CACHE_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(result, null, 2));
  return { result, cached: false };
}

/** Dedupe key: case-insensitive, and "Hydro Shot Hydrogen Beverages" ≡ "…Beverage". */
const nameKey = (c: Candidate) =>
  String(c.payload?.name ?? c.id)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/s$/, "");

const CITATION_NEAR =
  /\b(?:21\s*CFR|C\.?F\.?R\.?|U\.?S\.?C\.?|section\s+\d|§)\b/i;

/**
 * A finished-product-shaped name: carries a dosage form or a strength. Used to
 * correct the redaction signal — redaction.ts flags product_name_redacted from
 * (b)(4) context alone and can't see that a real product is ALSO named in clear
 * (a (b)(4) on a strength/lot fooled it). "epinephrine injection USP 0.1 mg/mL"
 * and "Ketoconazole 2%" match; the bare API "Naphazoline HCl" does not.
 */
const FINISHED_PRODUCT =
  /\b(injection|injectable|solution|suspension|tablets?|capsules?|powder|concentrate|gel|cream|ointment|lotion|spray|drops|ophthalmic|syrup|patch|inhalation|nasal|topical|beverage|serum)\b|\d\s*(?:mg|mcg|mL|ml|%|IU)\b/i;

/**
 * Deterministic evidence for one candidate, in the spirit of the Tetris agent
 * handing Jev pre-computed facts rather than a bare label. Attached to the
 * candidate's `text`, which Jev sees as the choice criterion and the subject
 * question's `evidence`. Nothing here is model-generated.
 */
function evidenceFor(text: string, name: string): string {
  const hay = text.toLowerCase();
  const needle = name.toLowerCase();
  let count = 0;
  let nearRedaction = false;
  let nearCitation = false;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) {
    count++;
    const ctx = text.slice(Math.max(0, i - 60), i + needle.length + 60);
    if (/\(b\)\s*\(\d\)/.test(ctx)) nearRedaction = true;
    if (CITATION_NEAR.test(ctx)) nearCitation = true;
  }
  const facts = [`stated in the letter ${count}×`];
  if (nearCitation) facts.push("appears next to a regulatory citation");
  if (nearRedaction) facts.push("appears next to a (b)(4) redaction");
  return facts.join("; ");
}

/** Append deterministic evidence to every candidate named verbatim in the letter. */
function annotateEvidence(text: string, drugs: Candidate[]): Candidate[] {
  const hay = text.toLowerCase();
  return drugs.map((c) => {
    const name = c.payload?.name;
    if (typeof name !== "string" || !hay.includes(name.toLowerCase())) return c;
    return { ...c, text: `${c.text} [${evidenceFor(text, name)}]` };
  });
}

export async function gatherCandidates(
  text: string,
  opts: GatherOptions = {},
): Promise<{ cands: ExtractedCandidates; trace: GatherTrace }> {
  const cands = extractCandidates(text, opts);
  const trace: GatherTrace = {};
  let drugs = cands.drugs;

  // Pure-Jev candidate source (default): deterministic high-recall enumeration
  // supersedes the extract.ts prose/quote regexes (drug_p_/drug_q_). KB literal
  // matches (drug_<name>) and facility seeds (drug_fac_) stay; Jev's subject
  // nouls then select. No gateway involved.
  if (opts.enumerate !== false) {
    const kept = drugs.filter((c) => !/^drug_[pq]_/.test(c.id));
    const seen = new Set(kept.map(nameKey));
    const enumerated = enumerateProductCandidates(text).filter(
      (c) => !seen.has(nameKey(c)) && seen.add(nameKey(c)),
    );
    drugs = [...kept, ...enumerated];
    trace.enumerate = { candidates: enumerated.length };
  }

  if (opts.propose) {
    const model = opts.proposerModel ?? process.env.JEV_PROPOSER_MODEL ?? DEFAULT_PROPOSER_MODEL;
    try {
      const { result, cached } = await cachedPropose(text, model, opts.offline ?? false);
      trace.proposer = {
        model: result.model,
        accepted: result.candidates.length,
        rejected: result.rejected,
        cached,
      };
      // A product *class* ("ophthalmic products") is not a name Jev should select.
      const proposed = result.candidates
        .filter((c) => c.payload?.kind !== "generic_product_class")
        .sort(
          (a, b) =>
            Number(b.payload?.role === "subject_of_violation") -
            Number(a.payload?.role === "subject_of_violation"),
        );
      // The verified proposals supersede the prose/quote regex heuristics; KB
      // literal matches, facility seeds and caller-supplied candidates stay.
      const kept = drugs.filter((c) => !/^drug_[pq]_/.test(c.id));
      const seen = new Set(kept.map(nameKey));
      drugs = [...kept, ...proposed.filter((c) => !seen.has(nameKey(c)) && seen.add(nameKey(c)))];
    } catch (e) {
      // Regex candidates are still valid on their own; record why the proposer did not run.
      trace.proposer = { error: e instanceof Error ? e.message : String(e) };
    }
  }

  // Correct an over-firing redaction signal: if a finished-product-shaped name
  // is stated verbatim in the letter (dosage form or strength), the product is
  // not actually redacted — the (b)(4) that fooled redaction.ts was on a
  // strength/lot. A clearly-named product should stay selectable as drug.name,
  // while a letter naming only bare APIs ("Naphazoline HCl") stays redacted.
  if (cands.redaction.product_name_redacted) {
    const hay = text.toLowerCase();
    const namedInClear = drugs.some((c) => {
      const n = c.payload?.name;
      if (typeof n !== "string" || !String(c.payload?.source).startsWith("letter")) return false;
      if (!FINISHED_PRODUCT.test(n)) return false;
      // The name must appear at least once AWAY from a (b)(4) marker — otherwise
      // the finished-product-shaped token IS the redacted slot (e.g. Bausch's
      // "(b)(4)" ophthalmic products), not a product named in clear.
      const needle = n.toLowerCase();
      for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) {
        const around = text.slice(Math.max(0, i - 20), i + needle.length + 20);
        if (!/\(b\)\s*\(\d\)/.test(around)) return true;
      }
      return false;
    });
    if (namedInClear) {
      cands.redaction = { ...cands.redaction, product_name_redacted: false };
      trace.redaction_override = true;
    }
  }

  const indications = [...cands.indications];
  if (opts.seedFromOpenFda && cands.redaction.product_name_redacted && cands.company) {
    const records = await productsForLabeler(cands.company, { offline: opts.offline });
    const seen = new Set(drugs.map(nameKey));
    let seeded = 0;
    for (const rec of records) {
      const cand = toCandidate(rec, "openfda-labeler");
      if (seen.has(nameKey(cand))) continue;
      seen.add(nameKey(cand));
      drugs.push(cand);
      seeded++;
      if (rec.indication) {
        indications.push({
          id: `ind_${rec.name.toLowerCase().replace(/\W+/g, "_")}`,
          text: `${rec.indication} (indication of ${rec.name})`,
          payload: { name: rec.name, indication: rec.indication },
        });
      }
    }
    trace.openfda = { labeler: cands.company, seeded };
  }

  return { cands: { ...cands, drugs: annotateEvidence(text, drugs), indications }, trace };
}
