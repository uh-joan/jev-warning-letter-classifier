/**
 * Print recent FDA Warning Letter URLs + issuing office as JSON, using the
 * underlying Drupal Views DataTables ajax endpoint behind the listing page
 * (https://www.fda.gov/.../compliance-actions-and-activities/warning-letters),
 * rather than scraping the JS-rendered table.
 *
 * Usage:
 *   npx tsx scripts/list-letters.ts [count]   # default 25
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const LISTING_PAGE_URL =
  "https://www.fda.gov/inspections-compliance-enforcement-and-criminal-investigations/compliance-actions-and-activities/warning-letters";

const AJAX_URL = "https://www.fda.gov/datatables/views/ajax";

interface Row {
  posted_date: string | null;
  letter_date: string | null;
  url: string;
  company: string;
  issuing_office: string;
  subject: string;
}

interface AjaxResponse {
  draw: number;
  recordsTotal: number;
  recordsFiltered: number;
  data: string[][];
}

/** Find the view_dom_id for the warning-letters DataTable from the listing page's drupalSettings JSON. */
function findViewDomId(html: string): string {
  const m = html.match(
    /<script type="application\/json" data-drupal-selector="drupal-settings-json">([\s\S]*?)<\/script>/,
  );
  if (!m) throw new Error("could not find drupal-settings-json on listing page");
  const settings = JSON.parse(m[1]!);
  const ajaxViews = settings?.views?.ajaxViews as Record<string, { view_dom_id: string }> | undefined;
  const key = ajaxViews ? Object.keys(ajaxViews)[0] : undefined;
  const domId = key ? ajaxViews![key]!.view_dom_id : undefined;
  if (!domId) throw new Error("could not find view_dom_id in drupalSettings");
  return domId;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

function extractHref(html: string): string | null {
  const m = html.match(/href="([^"]+)"/);
  return m ? m[1]!.replace(/&amp;/g, "&") : null;
}

function extractDatetime(html: string): string | null {
  const m = html.match(/datetime="([^"]+)"/);
  return m ? m[1]!.slice(0, 10) : null;
}

async function listLetters(count: number): Promise<Row[]> {
  const listingRes = await fetch(LISTING_PAGE_URL, { headers: { "User-Agent": UA } });
  if (!listingRes.ok) throw new Error(`HTTP ${listingRes.status} fetching listing page`);
  const listingHtml = await listingRes.text();
  const domId = findViewDomId(listingHtml);

  const params = new URLSearchParams({
    _drupal_ajax: "1",
    _wrapper_format: "drupal_ajax",
    pager_element: "0",
    view_args: "",
    view_base_path:
      "inspections-compliance-enforcement-and-criminal-investigations/compliance-actions-and-activities/warning-letters/datatables-data",
    view_display_id: "warning_letter_solr_block",
    view_dom_id: domId,
    view_name: "warning_letter_solr_index",
    view_path:
      "/inspections-compliance-enforcement-and-criminal-investigations/compliance-actions-and-activities/warning-letters",
    draw: "1",
    start: "0",
    length: String(count),
  });

  const ajaxRes = await fetch(`${AJAX_URL}?${params.toString()}`, { headers: { "User-Agent": UA } });
  if (!ajaxRes.ok) throw new Error(`HTTP ${ajaxRes.status} fetching datatables ajax endpoint`);
  const json = (await ajaxRes.json()) as AjaxResponse;

  return json.data.map((row) => {
    const [postedHtml, letterHtml, linkHtml, office, subjectHtml] = row;
    const href = extractHref(linkHtml ?? "");
    return {
      posted_date: extractDatetime(postedHtml ?? ""),
      letter_date: extractDatetime(letterHtml ?? ""),
      url: href ? new URL(href, "https://www.fda.gov").toString() : "",
      company: stripTags(linkHtml ?? ""),
      issuing_office: (office ?? "").trim(),
      subject: stripTags(subjectHtml ?? ""),
    };
  });
}

async function main() {
  const count = Number(process.argv[2] ?? 25) || 25;
  const rows = await listLetters(count);
  console.log(JSON.stringify(rows, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
