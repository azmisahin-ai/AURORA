import { describe, expect, it, vi } from "vitest";
import {
  DuckDuckGoSearchProvider,
  parseDuckDuckGoResults,
  unwrapDuckDuckGoUrl,
} from "../../../src/providers/web/search/DuckDuckGoSearchProvider.js";

const HTML = `
<html><body>
  <div class="result web-result">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.ollama.com%2Fapi%2Fchat&amp;rut=abc">Ollama chat API</a>
    <a class="result__snippet">The chat endpoint in markdown.</a>
  </div>
  <div class="result web-result">
    <a class="result__a" href="https://github.com/ollama/ollama">Ollama on GitHub</a>
    <a class="result__snippet">Source repository.</a>
  </div>
  <div class="result">
    <a class="result__a" href="javascript:void(0)">Blocked scheme</a>
  </div>
</body></html>`;

describe("parseDuckDuckGoResults", () => {
  it("unwraps redirect links and reads titles and snippets", () => {
    const results = parseDuckDuckGoResults(HTML, 10);
    expect(results).toEqual([
      {
        title: "Ollama chat API",
        url: "https://docs.ollama.com/api/chat",
        snippet: "The chat endpoint in markdown.",
      },
      {
        title: "Ollama on GitHub",
        url: "https://github.com/ollama/ollama",
        snippet: "Source repository.",
      },
    ]);
  });

  it("honours maxResults", () => {
    expect(parseDuckDuckGoResults(HTML, 1)).toHaveLength(1);
  });

  it("drops non-http(s) hrefs", () => {
    const urls = parseDuckDuckGoResults(HTML, 10).map((r) => r.url);
    expect(urls.some((u) => u.startsWith("javascript:"))).toBe(false);
  });

  it("returns an empty list for unparseable markup", () => {
    expect(parseDuckDuckGoResults("<html><body>no results</body></html>", 10)).toEqual([]);
  });
});

describe("unwrapDuckDuckGoUrl", () => {
  it("returns the target from a uddg parameter", () => {
    expect(
      unwrapDuckDuckGoUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1"),
    ).toBe("https://example.com/a?b=1");
  });

  it("returns an empty string for an empty href", () => {
    expect(unwrapDuckDuckGoUrl("")).toBe("");
  });
});

describe("DuckDuckGoSearchProvider", () => {
  it("reports an unavailability of results as an empty list, not an error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "",
    } as unknown as Response);
    const provider = new DuckDuckGoSearchProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await provider.search({ query: "x" })).toEqual([]);
  });

  it("encodes the query and parses a successful response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => HTML,
    } as unknown as Response);
    const provider = new DuckDuckGoSearchProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const results = await provider.search({ query: "ollama api", maxResults: 5 });
    expect(results[0]?.url).toBe("https://docs.ollama.com/api/chat");
    const called = fetchImpl.mock.calls[0]?.[0] as string;
    expect(called).toContain("q=ollama+api");
  });
});