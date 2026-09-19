/**
 * Asserts the INPUTS Jev is shown — the candidate set and its eligibility —
 * not just the final output. Borrowed from the Tetris repo's test.mjs, which
 * checks every number fed to the model. Runs offline: extraction only, no
 * proposer / openFDA / gateway calls.
 *
 *   npx tsx src/candidates.test.ts
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { extractCandidates } from "./extract.js";
import { enumerateProductCandidates } from "./enumerate.js";
import { eligibleAsProduct, candidatesInLetter } from "./classify.js";
import type { Candidate } from "./types.js";

let n = 0;
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg);
  n++;
};

const load = (slug: string) => readFileSync(`fixtures/${slug}.txt`, "utf8");
const cand = (over: Partial<Candidate["payload"]>): Candidate => ({
  id: "c",
  text: "c",
  payload: { name: "X", ...over },
});

// --- eligibleAsProduct: the "only advertise reachable targets" filter ---
ok(
  eligibleAsProduct(cand({ kind: "brand_product", source: "letter-text" }), false),
  "a brand product named in a non-redacted letter is eligible as THE product",
);
ok(
  !eligibleAsProduct(cand({ kind: "active_ingredient", source: "letter-text" }), false),
  "an active ingredient is never eligible as the finished product",
);
ok(
  !eligibleAsProduct(cand({ kind: "generic_product_class", source: "letter-text" }), false),
  "a generic product class is never eligible as the product",
);
ok(
  !eligibleAsProduct(cand({ kind: "brand_product", source: "letter-text" }), true),
  "when the product name is redacted, nothing is eligible as the confirmed product",
);
ok(
  !eligibleAsProduct(cand({ kind: "brand_product", source: "openfda-labeler" }), false),
  "a cross-reference lead is never the confirmed product (leads are surfaced separately)",
);

// --- Bausch & Lomb: product redacted, so extraction yields no in-letter product ---
{
  const c = extractCandidates(load("bausch-lomb-2026"), { seedFromFacility: true });
  ok(c.redaction.product_name_redacted, "bausch-lomb: product name is detected as redacted");
  ok(
    candidatesInLetter(load("bausch-lomb-2026"), c.drugs).length === 0,
    "bausch-lomb: no candidate is named verbatim in the letter (all are cross-reference leads)",
  );
  ok(
    c.drugs.every((d) => !eligibleAsProduct(d, c.redaction.product_name_redacted)),
    "bausch-lomb: no candidate is eligible as the confirmed product (name is redacted)",
  );
}

// --- H2 BEV: products named in clear, so they must survive as eligible ---
{
  const text = load("h2-bev-llc-and-h2-renu-inc-730567-07312026");
  const c = extractCandidates(text, {});
  ok(!c.redaction.product_name_redacted, "h2-bev: product name is NOT redacted");
  const inLetter = candidatesInLetter(text, c.drugs).map((d) => String(d.payload?.name));
  ok(
    inLetter.some((nm) => /H2 RENU Oncology Care Beverage/i.test(nm)),
    "h2-bev: the named product is present as an in-letter candidate",
  );
  ok(
    inLetter.every((nm) => text.toLowerCase().includes(nm.toLowerCase())),
    "h2-bev: every in-letter candidate name is a verbatim substring of the letter",
  );
}

// --- enumerate: high-recall, verbatim, boilerplate-free ---
{
  const text = load("h2-bev-llc-and-h2-renu-inc-730567-07312026");
  const cands = enumerateProductCandidates(text);
  const names = cands.map((c) => String(c.payload?.name));
  ok(cands.length > 0 && cands.length <= 80, "enumerate: produces a bounded candidate set");
  ok(
    names.every((nm) => text.toLowerCase().includes(nm.toLowerCase())),
    "enumerate: every candidate is a verbatim substring of the letter",
  );
  ok(
    names.some((nm) => /H2 RENU Oncology Care Beverage/i.test(nm)),
    "enumerate: finds the named product",
  );
  ok(
    !names.some((nm) => /^(FDA|CFR|CGMP|WARNING LETTER|U\.S\.C)$/i.test(nm)),
    "enumerate: rejects regulatory-boilerplate acronyms",
  );
}

console.log(`ok ${n} assertions`);
