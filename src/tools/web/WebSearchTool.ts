import { z } from "zod/v4";
import { defineTool } from "../types.js";
import type { SearchProvider } from "../../providers/web/search/SearchProvider.js";
import { wrapUntrusted } from "../../security/UntrustedData.js";

/**
 * Search the web for candidate URLs. Results are untrusted data (titles and
 * snippets come from arbitrary pages). When no provider is configured the tool
 * reports the degraded mode rather than failing, so the agent can fall back to
 * fetching URLs it already knows.
 */
export function webSearchTool(provider: SearchProvider) {
  return defineTool({
    name: "web_search",
    description:
      "Search the web and return candidate URLs with titles and snippets. " +
      "Requires a configured search provider; without one this returns no results " +
      "and you should fetch known URLs directly with web_fetch.",
    inputSchema: z.object({
      query: z.string().min(1).describe("Search query"),
      maxResults: z.number().int().positive().max(20).optional().describe("Max results"),
    }),
    requiredPermissions: ["NETWORK_ACCESS"] as const,
    async execute(input, ctx) {
      if (!provider.available) {
        return {
          ok: true,
          output:
            "No search provider is configured (AURORA_SEARCH_PROVIDER=noop). " +
            "web_search cannot return results. Use web_fetch with a known URL instead, " +
            "or configure a search provider.",
        };
      }

      const results = await provider.search({
        query: input.query,
        ...(input.maxResults !== undefined ? { maxResults: input.maxResults } : {}),
        signal: ctx.signal,
      });

      if (results.length === 0) {
        return { ok: true, output: `No results for "${input.query}".` };
      }

      const lines = results.map(
        (r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`,
      );
      const wrapped = wrapUntrusted(lines.join("\n"), {
        origin: `web_search "${input.query}" via ${provider.name}`,
      });
      return { ok: true, output: wrapped.text };
    },
  });
}
