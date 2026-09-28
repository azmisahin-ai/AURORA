import { z } from "zod/v4";
import { readdir, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { defineTool } from "../types.js";

const MAX_ENTRIES = 500;

const SKIP = new Set(["node_modules", ".git", "dist", "coverage", ".cache"]);

export const listFilesTool = defineTool({
  name: "list_files",
  description:
    "List files and directories under a workspace path. Set recursive=true to walk subdirectories (heavy directories such as node_modules and .git are skipped).",
  inputSchema: z.object({
    path: z.string().default(".").describe("Directory relative to the workspace root"),
    recursive: z.boolean().default(false).describe("Walk subdirectories"),
  }),
  requiredPermissions: ["READ_ONLY"] as const,
  async execute(input, ctx) {
    const root = await ctx.pathValidator.resolveReal(input.path, ctx.workspace);
    const listing: string[] = [];

    const walk = async (dir: string): Promise<void> => {
      if (listing.length >= MAX_ENTRIES) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`Directory not found: ${relative(ctx.workspace, dir) || "."}`);
        }
        throw err;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (listing.length >= MAX_ENTRIES) return;
        if (SKIP.has(entry.name)) continue;
        const full = resolve(dir, entry.name);
        const rel = relative(ctx.workspace, full);
        if (entry.isDirectory()) {
          listing.push(`${rel}/`);
          if (input.recursive) await walk(full);
        } else {
          const info = await stat(full);
          listing.push(`${rel} (${info.size} bytes)`);
        }
      }
    };

    await walk(root);
    const suffix =
      listing.length >= MAX_ENTRIES ? `\n(truncated at ${MAX_ENTRIES} entries)` : "";
    return {
      ok: true,
      output: listing.length === 0 ? "(empty)" : listing.join("\n") + suffix,
    };
  },
});
