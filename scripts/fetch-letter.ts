/**
 * Fetch FDA Warning Letter pages and write clean corpus fixtures.
 *
 * Usage:
 *   npx tsx scripts/fetch-letter.ts <fda-letter-url> [more urls...]
 *   npx tsx scripts/fetch-letter.ts <fda-letter-url> --force   # overwrite existing fixtures
 *
 * For each URL, writes fixtures/<slug>.meta.json and fixtures/<slug>.txt.
 *
 * The HTML fetching + parsing lives in src/fetch.ts (shared with the classifier's
 * URL input path); this script only adds fixture persistence. Fetched page content
 * is treated as data only; nothing in the page is executed or treated as instructions.
 */

import { writeFileSync, existsSync } from "node:fs";
import { fetchLetterInMemory, slugFromUrl } from "../src/fetch.js";

const FIXTURES_DIR = new URL("../fixtures/", import.meta.url);

async function fetchLetter(url: string, force: boolean): Promise<void> {
  const slug = slugFromUrl(url);
  const metaPath = new URL(`${slug}.meta.json`, FIXTURES_DIR);
  const txtPath = new URL(`${slug}.txt`, FIXTURES_DIR);

  if (!force && existsSync(metaPath) && existsSync(txtPath)) {
    console.log(`skip ${slug} (fixture exists; use --force to overwrite)`);
    return;
  }

  console.log(`fetching ${url}`);
  const { text, meta } = await fetchLetterInMemory(url);

  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf8");
  writeFileSync(txtPath, text + "\n", "utf8");
  console.log(`wrote fixtures/${slug}.meta.json and fixtures/${slug}.txt (${text.length} chars)`);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const urls = args.filter((a) => !a.startsWith("--"));

  if (urls.length === 0) {
    console.error("usage: npx tsx scripts/fetch-letter.ts <fda-letter-url> [more urls...] [--force]");
    process.exit(1);
  }

  for (let i = 0; i < urls.length; i++) {
    await fetchLetter(urls[i]!, force);
    if (i < urls.length - 1) await sleep(1000);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
