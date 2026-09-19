/**
 * Tests for the propose/verify candidate pipeline.
 *
 *   npx tsx src/propose.test.ts
 *
 * Section (a) is offline and exercises the deterministic verifier — the part
 * that guarantees no generated span ever reaches the output.
 *
 * Sections (b) and (c) are LIVE: they call the proposer through the AI Gateway.
 * Without AI_GATEWAY_API_KEY they are skipped and the offline assertions still
 * run, so the file is useful in a sandbox with no network.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  DEFAULT_PROPOSER_MODEL,
  proposeProductCandidates,
  verifyProposals,
  type ProposeResult,
  type ProductProposal,
} from "./propose.js";

// Same .env loader as src/run.ts — never printed, only read into process.env.
function loadDotEnv() {
  try {
    const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
    for (const line of env.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
    }
  } catch {
    /* no .env — fine */
  }
}

let assertions = 0;
let skipped = 0;
function ok(cond: unknown, msg: string): asserts cond {
  assert.ok(cond, msg);
  assertions++;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "..", "fixtures");
const readFixture = (f: string) => readFileSync(path.join(fixturesDir, f), "utf8");

const nameOf = (c: { payload?: Record<string, unknown> }) => String(c.payload?.name ?? "");
const kindOf = (c: { payload?: Record<string, unknown> }) => String(c.payload?.kind ?? "");

// =========================================================================
// (a) Offline: the deterministic verifier.
// =========================================================================
{
  const text =
    "Furthermore, your H2 RENU Oncology Care Beverage product and Hydro Shot Hydrogen " +
    "Beverage Strawberry, Lemon Lime, and Orange flavored products are drugs. You also " +
    'manufacture Hydro Brew Unsweetened Green Tea and lot codes "LOT: (b)(4)".';

  const p = (name: string): ProductProposal => ({
    name,
    kind: "brand_product",
    role: "subject_of_violation",
  });

  // 1. A hallucinated name is rejected.
  {
    const { candidates, rejected } = verifyProposals(text, [p("Hydro Zen Recovery Elixir")]);
    ok(candidates.length === 0, "hallucination: no candidate should survive");
    ok(rejected.length === 1, "hallucination: one rejection expected");
    ok(
      rejected[0]?.reason === "not verbatim in letter",
      `hallucination: reason should be "not verbatim in letter", got "${rejected[0]?.reason}"`,
    );
  }

  // 2. A case-variant proposal is accepted, but adopts the LETTER's casing.
  {
    const { candidates, rejected } = verifyProposals(text, [p("h2 renu oncology care beverage")]);
    ok(candidates.length === 1, "case-variant: should be accepted");
    ok(rejected.length === 0, "case-variant: nothing should be rejected");
    ok(
      nameOf(candidates[0]!) === "H2 RENU Oncology Care Beverage",
      `case-variant: should adopt the letter's casing, got "${nameOf(candidates[0]!)}"`,
    );
    ok(
      text.includes(nameOf(candidates[0]!)),
      "case-variant: adopted name must be a verbatim substring",
    );
    ok(
      candidates[0]!.id === "drug_llm_h2_renu_oncology_care_beverage",
      `case-variant: id should be slugged from the exact span, got "${candidates[0]!.id}"`,
    );
    ok(
      candidates[0]!.payload?.proposer === "llm-verified",
      "case-variant: payload.proposer should be llm-verified",
    );
    ok(
      candidates[0]!.text ===
        "H2 RENU Oncology Care Beverage — named in the letter (brand_product, subject_of_violation)",
      `case-variant: unexpected candidate text "${candidates[0]!.text}"`,
    );
  }

  // 3. A redaction placeholder is rejected even though "(b)(4)" IS in the text.
  {
    const { candidates, rejected } = verifyProposals(text, [p("(b)(4)")]);
    ok(candidates.length === 0, "redaction: no candidate should survive");
    ok(
      rejected[0]?.reason === "redaction placeholder",
      `redaction: reason should be "redaction placeholder", got "${rejected[0]?.reason}"`,
    );
  }
  {
    const { candidates, rejected } = verifyProposals(text, [p('LOT: (b)(4)')]);
    ok(candidates.length === 0, "redaction: a name containing (b)(4) should be rejected too");
    ok(rejected[0]?.reason === "redaction placeholder", "redaction: composite reason");
  }

  // 4. Duplicates collapse to one candidate (second is reported as a duplicate).
  {
    const { candidates, rejected } = verifyProposals(text, [
      p("Hydro Brew Unsweetened Green Tea"),
      p("hydro brew unsweetened green tea"),
    ]);
    ok(candidates.length === 1, `duplicate: expected 1 candidate, got ${candidates.length}`);
    ok(
      rejected.length === 1 && rejected[0]?.reason === "duplicate",
      `duplicate: second proposal should be rejected as duplicate, got "${rejected[0]?.reason}"`,
    );
  }

  // 5. Whitespace and curly quotes normalise; the returned span stays verbatim.
  {
    const wrapped = "you manufacture Hydro Brew\nUnsweetened Green Tea, which is acidified.";
    const { candidates } = verifyProposals(wrapped, [p("Hydro Brew  Unsweetened Green Tea")]);
    ok(candidates.length === 1, "whitespace: line-wrapped name should still match");
    ok(
      wrapped.includes(nameOf(candidates[0]!)),
      "whitespace: returned span must be verbatim in the source",
    );
  }

  // 6. An over-long span is rejected before the substring search.
  {
    const longName =
      "H2 RENU Oncology Care Beverage product and Hydro Shot Hydrogen Beverage Strawberry";
    const { candidates, rejected } = verifyProposals(text, [p(longName)]);
    ok(candidates.length === 0, "too long: should not be accepted");
    ok(
      rejected[0]?.reason === "too long",
      `too long: reason should be "too long", got "${rejected[0]?.reason}"`,
    );
  }
}

