/**
 * Letter loading: text plus, when present, the sidecar `<name>.meta.json`
 * written by scripts/fetch-letter.ts (FDA's own structured page metadata).
 */

import { existsSync, readFileSync } from "node:fs";
import type { LetterMeta } from "./types.js";

export interface LoadedLetter {
  text: string;
  meta?: LetterMeta;
}

export function loadLetter(file: string): LoadedLetter {
  const text = readFileSync(file, "utf8");
  const metaPath = file.replace(/\.txt$/i, "") + ".meta.json";
  if (!existsSync(metaPath)) return { text };
  return { text, meta: JSON.parse(readFileSync(metaPath, "utf8")) as LetterMeta };
}
