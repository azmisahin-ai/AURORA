import { load } from "cheerio";
import TurndownService from "turndown";

export interface ExtractedContent {
  title: string;
  /** Readable text as markdown when the input was HTML, else the input as-is. */
  text: string;
  /** Plain text with markup removed, for keyword search and size estimates. */
  plainText: string;
}

const DROP_SELECTORS = [
  "script",
  "style",
  "noscript",
  "template",
  "iframe",
  "svg",
  "canvas",
  "form",
  "nav",
  "footer",
  "header",
  "aside",
  "[role=navigation]",
  "[role=banner]",
  "[aria-hidden=true]",
  ".advertisement",
  ".ads",
  ".cookie-banner",
];

/** Prefer the densest semantic container; fall back to the whole body. */
const CONTENT_SELECTORS = [
  "main",
  "article",
  "[role=main]",
  "#content",
  ".content",
  ".post",
  ".markdown-body",
];

/**
 * Convert an HTML document (or plain text) into readable markdown.
 *
 * This is deliberately a readability heuristic, not a browser: no JavaScript is
 * executed, so client-rendered pages will yield little. That limitation is
 * preferable to running untrusted script.
 */
export function htmlToMarkdown(html: string): ExtractedContent {
  const $ = load(html);

  for (const selector of DROP_SELECTORS) $(selector).remove();

  const title = ($("title").first().text() || $("h1").first().text() || "").trim();

  // Collect inner HTML and text together so the chosen container is used by
  // both outputs; avoids holding a Cheerio selection across generic types.
  const body = $("body");
  let rootHtml = body.html() ?? "";
  let rootText = body.text() ?? "";

  for (const selector of CONTENT_SELECTORS) {
    const candidate = $(selector).first();
    if (candidate.length > 0 && (candidate.text() ?? "").trim().length > 200) {
      rootHtml = candidate.html() ?? "";
      rootText = candidate.text() ?? "";
      break;
    }
  }

  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  service.remove(["script", "style"]);

  const markdown = service.turndown(rootHtml).trim();
  const plainText = rootText.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

  return { title, text: markdown, plainText };
}

/** Normalise a non-HTML response body: keep it verbatim, collapse nothing. */
export function textContent(body: string): ExtractedContent {
  return { title: "", text: body.trim(), plainText: body.trim() };
}

export function extractContent(body: string, contentType: string): ExtractedContent {
  const isHtml =
    contentType.includes("html") || /^\s*<(?:!doctype|html)/i.test(body.slice(0, 200));
  return isHtml ? htmlToMarkdown(body) : textContent(body);
}
