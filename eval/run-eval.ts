/**
 * Evaluation harness.
 *
 *   npm run eval [filter] [--no-jev] [--refresh] [--strict] [--propose] [--openfda]
 *
 * --propose  add LLM-proposed, verbatim-verified product candidates (cached in .cache/propose)
 * --openfda  seed candidates from openFDA by labeler when the product name is redacted
 * --split=dev|test  restrict to the held-out split (default: all letters)
 * --pace=N   sleep N seconds after every uncached gateway call (for throttled gateway plans;
 *            cached letters cost nothing, so an interrupted paced run resumes where it stopped)
 *
 * Loads every eval/gold/<slug>.json, runs the deterministic extractor (and, unless
 * --no-jev, the Jev classifier + assembler) against the referenced fixture, scores
 * the result against `expected`, and prints a per-letter report plus an aggregate
 * table. Also writes a machine-readable eval/last-report.json.
 *
 * Jev responses are cached at eval/.cache/<sha256>.json, keyed on the letter text,
 * the extracted candidates, and the contents of src/classify.ts — so a rerun with an
 * unchanged fixture/classify.ts makes zero API calls. Only `{answers, confidence}`
 * is cached (the raw AI SDK result isn't serialisable); a cache hit rebuilds a
 * `JevResult` with `raw: null` before calling `assemble`.
 *
 * `expected` keys are all optional: omitting a key skips scoring that field for that
 * letter (it still won't error, it just won't count toward pass/scored totals).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { extractCandidates, type ExtractOptions } from "../src/extract.js";
import { loadLetter } from "../src/load.js";
import { gatherCandidates } from "../src/candidates.js";
import { classifyWithJev, type JevRawAnswers, type JevResult } from "../src/classify.js";
import { assemble } from "../src/assemble.js";
import type { ExtractedCandidates, WarningLetter } from "../src/types.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const GOLD_DIR = path.join(ROOT, "eval", "gold");
const CACHE_DIR = path.join(ROOT, "eval", ".cache");
const CLASSIFY_SRC_PATH = path.join(ROOT, "src", "classify.ts");
const REPORT_PATH = path.join(ROOT, "eval", "last-report.json");

// ---------- CLI ----------

const args = process.argv.slice(2);
const noJev = args.includes("--no-jev");
const refresh = args.includes("--refresh");
const strict = args.includes("--strict");
const propose = args.includes("--propose");
const openfda = args.includes("--openfda");
const split = args.find((a) => a.startsWith("--split="))?.split("=")[1]; // "dev" | "test"
const paceSeconds = Number(args.find((a) => a.startsWith("--pace="))?.split("=")[1] ?? 0);
const pace = () => (paceSeconds > 0 ? new Promise((r) => setTimeout(r, paceSeconds * 1000)) : undefined);
let jevCacheMiss = false;
const filter = args.find((a) => !a.startsWith("--"));

function loadDotEnv() {
  try {
    const env = readFileSync(path.join(ROOT, ".env"), "utf8");
    for (const line of env.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
    }
  } catch {
    /* no .env — fine */
  }
}

// ---------- Gold schema ----------

interface GoldExpected {
  company?: string | null;
  fei?: string | null;
  date?: string | null;
  issuing_office?: string | null;
  location_contains?: string | null;
  organisms?: string[];
  products?: string[];
  product_redacted?: boolean;
  document_type?: "warning_letter";
  is_sterile_product?: boolean;
  // Free text: intentionally NOT constrained to WarningLetter's ViolationCategory
  // union, since gold may name categories the current pipeline can't yet produce.
  violation_categories?: string[];
  contamination_present?: boolean;
  linked_to_complaints?: boolean;
  recall_concern?: boolean;
}

interface GoldFile {
  fixture: string;
  options?: ExtractOptions;
  letter_type: string;
  split?: "dev" | "test";
  notes?: string;
  expected: GoldExpected;
}

interface GoldEntry {
  slug: string;
  gold: GoldFile;
}

