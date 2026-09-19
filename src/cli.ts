#!/usr/bin/env node
/**
 * classify-warning-letter — turn an FDA Warning Letter into structured data.
 *
 *   classify-warning-letter <url | path/to/letter.txt> [options]
 *
 * Options:
 *   --json           Print the full structured object as JSON (default: human digest)
 *   --openfda        Enrich the drug + seed candidates from openFDA (needs network)
 *   --extract-only   Deterministic extraction only — no Jev call, no API key needed
 *   --seed-facility  Seed drug candidates from facility cross-references
 *   --propose        Use the LLM candidate proposer (needs AI_GATEWAY_API_KEY)
 *   -h, --help       Show this help
 *   -v, --version    Show the version
 *
 * Reads TYPESAFE_AI_API_KEY from the environment (or a .env in the current
 * directory). The key is never printed.
 */

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { extractCandidates } from "./extract.js";
import { classifyWarningLetter, gatherCandidates } from "./index.js";
import { resolveLetter, isUrl, isFdaUrl } from "./resolve.js";
import type { WarningLetter } from "./types.js";

const VERSION = "0.1.0";

const HELP = `classify-warning-letter — FDA Warning Letter → structured data (via TypeSafe Jev)

Usage:
  classify-warning-letter <url | path/to/letter.txt> [options]

Options:
  --json           Print the full structured object as JSON (default: human digest)
  --openfda        Enrich the drug + seed candidates from openFDA (needs network)
  --extract-only   Deterministic extraction only — no Jev call, no API key needed
  --seed-facility  Seed drug candidates from facility cross-references
  --propose        Use the LLM candidate proposer (needs AI_GATEWAY_API_KEY)
  -h, --help       Show this help
  -v, --version    Show the version

Environment:
  TYPESAFE_AI_API_KEY   required (unless --extract-only). Get one at
                        https://console.typesafe.ai/settings/keys
  FDA_API_KEY           optional, raises openFDA rate limits (--openfda)

Examples:
  classify-warning-letter ./fixtures/bausch-lomb-2026.txt
  classify-warning-letter https://www.fda.gov/.../warning-letters/<slug> --json`;

/** Load KEY=value pairs from a .env in the current working directory, if present. */
function loadDotEnv(): void {
  try {
    const env = readFileSync(resolvePath(process.cwd(), ".env"), "utf8");
    for (const line of env.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
    }
  } catch {
    /* no .env — environment only, which is fine */
  }
}

const fmtPct = (p: number | null | undefined): string =>
  p == null ? "—" : `${Math.round(p * 100)}%`;

/** A compact, human-readable digest that foregrounds Jev's probabilities. */
function digest(r: WarningLetter): string {
  const lines: string[] = [];
  const loc = r.facility.location ? ` (${r.facility.location}${r.facility.fei ? ` · FEI ${r.facility.fei}` : ""})` : "";
  lines.push(`FDA Warning Letter — ${r.company ?? "(company not found)"}${loc}`);
  const bits = [r.warning_letter_date, r.issuing_office, `regulated as: ${r.regulated_product}`].filter(Boolean);
  lines.push(bits.join(" · "));
  lines.push(`Document type: ${r.document_type}`);
  lines.push("");

  // Drug
  if (r.drug.name) {
    lines.push(`Drug:        ${r.drug.name}   [confidence ${fmtPct(r.drug.confidence)}]`);
    const enrich = [r.drug.active_ingredient, r.drug.route, r.drug.dosage_form].filter(Boolean).join(" · ");
    if (enrich) lines.push(`             ${enrich}`);
    if (r.drug.indication) lines.push(`             indication: ${r.drug.indication}`);
  } else {
    lines.push(`Drug:        (none) — ${r.drug.redaction_note ?? "not identified"}`);
    if (r.drug.cross_reference_leads.length)
      lines.push(`             leads: ${r.drug.cross_reference_leads.join(", ")}`);
  }

  // Products with their subject probabilities (the Jev numbers)
  const subjects = r.products.filter((p) => p.is_subject);
  if (subjects.length) {
    lines.push("Subjects:");
    for (const p of subjects.slice(0, 8))
      lines.push(`  ✓ ${p.name}   ${fmtPct(p.subject_probability)}`);
  }

  lines.push("");
  lines.push(`Violations:  ${r.violation_categories.length ? r.violation_categories.join(", ") : "(none)"}`);
  const contam = r.contamination.present
    ? `yes${r.contamination.organisms.length ? ` (${r.contamination.organisms.slice(0, 4).join(", ")})` : ""}`
    : "no";
  lines.push(`Sterile: ${r.is_sterile_product ? "yes" : "no"}   Contamination: ${contam}   Recall: ${r.recall_concern ? "yes" : "no"}`);

  // Review routing — the uncertain calls, with their exact certainties
  if (r.review.length) {
    lines.push("");
    lines.push("⚠ Needs human review:");
    for (const f of r.review) lines.push(`  - ${f.field}  (${fmtPct(f.certainty)})  ${f.reason}`);
  }

  return lines.join("\n");
}

async function main(): Promise<number> {
  loadDotEnv();
  const args = process.argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    console.log(HELP);
    return 0;
  }
  if (args.includes("-v") || args.includes("--version")) {
    console.log(VERSION);
    return 0;
  }

  const input = args.find((a) => !a.startsWith("-"));
  const asJson = args.includes("--json");
  const extractOnly = args.includes("--extract-only");
  const openfda = args.includes("--openfda");

  if (!input) {
    console.error("error: no input given.\n");
    console.error(HELP);
    return 1;
  }

  if (isUrl(input) && !isFdaUrl(input)) {
    console.error(`warning: ${input} is not an fda.gov URL — the parser is tuned for FDA pages, results may be poor.`);
  }

  const opts = {
    seedFromFacility: args.includes("--seed-facility"),
    propose: args.includes("--propose"),
    seedFromOpenFda: openfda,
    enrichFromOpenFda: openfda,
  };

  let loaded;
  try {
    loaded = await resolveLetter(input);
  } catch (e) {
    console.error(`error: could not load "${input}": ${(e as Error).message}`);
    return 1;
  }
  const { text, meta } = loaded;

  if (extractOnly) {
    const out =
      opts.propose || opts.seedFromOpenFda
        ? await gatherCandidates(text, { ...opts, meta })
        : extractCandidates(text, { ...opts, meta });
    console.log(JSON.stringify(out, null, 2));
    return 0;
  }

  if (!process.env.TYPESAFE_AI_API_KEY && !process.env.TYPESAFE_API_KEY) {
    console.error(
      "error: TYPESAFE_AI_API_KEY is not set (Jev runs through the TypeSafe SDK).\n" +
        "Set it in your environment or a .env file, or use --extract-only for deterministic\n" +
        "extraction without a key. Get a key at https://console.typesafe.ai/settings/keys",
    );
    return 2;
  }

  const result = await classifyWarningLetter(text, { ...opts, meta });
  console.log(asJson ? JSON.stringify(result, null, 2) : digest(result));
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e instanceof Error ? `error: ${e.message}` : e);
    process.exit(1);
  });
