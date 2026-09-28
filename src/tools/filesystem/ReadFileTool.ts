import { z } from "zod/v4";
import { readFile } from "node:fs/promises";
import { defineTool } from "../types.js";

const MAX_BYTES = 256 * 1024;

export const readFileTool = defineTool({
  name: "read_file",
  description:
    "Read a UTF-8 text file from the workspace. Paths are relative to the workspace root unless absolute; paths outside the workspace are rejected.",
  inputSchema: z.object({
    path: z
      .string()
      .min(1)
      .describe("File path, relative to the workspace root (e.g. src/index.ts)"),
  }),
  requiredPermissions: ["READ_ONLY"] as const,
  async execute(input, ctx) {
    const absolute = await ctx.pathValidator.resolveReal(input.path, ctx.workspace);
    let buffer: Buffer;
    try {
      buffer = await readFile(absolute);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { ok: false, output: `File not found: ${input.path}` };
      if (code === "EISDIR") return { ok: false, output: `Not a file (is a directory): ${input.path}` };
      throw err;
    }
    if (buffer.length > MAX_BYTES) {
      return {
        ok: false,
        output: `File exceeds the ${MAX_BYTES}-byte read limit: ${input.path} (${buffer.length} bytes)`,
      };
    }
    if (buffer.includes(0)) {
      return { ok: false, output: `Refusing to read binary file: ${input.path}` };
    }
    return { ok: true, output: buffer.toString("utf8") };
  },
});