function loadGoldFiles(): GoldEntry[] {
  if (!existsSync(GOLD_DIR)) return [];
  const files = readdirSync(GOLD_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const out: GoldEntry[] = [];
  for (const f of files) {
    const slug = f.replace(/\.json$/, "");
    if (filter && !slug.includes(filter)) continue;
    const gold = JSON.parse(readFileSync(path.join(GOLD_DIR, f), "utf8")) as GoldFile;
    if (split && (gold.split ?? "dev") !== split) continue;
    out.push({ slug, gold });
  }
  return out;
}

// ---------- Matching helpers ----------

/** case-insensitive, trim, strip trailing punctuation, collapse whitespace */
function normExact(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.,;:!?]+$/, "")
    .trim();
}

function exactMatch(expected: string | null | undefined, got: string | null): boolean {
  if (expected == null) return got == null;
  if (got == null) return false;
  return normExact(expected) === normExact(got);
}

/** case-insensitive substring match, either direction */
function substrEitherWay(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (!x || !y) return false;
  return x.includes(y) || y.includes(x);
}

function setMetrics(expected: string[], got: string[]): { precision: number; recall: number; f1: number } {
  const norm = (arr: string[]) => new Set(arr.map((s) => s.trim().toLowerCase()));
  const E = norm(expected);
  const G = norm(got);
  if (E.size === 0 && G.size === 0) return { precision: 1, recall: 1, f1: 1 };
  let tp = 0;
  for (const g of G) if (E.has(g)) tp++;
  const precision = G.size ? tp / G.size : 0;
  const recall = E.size ? tp / E.size : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1 };
}

// ---------- Scoring ----------

interface FieldResult {
  name: string;
  /** false = informational only (no gold value to compare against, e.g. candidate_noise) */
  scored: boolean;
  pass?: boolean;
  /** present for set-valued fields (organisms, violation_categories) and candidate_recall */
  f1?: number;
  expected?: unknown;
  got?: unknown;
}

function scoreExtraction(expected: GoldExpected, cands: ExtractedCandidates): FieldResult[] {
  const results: FieldResult[] = [];

  const addExact = (name: string, exp: string | null | undefined, got: string | null) => {
    if (exp === undefined) return;
    results.push({ name, scored: true, pass: exactMatch(exp, got), expected: exp, got });
  };

  addExact("company", expected.company, cands.company);
  addExact("fei", expected.fei, cands.facility.fei);
  addExact("date", expected.date, cands.date);
  addExact("issuing_office", expected.issuing_office, cands.issuing_office);

  if (expected.location_contains !== undefined) {
    const loc = cands.facility.location;
    const pass =
      expected.location_contains == null
        ? loc == null
        : (loc ?? "").toLowerCase().includes(expected.location_contains.toLowerCase());
    results.push({
      name: "location_contains",
      scored: true,
      pass,
      expected: expected.location_contains,
      got: loc,
    });
  }

  if (expected.organisms !== undefined) {
    const { f1 } = setMetrics(expected.organisms, cands.organisms);
    results.push({
      name: "organisms",
      scored: true,
      pass: f1 === 1,
      f1,
      expected: expected.organisms,
      got: cands.organisms,
    });
  }

  const candidateNames = cands.drugs.map((c) => (c.payload?.name as string | undefined) ?? c.text);

  if (expected.products !== undefined && expected.products.length > 0) {
    const matched = expected.products.filter((p) => candidateNames.some((n) => substrEitherWay(n, p)));
    const recall = matched.length / expected.products.length;
    results.push({
      name: "candidate_recall",
      scored: true,
      pass: recall === 1,
      f1: recall,
      expected: expected.products,
      got: candidateNames,
    });
  }

  if (expected.products !== undefined) {
    const goldProducts = expected.products;
    const noise = cands.drugs.filter((c) => {
      const name = c.payload?.name as string | undefined;
      const isGoldProduct = name ? goldProducts.some((p) => substrEitherWay(name, p)) : false;
      const isCrossref = /^(facility-crossref|openfda-)/.test(String(c.payload?.source ?? ""));
      return !isGoldProduct && !isCrossref;
    }).length;
    results.push({ name: "candidate_noise", scored: false, got: noise });
  }

  return results;
}

