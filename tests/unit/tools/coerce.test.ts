import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { coerceArguments } from "../../../src/tools/coerce.js";

const schema = z.toJSONSchema(
  z.object({
    query: z.string(),
    limit: z.number().int().optional(),
    verified: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
    nested: z.object({ count: z.number() }).optional(),
  }),
  { target: "draft-7" },
);

describe("coerceArguments", () => {
  it("coerces numeric strings to numbers", () => {
    expect(coerceArguments({ query: "x", limit: "5" }, schema)).toEqual({ query: "x", limit: 5 });
  });

  it("coerces boolean strings to booleans", () => {
    expect(coerceArguments({ query: "x", verified: "true" }, schema)).toEqual({
      query: "x",
      verified: true,
    });
    expect(coerceArguments({ query: "x", verified: "FALSE" }, schema)).toEqual({
      query: "x",
      verified: false,
    });
  });

  it("never coerces a string-typed field, even a numeric-looking one", () => {
    // `query` is a string in the schema; "123" must stay a string.
    expect(coerceArguments({ query: "123" }, schema)).toEqual({ query: "123" });
  });

  it("leaves an uncoercible string in place so validation still reports it", () => {
    expect(coerceArguments({ query: "x", limit: "many" }, schema)).toEqual({
      query: "x",
      limit: "many",
    });
    expect(coerceArguments({ query: "x", verified: "maybe" }, schema)).toEqual({
      query: "x",
      verified: "maybe",
    });
  });

  it("coerces inside arrays and nested objects", () => {
    expect(
      coerceArguments(
        { query: "x", tags: ["1", "2"], nested: { count: "9" } },
        schema,
      ),
    ).toEqual({ query: "x", tags: ["1", "2"], nested: { count: 9 } });
  });

  it("returns the same reference when nothing changed", () => {
    const input = { query: "x", limit: 5 };
    expect(coerceArguments(input, schema)).toBe(input);
  });

  it("is inert for non-object input", () => {
    expect(coerceArguments(null, schema)).toBeNull();
    expect(coerceArguments("str", schema)).toBe("str");
    expect(coerceArguments([1, 2], schema)).toEqual([1, 2]);
  });
});
