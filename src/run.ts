/**
 * CLI:
 *   pnpm run demo                              # classify the bundled Bausch & Lomb fixture
 *   tsx src/run.ts path/to/letter.txt          # classify a local file
 *   tsx src/run.ts https://www.fda.gov/.../... # classify a letter straight from its URL
 *   tsx src/run.ts letter.txt --extract-only   # deterministic extraction only (no API key)
 *   tsx src/run.ts letter.txt --seed-facility  # seed drug candidates from facility cross-ref
 *
 * Reads TYPESAFE_AI_API_KEY from the environment (loads a local .env if present).
 */

import { readFileSync } from "node:fs";
import { extractCandidates } from "./extract.js";
import { classifyWarningLetter, gatherCandidates } from "./index.js";
import { resolveLetter } from "./resolve.js";

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

async function main() {
  loadDotEnv();
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  const extractOnly = args.includes("--extract-only");
  const seedFacility = args.includes("--seed-facility");

  if (!file) {
    console.error("usage: tsx src/run.ts <letter.txt | fda-url> [--extract-only] [--seed-facility]");
    process.exit(1);
  }

  const { text, meta } = await resolveLetter(file);
  const opts = {
    seedFromFacility: seedFacility,
    meta,
    propose: args.includes("--propose"),
    seedFromOpenFda: args.includes("--openfda"),
    enrichFromOpenFda: args.includes("--openfda"),
  };

  if (extractOnly) {
    // Deterministic extraction only, unless a network candidate source was asked for.
    const out =
      opts.propose || opts.seedFromOpenFda
        ? await gatherCandidates(text, opts)
        : extractCandidates(text, opts);
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (!process.env.TYPESAFE_AI_API_KEY && !process.env.TYPESAFE_API_KEY) {
    console.error(
      "No TYPESAFE_AI_API_KEY set (Jev runs through the TypeSafe SDK). Run with --extract-only\n" +
        "to see deterministic extraction, or copy .env.example to .env and add your TypeSafe key.\n" +
        "(--propose additionally needs AI_GATEWAY_API_KEY for the candidate proposer.)",
    );
    process.exit(2);
  }

  const result = await classifyWarningLetter(text, opts);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