function scoreJev(expected: GoldExpected, result: WarningLetter, letterType: string): FieldResult[] {
  const results: FieldResult[] = [];

  if (expected.document_type !== undefined) {
    results.push({
      name: "document_type",
      scored: true,
      pass: result.document_type === expected.document_type,
      expected: expected.document_type,
      got: result.document_type,
    });
  }

  if (expected.product_redacted !== undefined) {
    const foodLetter = letterType === "food_supplement" || letterType === "other";
    const declinedFood =
      foodLetter && result.regulated_product === "food_or_supplement" && result.drug.name === null;
    const pass = expected.product_redacted
      ? result.drug.name === null
      : declinedFood // a food letter with no drug — null is the correct answer
        ? true
        : result.drug.name != null &&
          (expected.products ?? []).some((p) => substrEitherWay(result.drug.name!, p));
    results.push({
      name: "drug",
      scored: true,
      pass,
      expected: expected.product_redacted ? null : (expected.products ?? []),
      got: result.drug.name,
    });
  }

  // Multi-product letters: score the set of products Jev flags as subjects
  // (products[].is_subject) against the gold product list. Skip on a food letter
  // the tool correctly scoped as non-drug (drug-subject ID doesn't apply there).
  const declinedFoodLetter =
    (letterType === "food_supplement" || letterType === "other") &&
    result.regulated_product === "food_or_supplement" &&
    result.products.length === 0;
  if (expected.products !== undefined && !expected.product_redacted && !declinedFoodLetter) {
    const subjects = result.products.filter((p) => p.is_subject).map((p) => p.name);
    const matchedExp = (expected.products ?? []).filter((g) =>
      subjects.some((s) => substrEitherWay(s, g)),
    );
    const matchedGot = subjects.filter((s) => (expected.products ?? []).some((g) => substrEitherWay(s, g)));
    const recall = expected.products.length ? matchedExp.length / expected.products.length : 1;
    const precision = subjects.length ? matchedGot.length / subjects.length : expected.products.length ? 0 : 1;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    results.push({
      name: "subjects",
      scored: true,
      pass: f1 === 1,
      f1,
      expected: expected.products,
      got: subjects,
    });
  }

  if (expected.is_sterile_product !== undefined) {
    results.push({
      name: "is_sterile_product",
      scored: true,
      pass: result.is_sterile_product === expected.is_sterile_product,
      expected: expected.is_sterile_product,
      got: result.is_sterile_product,
    });
  }

  if (expected.violation_categories !== undefined) {
    const { f1 } = setMetrics(expected.violation_categories, result.violation_categories);
    results.push({
      name: "violation_categories",
      scored: true,
      pass: f1 === 1,
      f1,
      expected: expected.violation_categories,
      got: result.violation_categories,
    });
  }

  if (expected.contamination_present !== undefined) {
    results.push({
      name: "contamination_present",
      scored: true,
      pass: result.contamination.present === expected.contamination_present,
      expected: expected.contamination_present,
      got: result.contamination.present,
    });
  }

  if (expected.linked_to_complaints !== undefined) {
    results.push({
      name: "linked_to_complaints",
      scored: true,
      pass: result.contamination.linked_to_complaints === expected.linked_to_complaints,
      expected: expected.linked_to_complaints,
      got: result.contamination.linked_to_complaints,
    });
  }

  if (expected.recall_concern !== undefined) {
    results.push({
      name: "recall_concern",
      scored: true,
      pass: result.recall_concern === expected.recall_concern,
      expected: expected.recall_concern,
      got: result.recall_concern,
    });
  }

  return results;
}

// ---------- Jev cache ----------

interface CachedJev {
  answers: JevRawAnswers;
  confidence: number | undefined;
}

function cacheKeyFor(text: string, cands: ExtractedCandidates): string {
  const classifySrc = readFileSync(CLASSIFY_SRC_PATH, "utf8");
  const h = createHash("sha256");
  h.update(text);
  h.update(JSON.stringify(cands));
  h.update(classifySrc);
  return h.digest("hex");
}

const isRateLimit = (e: unknown) => /rate.?limit|429/i.test(String((e as Error)?.message ?? e));

