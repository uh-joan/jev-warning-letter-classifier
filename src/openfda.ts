/**
 * openFDA-backed drug lookup.
 *
 * Same shapes as drug-kb.ts (DrugRecord / lookup / productsForFacility), but backed
 * by the real openFDA public API instead of a 5-drug hard-coded table:
 *  - https://api.fda.gov/drug/ndc.json    — NDC directory (brand/generic name, route,
 *    dosage form, active ingredients, labeler/manufacturer).
 *  - https://api.fda.gov/drug/label.json  — structured label content, used only to
 *    fill in `indication` from `indications_and_usage`.
 *
 * No API key is required. Every response is cached on disk under
 * .cache/openfda/<sha1(request url)>.json so repeat lookups (and tests) don't
 * re-hit the network. "Not found" (404 / no match / network error) resolves to
 * undefined/[] — callers never need to catch an exception for a missing drug.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DrugRecord } from "./drug-kb.js";
import type { Candidate } from "./types.js";

const API_BASE = "https://api.fda.gov";
const CACHE_DIR = path.join(process.cwd(), ".cache", "openfda");
const RATE_LIMIT_DELAY_MS = 200;

export interface OpenFdaOptions {
  /** Serve responses only from the on-disk cache; never hit the network. */
  offline?: boolean;
}

interface OpenFdaActiveIngredient {
  name: string;
  strength?: string;
}

interface OpenFdaNdcResult {
  brand_name?: string;
  generic_name?: string;
  labeler_name?: string;
  active_ingredients?: OpenFdaActiveIngredient[];
  dosage_form?: string;
  route?: string[];
  openfda?: { manufacturer_name?: string[] };
}

interface OpenFdaNdcResponse {
  results?: OpenFdaNdcResult[];
}

interface OpenFdaLabelResult {
  indications_and_usage?: string[];
}

