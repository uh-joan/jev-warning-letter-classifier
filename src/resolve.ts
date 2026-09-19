/**
 * Resolve a letter input — a URL or a local file path — into text + metadata,
 * in memory. This is the single entry point the CLI and any skill use so they
 * accept either form transparently.
 */

import { fetchLetterInMemory } from "./fetch.js";
import { loadLetter, type LoadedLetter } from "./load.js";

/** True when the input looks like an http(s) URL rather than a filesystem path. */
export function isUrl(input: string): boolean {
  return /^https?:\/\//i.test(input.trim());
}

/** True when a URL points at fda.gov (a warning letter we know how to parse). */
export function isFdaUrl(input: string): boolean {
  try {
    return /(^|\.)fda\.gov$/i.test(new URL(input).hostname);
  } catch {
    return false;
  }
}

/**
 * Load a letter from a URL (fetched + parsed) or a local path (.txt + optional
 * .meta.json sidecar). Non-FDA URLs are still attempted — the parser is tuned
 * for FDA's page structure, so callers may want to warn — see isFdaUrl.
 */
export async function resolveLetter(input: string): Promise<LoadedLetter> {
  if (isUrl(input)) {
    const { text, meta } = await fetchLetterInMemory(input);
    return { text, meta };
  }
  return loadLetter(input);
}