// =========================================================================
// Live sections.
// =========================================================================
loadDotEnv();
const live = Boolean(process.env.AI_GATEWAY_API_KEY);

/**
 * The gateway plan attached to a given key does not reach every model: a free
 * tier answers 403 "restricted model" for the frontier ids and 429 for the rest.
 * That is an account fact, not a defect in this module, so the live sections
 * walk a list until one model answers and report which one they used.
 */
const MODEL_CANDIDATES = [
  process.env.JEV_PROPOSER_MODEL ?? DEFAULT_PROPOSER_MODEL,
  "openai/gpt-4o-mini",
  "inclusionai/ling-3.0-flash-fin",
].filter((m, i, a) => a.indexOf(m) === i);

/** True for "your plan cannot use this model right now" style gateway errors. */
function isPlanError(e: unknown): boolean {
  const m = e instanceof Error ? `${e.message} ${(e as { responseBody?: string }).responseBody ?? ""}` : String(e);
  return /rate.?limit|restricted|not have access|no_providers_available|429|403/i.test(m);
}

/** Once a model answers, stick to it — free-tier quota is scarce. */
let resolvedModel: string | null = null;

async function proposeReachable(text: string): Promise<ProposeResult | null> {
  let lastPlanError: unknown = null;
  for (const model of resolvedModel ? [resolvedModel] : MODEL_CANDIDATES) {
    try {
      const r = await proposeProductCandidates(text, { model });
      resolvedModel = model;
      return r;
    } catch (e) {
      if (!isPlanError(e)) throw e;
      lastPlanError = e;
    }
  }
  console.log(
    `(no reachable proposer model on this gateway plan — tried ${MODEL_CANDIDATES.join(", ")})`,
  );
  console.log(`  last error: ${(lastPlanError as Error)?.message?.slice(0, 160)}`);
  return null;
}

if (!live) {
  console.log("(skipping live gateway tests — no AI_GATEWAY_API_KEY)");
} else {
  // ---------------------------------------------------------------------
  // (b) H2 BEV: products are named in prose, which the regexes miss.
  // ---------------------------------------------------------------------
  {
    const text = readFixture("h2-bev-2026.txt");
    const t0 = Date.now();
    const result = await proposeReachable(text);
    const ms = Date.now() - t0;
    if (!result) {
      console.log("h2-bev: SKIPPED (gateway rate limited)");
      skipped++;
    } else {
      const { candidates, rejected, model } = result;
      const names = candidates.map(nameOf);
      console.log(`h2-bev [${model}] ${ms}ms`);
      console.log("  candidates:", JSON.stringify(names));
      console.log("  rejected:  ", JSON.stringify(rejected));

      ok(
        names.includes("H2 RENU Oncology Care Beverage"),
        `h2-bev: expected "H2 RENU Oncology Care Beverage" among ${JSON.stringify(names)}`,
      );
      ok(
        names.some((n) => n.startsWith("Hydro Shot")),
        `h2-bev: expected a "Hydro Shot…" candidate among ${JSON.stringify(names)}`,
      );
      for (const n of names) {
        ok(text.includes(n), `h2-bev: candidate "${n}" is not a verbatim substring of the letter`);
      }
      ok(
        !names.some((n) => n.toUpperCase() === "MADE FOR ONCOLOGY PATIENTS"),
        "h2-bev: the marketing slogan must not become a candidate",
      );
      ok(
        !names.some((n) => /\(\s*b\s*\)\s*\(\s*\d+\s*\)/i.test(n)),
        "h2-bev: no candidate may contain a redaction placeholder",
      );
    }
  }

  // ---------------------------------------------------------------------
  // (c) Bausch & Lomb: the product name is redacted — invent nothing.
  // ---------------------------------------------------------------------
  {
    const text = readFixture("bausch-lomb-2026.txt");
    const t0 = Date.now();
    const result = await proposeReachable(text);
    const ms = Date.now() - t0;
    if (!result) {
      console.log("bausch-lomb: SKIPPED (gateway rate limited)");
      skipped++;
    } else {
      const { candidates, rejected, model } = result;
      const names = candidates.map(nameOf);
      console.log(`bausch-lomb [${model}] ${ms}ms`);
      console.log(
        "  candidates:",
        JSON.stringify(candidates.map((c) => `${nameOf(c)} [${kindOf(c)}]`)),
      );
      console.log("  rejected:  ", JSON.stringify(rejected));

      const brands = candidates.filter((c) => kindOf(c) === "brand_product");
      ok(
        brands.length === 0,
        `bausch-lomb: product name is redacted, no brand_product may be invented — got ${JSON.stringify(
          brands.map(nameOf),
        )}`,
      );
      for (const n of names) {
        ok(
          text.includes(n),
          `bausch-lomb: candidate "${n}" is not a verbatim substring of the letter`,
        );
      }
      ok(
        !names.some((n) => /\(\s*b\s*\)\s*\(\s*\d+\s*\)/i.test(n)),
        "bausch-lomb: no candidate may contain a redaction placeholder",
      );
    }
  }
}

if (skipped) console.log(`${skipped} live section(s) SKIPPED (gateway rate limited)`);
console.log(`ok ${assertions} assertions`);