interface OpenFdaLabelResponse {
  results?: OpenFdaLabelResult[];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cacheKeyFor(url: string): string {
  return createHash("sha1").update(url).digest("hex");
}

/** Fetch JSON with an on-disk cache. 404 / network error resolve to undefined. */
async function cachedFetchJson<T>(url: string, opts?: OpenFdaOptions): Promise<T | undefined> {
  const file = path.join(CACHE_DIR, `${cacheKeyFor(url)}.json`);

  try {
    const cached = await readFile(file, "utf8");
    return JSON.parse(cached) as T;
  } catch {
    // cache miss — fall through to network (unless offline).
  }

  if (opts?.offline) return undefined;

  let data: T;
  try {
    // FDA_API_KEY raises openFDA's rate limits (240/min, 120k/day vs 1k/day without).
    // Sent as the Basic-auth username so the key never appears in a URL, a log
    // line, or the URL-derived cache key.
    const apiKey = process.env.FDA_API_KEY?.trim();
    const res = await fetch(
      url,
      apiKey
        ? { headers: { Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}` } }
        : undefined,
    );
    if (res.status === 403 && apiKey) {
      // openFDA rejects the whole request when the key is bad, so a typo in
      // FDA_API_KEY silently disables every lookup. Say so.
      console.error("openFDA: FDA_API_KEY was rejected (API_KEY_INVALID) — fix or remove it in .env");
    } else if (res.status !== 404 && !res.ok) {
      // 404 means "no matches"; anything else (429, 5xx) is not a real "not found".
      console.error(`openFDA: HTTP ${res.status} for ${new URL(url).pathname} — treating as no result`);
    }
    if (!res.ok) return undefined;
    data = (await res.json()) as T;
  } catch {
    return undefined; // network error — treat as "not found".
  }

  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(file, JSON.stringify(data), "utf8");
  } catch {
    // cache write failure is non-fatal.
  }
  await delay(RATE_LIMIT_DELAY_MS);
  return data;
}

/** Quote a phrase for openFDA's Lucene-style `search=` syntax, escaping embedded quotes. */
function quote(term: string): string {
  return `"${term.replace(/"/g, '\\"')}"`;
}

function buildUrl(endpoint: string, search: string, limit: number): string {
  const params = new URLSearchParams({ search, limit: String(limit) });
  return `${API_BASE}${endpoint}?${params.toString()}`;
}

function formatActiveIngredients(list: OpenFdaActiveIngredient[] | undefined): string {
  if (!list || list.length === 0) return "";
  return list
    .map((ai) => {
      const name = ai.name.trim().toLowerCase();
      return ai.strength ? `${name} ${ai.strength.trim()}` : name;
    })
    .join("; ");
}

function ndcToDrugRecord(rec: OpenFdaNdcResult): DrugRecord {
  const manufacturer = rec.openfda?.manufacturer_name?.[0] ?? rec.labeler_name;
  return {
    name: rec.brand_name?.trim() ?? "",
    active_ingredient: formatActiveIngredients(rec.active_ingredients),
    indication: "",
    route: (rec.route ?? []).join(", "),
    dosage_form: rec.dosage_form ?? "",
    facilities: manufacturer ? [manufacturer] : undefined,
  };
}

async function ndcLookupByField(
  field: "brand_name" | "generic_name",
  term: string,
  opts?: OpenFdaOptions,
): Promise<OpenFdaNdcResult | undefined> {
  const url = buildUrl("/drug/ndc.json", `${field}:${quote(term)}`, 1);
  const data = await cachedFetchJson<OpenFdaNdcResponse>(url, opts);
  return data?.results?.[0];
}

async function lookupIndication(name: string, opts?: OpenFdaOptions): Promise<string> {
  const url = buildUrl("/drug/label.json", `openfda.brand_name:${quote(name)}`, 1);
  const data = await cachedFetchJson<OpenFdaLabelResponse>(url, opts);
  const raw = data?.results?.[0]?.indications_and_usage?.[0];
  if (!raw) return "";
  return raw.replace(/\s+/g, " ").trim().slice(0, 300);
}

/**
 * Brand-name (falling back to generic-name) lookup via the NDC directory, with
 * `indication` filled in from the label endpoint when available. Undefined when
 * nothing matches — never throws for "not found".
 */
export async function lookupDrug(name: string, opts?: OpenFdaOptions): Promise<DrugRecord | undefined> {
  const term = name.trim();
  if (!term) return undefined;

  const rec = (await ndcLookupByField("brand_name", term, opts)) ?? (await ndcLookupByField("generic_name", term, opts));
  if (!rec) return undefined;

  const drug = ndcToDrugRecord(rec);
  drug.indication = await lookupIndication(drug.name || term, opts);
  return drug;
}

const CORP_SUFFIXES =
  /[,]?\s*\b(incorporated|inc\.?|llc|l\.l\.c\.|corp\.?|corporation|ltd\.?|co\.?|company|gmbh|s\.a\.|pharmaceuticals?)\.?\s*$/i;

/** Strip a trailing corporate suffix (Inc./LLC/Corp./…) so labeler search matches loosely. */
function stripCorpSuffix(name: string): string {
  let s = name.trim();
  let prev: string;
  do {
    prev = s;
    s = s.replace(CORP_SUFFIXES, "").trim();
  } while (s !== prev && s.length > 0);
  return s;
}

/**
 * Distinct brand products for a labeler/manufacturer name — the facility
 * cross-reference seed for redacted letters. De-duped by brand name, capped at 50.
 */
export async function productsForLabeler(company: string, opts?: OpenFdaOptions): Promise<DrugRecord[]> {
  const base = stripCorpSuffix(company);
  if (!base) return [];

  const url = buildUrl("/drug/ndc.json", `labeler_name:${quote(base)}`, 100);
  const data = await cachedFetchJson<OpenFdaNdcResponse>(url, opts);
  const results = data?.results ?? [];

  const seen = new Set<string>();
  const products: DrugRecord[] = [];
  for (const rec of results) {
    const brand = rec.brand_name?.trim();
    if (!brand) continue;
    const key = brand.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    products.push(ndcToDrugRecord(rec));
    if (products.length >= 50) break;
  }
  return products;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Turn an openFDA-sourced DrugRecord into a Choice candidate for Jev. */
export function toCandidate(rec: DrugRecord, source: "openfda-labeler" | "openfda-name"): Candidate {
  const ingredient = rec.active_ingredient ? ` (${rec.active_ingredient})` : "";
  const description =
    source === "openfda-labeler"
      ? "openFDA NDC product for this labeler (cross-reference lead, not stated in letter)"
      : "openFDA NDC product match for this name";
  return {
    id: `openfda_${slugify(rec.name)}`,
    text: `${rec.name}${ingredient} — ${description}`,
    payload: { source, name: rec.name },
  };
}
