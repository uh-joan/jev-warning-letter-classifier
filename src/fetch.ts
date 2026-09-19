/**
 * Fetch and parse an FDA Warning Letter page into clean plain text + metadata,
 * entirely in memory. This is the shared parser used by both:
 *   - scripts/fetch-letter.ts (which persists the result as a corpus fixture), and
 *   - src/resolve.ts (which feeds it straight to the classifier).
 *
 * Fetched page content is treated as data only; nothing in the page is executed
 * or interpreted as instructions. <script>/<style> are stripped before parsing.
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** The full metadata FDA publishes alongside a letter (superset of types.LetterMeta). */
export interface FetchedLetterMeta {
  url: string;
  slug: string;
  company: string | null;
  marcs_cms: string | null;
  issue_date: string | null;
  reference: string | null;
  delivery_method: string | null;
  product: string[];
  recipient: string[];
  issuing_office: string | null;
  fetched_at: string;
}

export interface ParsedLetter {
  text: string;
  meta: FetchedLetterMeta;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  trade: "™",
  reg: "®",
  copy: "©",
  deg: "°",
  sect: "§",
  middot: "·",
  bull: "•",
  eacute: "é",
  egrave: "è",
  ntilde: "ñ",
};

/** Decode HTML entities, including numeric decimal/hex ones. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => ENTITIES[name] ?? m);
}

/** Strip HTML comments. */
function stripComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

/** Strip all tags from a fragment, leaving plain text (no newline insertion). */
function stripTags(html: string): string {
  return decodeEntities(stripComments(html).replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

/**
 * Convert an HTML fragment to clean multi-line plain text: block-level
 * closers and <br> become newlines, tags are stripped, entities decoded,
 * blank-line runs collapsed.
 */
export function htmlToText(html: string): string {
  let s = stripComments(html);
  s = s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(
    /<\/(p|div|li|h[1-6]|tr|table|dt|dd|dl|ul|ol|section|article|header|footer)>/gi,
    "\n",
  );
  s = s.replace(/<hr\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  // Normalize whitespace: trim trailing spaces per line, collapse blank runs.
  s = s
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, "").replace(/^[ \t]+/g, ""))
    .join("\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/** Split a dd's raw inner HTML into one or more plain-text lines. */
function ddLines(raw: string): string[] {
  const segments = raw.split(/<br\s*\/?>/gi);
  const out: string[] = [];
  for (const seg of segments) {
    const itemMatch = seg.match(/<div[^>]*class="[^"]*field--item[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const text = itemMatch ? stripTags(itemMatch[1]!) : stripTags(seg);
    if (text) out.push(text);
  }
  return out;
}

/** Parse "Label:" dt/dd groups within a metadata region into a label -> lines map. */
function parseDtDdGroups(html: string): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  const re = /<(dt|dd)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let currentLabel: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const tag = m[1]!.toLowerCase();
    const content = m[2]!;
    if (tag === "dt") {
      currentLabel = stripTags(content).replace(/:\s*$/, "");
      if (!groups.has(currentLabel)) groups.set(currentLabel, []);
    } else if (tag === "dd" && currentLabel) {
      groups.get(currentLabel)!.push(...ddLines(content));
    }
  }
  return groups;
}

function extractArticle(html: string): string {
  const m = html.match(/<article id="main-content"[^>]*>[\s\S]*?<\/article>/);
  if (!m) throw new Error('could not find <article id="main-content"> in page');
  return m[0];
}

function extractMeta(article: string, url: string, slug: string, fetchedAt: string): FetchedLetterMeta {
  const h1Match = article.match(/<h1[^>]*class="[^"]*content-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/);
  if (!h1Match) throw new Error("could not find content-title h1");
  const h1Raw = h1Match[1]!;

  const spanMatch = h1Raw.match(
    /<span[^>]*class="[^"]*font-family-sans[^"]*"[^>]*>([\s\S]*?)<\/span>/,
  );
  const company = stripTags(spanMatch ? h1Raw.slice(0, spanMatch.index) : h1Raw) || null;
  const spanRaw = spanMatch ? spanMatch[1]! : "";

  const marcsMatch = stripTags(spanRaw).match(/MARCS-CMS\s*(\d+)/i);
  const marcs_cms = marcsMatch ? marcsMatch[1]! : null;

  const timeMatch = spanRaw.match(/<time[^>]*datetime="(\d{4}-\d{2}-\d{2})T/);
  const issue_date = timeMatch ? timeMatch[1]! : null;

  // Metadata region: from the first <dl to the last </dl> in the article.
  const dlStart = article.search(/<dl\b/);
  const dlEnd = article.lastIndexOf("</dl>");
  if (dlStart === -1 || dlEnd === -1) throw new Error("could not find metadata <dl> blocks");
  const metaHtml = article.slice(dlStart, dlEnd + "</dl>".length);
  const groups = parseDtDdGroups(metaHtml);

  const deliveryLines = groups.get("Delivery Method") ?? [];
  const referenceLines = groups.get("Reference #") ?? [];
  const productLines = groups.get("Product") ?? [];
  const recipientLines = groups.get("Recipient") ?? [];
  const issuingOfficeLines = groups.get("Issuing Office") ?? [];

  return {
    url,
    slug,
    company,
    marcs_cms,
    issue_date,
    reference: referenceLines[0] ?? null,
    delivery_method: deliveryLines.length ? deliveryLines.join("; ") : null,
    product: productLines,
    recipient: recipientLines,
    issuing_office: issuingOfficeLines[0] ?? null,
    fetched_at: fetchedAt,
  };
}

function extractBodyText(article: string): string {
  const dlEnd = article.lastIndexOf("</dl>");
  if (dlEnd === -1) throw new Error("could not find metadata <dl> blocks");
  const bodyStart = dlEnd + "</dl>".length;

  const rest = article.slice(bodyStart);
  const asideIdx = rest.search(/<aside\b/);
  const qualtricsIdx = rest.indexOf("<!--BEGIN QUALTRICS");
  const candidates = [asideIdx, qualtricsIdx].filter((i) => i !== -1);
  const bodyEnd = candidates.length ? Math.min(...candidates) : rest.length;

  const bodyHtml = rest.slice(0, bodyEnd);
  return htmlToText(bodyHtml);
}

/** The last path segment of an FDA letter URL, used as a stable slug. */
export function slugFromUrl(url: string): string {
  const clean = url.replace(/\/$/, "");
  const parts = clean.split("/");
  return parts[parts.length - 1]!;
}

/**
 * Parse a full FDA Warning Letter HTML page (already fetched) into text + meta.
 * Pure — no network, no disk — so it is easy to test against a saved page.
 */
export function parseLetterHtml(html: string, url: string, fetchedAt = new Date().toISOString()): ParsedLetter {
  const slug = slugFromUrl(url);
  const article = extractArticle(html);
  const meta = extractMeta(article, url, slug, fetchedAt);
  const text = extractBodyText(article);
  return { text, meta };
}

/** Fetch an FDA Warning Letter URL and parse it into text + meta, in memory. */
export async function fetchLetterInMemory(url: string): Promise<ParsedLetter> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const html = await res.text();
  return parseLetterHtml(html, url);
}
