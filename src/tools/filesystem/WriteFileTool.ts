import { z } from "zod/v4";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { defineTool } from "../types.js";

const MAX_BYTES = 256 * 1024;

export const writeFileTool = defineTool({
  name: "write_file",
  description:
    "Create or overwrite a UTF-8 text file inside the workspace. Parent directories are created as needed. Paths outside the workspace are rejected.",
  inputSchema: z.object({
    path: z.string().min(1).describe("File path relative to the workspace root"),
    content: z.string().describe("Full file contents to write"),
  }),
  requiredPermissions: ["WORKSPACE_WRITE"] as const,
  async execute(input, ctx) {
    const bytes = Buffer.byteLength(input.content, "utf8");
    if (bytes > MAX_BYTES) {
      return {
        ok: false,
        output: `Refusing to write ${bytes} bytes; the limit is ${MAX_BYTES}.`,
      };
    }
    // resolveReal first: a symlinked destination must not be followed out of
    // the workspace.
    const absolute = await ctx.pathValidator.resolveReal(input.path, ctx.workspace);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, input.content, "utf8");
    return { ok: true, output: `Wrote ${bytes} bytes to ${input.path}` };
  },
});