/** The gateway's free tier throttles Jev; wait it out rather than lose the run. */
async function classifyWithBackoff(text: string, cands: ExtractedCandidates): Promise<JevResult> {
  const waits = [20_000, 45_000, 90_000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await classifyWithJev(text, cands);
    } catch (e) {
      const wait = waits[attempt];
      if (!isRateLimit(e) || wait === undefined) throw e;
      console.error(`  … rate limited, retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

async function getJevResult(text: string, cands: ExtractedCandidates): Promise<JevResult> {
  const key = cacheKeyFor(text, cands);
  const cachePath = path.join(CACHE_DIR, `${key}.json`);
  if (!refresh && existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, "utf8")) as CachedJev;
    return { answers: cached.answers, confidence: cached.confidence, raw: null };
  }
  jevCacheMiss = true;
  const result = await classifyWithBackoff(text, cands);
  mkdirSync(CACHE_DIR, { recursive: true });
  const toCache: CachedJev = { answers: result.answers, confidence: result.confidence };
  writeFileSync(cachePath, JSON.stringify(toCache, null, 2));
  return result;
}

// ---------- Aggregation ----------

interface Agg {
  passed: number;
  scored: number;
  f1Sum: number;
  f1Count: number;
}

type AggMap = Map<string, Agg>;

function bump(map: AggMap, field: FieldResult) {
  if (!field.scored) return;
  let a = map.get(field.name);
  if (!a) {
    a = { passed: 0, scored: 0, f1Sum: 0, f1Count: 0 };
    map.set(field.name, a);
  }
  a.scored++;
  if (field.pass) a.passed++;
  if (field.f1 !== undefined) {
    a.f1Sum += field.f1;
    a.f1Count++;
  }
}

interface InfoAgg {
  sum: number;
  count: number;
}

type InfoMap = Map<string, InfoAgg>;

function bumpInfo(map: InfoMap, field: FieldResult) {
  if (field.scored) return;
  if (typeof field.got !== "number") return;
  let a = map.get(field.name);
  if (!a) {
    a = { sum: 0, count: 0 };
    map.set(field.name, a);
  }
  a.sum += field.got;
  a.count++;
}

function aggToJson(map: AggMap) {
  const out: Record<string, { passed: number; scored: number; mean_f1?: number }> = {};
  for (const [name, a] of map) {
    out[name] = { passed: a.passed, scored: a.scored };
    if (a.f1Count > 0) out[name]!.mean_f1 = a.f1Sum / a.f1Count;
  }
  return out;
}

function infoToJson(map: InfoMap) {
  const out: Record<string, { mean: number; count: number }> = {};
  for (const [name, a] of map) out[name] = { mean: a.sum / a.count, count: a.count };
  return out;
}

function printAggTable(title: string, map: AggMap, infoMap?: InfoMap) {
  console.log(`\n${title}`);
  const rows = [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  if (rows.length === 0 && (!infoMap || infoMap.size === 0)) {
    console.log("  (no scored fields)");
    return;
  }
  for (const [name, a] of rows) {
    const f1 = a.f1Count > 0 ? `  mean_f1=${(a.f1Sum / a.f1Count).toFixed(3)}` : "";
    console.log(`  ${name.padEnd(24)} ${a.passed}/${a.scored}${f1}`);
  }
  if (infoMap) {
    for (const [name, a] of [...infoMap.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      console.log(`  ${name.padEnd(24)} (info) mean=${(a.sum / a.count).toFixed(2)} n=${a.count}`);
    }
  }
}

// ---------- Main ----------

async function main() {
  loadDotEnv();
  mkdirSync(CACHE_DIR, { recursive: true });

  const entries = loadGoldFiles();
  if (entries.length === 0) {
    console.error(filter ? `No gold files match filter "${filter}"` : `No gold files found in ${GOLD_DIR}`);
    process.exit(1);
  }

  const perLetter: Array<{ slug: string; letterType: string; fields: FieldResult[] }> = [];
  const jevFailures: string[] = [];
  const proposerFailures: string[] = [];

  for (const { slug, gold } of entries) {
    const fixturePath = path.join(ROOT, gold.fixture);
    const { text, meta } = loadLetter(fixturePath);
    const { cands, trace } = await gatherCandidates(text, {
      ...(gold.options ?? {}),
      meta,
      enumerate: !propose, // pure-Jev enumeration by default; --propose swaps in the LLM proposer
      propose,
      seedFromOpenFda: openfda,
    });
    if (trace.proposer && "error" in trace.proposer) {
      // The pipeline degrades to regex candidates; the score for this letter is NOT a proposer score.
      proposerFailures.push(slug);
      console.error(`  ! ${slug}: proposer failed (${trace.proposer.error.slice(0, 100)})`);
    }
    // A proposer call that hit the network (or was throttled) used gateway quota.
    if (trace.proposer && !("cached" in trace.proposer && trace.proposer.cached)) await pace();
    const fields: FieldResult[] = scoreExtraction(gold.expected, cands);

    if (!noJev) {
      try {
        jevCacheMiss = false;
        const jev = await getJevResult(text, cands);
        if (jevCacheMiss) await pace();
        const result = assemble(cands, jev, text);
        fields.push(...scoreJev(gold.expected, result, gold.letter_type));
      } catch (e) {
        // Extraction fields are still scored; Jev fields are left unscored for this letter.
        jevFailures.push(slug);
        await pace();
        console.error(`  ! ${slug}: Jev call failed (${isRateLimit(e) ? "rate limited" : String((e as Error)?.message ?? e).slice(0, 120)})`);
      }
    }

    perLetter.push({ slug, letterType: gold.letter_type, fields });
  }

  // ---- per-letter report ----
  for (const { slug, letterType, fields } of perLetter) {
    console.log(`\n=== ${slug} (${letterType}) ===`);
    for (const f of fields) {
      if (!f.scored) {
        console.log(`  · ${f.name}: ${JSON.stringify(f.got)}`);
        continue;
      }
      if (f.pass) {
        console.log(`  ✓ ${f.name}`);
      } else {
        const f1Note = f.f1 !== undefined ? ` (f1=${f.f1.toFixed(2)})` : "";
        console.log(`  ✗ ${f.name}: expected ${JSON.stringify(f.expected)} got ${JSON.stringify(f.got)}${f1Note}`);
      }
    }
  }

  // ---- aggregate ----
  const overall: AggMap = new Map();
  const overallInfo: InfoMap = new Map();
  const byType = new Map<string, AggMap>();
  const byTypeInfo = new Map<string, InfoMap>();

  for (const { letterType, fields } of perLetter) {
    let typeMap = byType.get(letterType);
    if (!typeMap) {
      typeMap = new Map();
      byType.set(letterType, typeMap);
    }
    let typeInfo = byTypeInfo.get(letterType);
    if (!typeInfo) {
      typeInfo = new Map();
      byTypeInfo.set(letterType, typeInfo);
    }
    for (const f of fields) {
      bump(overall, f);
      bump(typeMap, f);
      bumpInfo(overallInfo, f);
      bumpInfo(typeInfo, f);
    }
  }

  console.log("\n\n########## AGGREGATE ##########");
  if (proposerFailures.length) {
    console.log(`\n  NOTE: proposer failed for ${proposerFailures.length} letter(s), scored with regex candidates only: ${proposerFailures.join(", ")}`);
    console.log("        Successful proposals are cached — rerun to fill in the rest.");
  }
  if (jevFailures.length) {
    console.log(`\n  NOTE: Jev fields unscored for ${jevFailures.length} letter(s) (call failed): ${jevFailures.join(", ")}`);
    console.log("        Responses are cached — rerun to fill in the rest.");
  }
  printAggTable("--- overall ---", overall, overallInfo);
  for (const [type, map] of [...byType.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    printAggTable(`--- ${type} ---`, map, byTypeInfo.get(type));
  }

  // ---- machine-readable report ----
  const report = {
    generatedAt: new Date().toISOString(),
    filter: filter ?? null,
    noJev,
    letters: perLetter.map(({ slug, letterType, fields }) => ({ slug, letterType, fields })),
    aggregate: {
      overall: { fields: aggToJson(overall), info: infoToJson(overallInfo) },
      byType: Object.fromEntries(
        [...byType.entries()].map(([type, map]) => [
          type,
          { fields: aggToJson(map), info: infoToJson(byTypeInfo.get(type) ?? new Map()) },
        ]),
      ),
    },
  };
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  const anyFail = perLetter.some(({ fields }) => fields.some((f) => f.scored && !f.pass));
  if (strict && anyFail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
