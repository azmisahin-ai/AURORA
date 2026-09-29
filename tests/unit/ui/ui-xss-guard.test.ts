import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The XSS property of the UI is *structural*: no code path turns a string into
 * markup (ADR 012 §3). A behavioral test can only probe payloads we thought of;
 * "no such call exists" is the property, so it is asserted by scanning the
 * source. If someone adds `innerHTML` later, this fails — which is the point.
 */

const uiRoot = fileURLToPath(new URL("../../../ui", import.meta.url));

/** Every `.js` and `.html` file under `ui/`, recursively. */
async function uiFiles(dir = uiRoot): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await uiFiles(full)));
    else if (entry.name.endsWith(".js") || entry.name.endsWith(".html")) out.push(full);
  }
  return out;
}

/**
 * Strip comments so a *mention* of a sink in a comment is not mistaken for a
 * use of it. The guard is about code that could run, not about prose. (This
 * module's own doc comment names the sinks, which is exactly the case.)
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("UI never renders API data as markup", () => {
  it("has no innerHTML / outerHTML / insertAdjacentHTML / document.write", async () => {
    const files = await uiFiles();
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const source = codeOnly(await readFile(file, "utf8"));
      // `innerHTML` also covers `outerHTML`'s siblings; check each sink by name.
      for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"]) {
        if (source.includes(sink)) offenders.push(`${relative(uiRoot, file)}: ${sink}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("has no eval / new Function / inline event handler attributes in HTML", async () => {
    const offenders: string[] = [];
    for (const file of await uiFiles()) {
      const source = codeOnly(await readFile(file, "utf8"));
      if (/\beval\s*\(/.test(source)) offenders.push(`${relative(uiRoot, file)}: eval`);
      if (/new\s+Function\s*\(/.test(source)) offenders.push(`${relative(uiRoot, file)}: new Function`);
      if (file.endsWith(".html") && /\son\w+\s*=/.test(source)) {
        offenders.push(`${relative(uiRoot, file)}: inline event handler`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the CSP-compatible shape: no inline <script> body or style attribute", async () => {
    const html = codeOnly(await readFile(join(uiRoot, "index.html"), "utf8"));
    // `script-src 'self'` / `style-src 'self'` block these, so their presence
    // would mean the page silently loses a script or style.
    expect(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/.test(html)).toBe(false);
    expect(/\sstyle\s*=\s*"/.test(html)).toBe(false);
  });
});
