/**
 * Model argument coercion at the tool boundary.
 *
 * A model routinely emits `"5"` for an integer and `"true"` for a boolean even
 * when the JSON Schema says otherwise — this is the single most common reason a
 * tool call is rejected by a strict validator (observed against Ollama with
 * qwen2.5, llama3.2 and others). Rejecting those calls wastes an iteration and
 * leaves the model with no signal about *which* shape it got wrong.
 *
 * The fix belongs here, once, rather than in every tool: the coercion is driven
 * by the *generated JSON Schema* for the tool, so a field is only coerced when
 * the schema itself declares it numeric or boolean. A string-typed field is
 * never touched, so this cannot turn `"123"` into a number for `slug`.
 *
 * Deliberately narrow — only the lossless string→number/boolean direction:
 *  - `"5"`     → `5`       (a finite number)
 *  - `"true"`  → `true`    (also "false", "yes"/"no", "1"/"0", case-insensitive)
 *  - anything else is left as-is and rejected by validation, with the schema
 *    issues still reported to the model.
 */

/** A minimal view of the JSON Schema shapes we care about. */
interface JsonSchemaNode {
  type?: string;
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
}

const TRUE_WORDS = new Set(["true", "yes", "on", "1"]);
const FALSE_WORDS = new Set(["false", "no", "off", "0"]);

function coerceBoolean(value: string): boolean | undefined {
  const lowered = value.trim().toLowerCase();
  if (TRUE_WORDS.has(lowered)) return true;
  if (FALSE_WORDS.has(lowered)) return false;
  return undefined;
}

/** A string that is unambiguously a finite number, and nothing else. */
function coerceNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  // Reject forms `Number` would happily accept but that are almost never meant
  // as a number here: empty/whitespace-only, Infinity, hex, "1e3" stays valid.
  if (trimmed === "Infinity" || trimmed === "-Infinity" || trimmed === "NaN") return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function effectiveType(node: JsonSchemaNode | undefined): string | undefined {
  if (!node) return undefined;
  if (typeof node.type === "string") return node.type;
  for (const branch of [...(node.anyOf ?? []), ...(node.oneOf ?? [])]) {
    const t = effectiveType(branch);
    if (t !== undefined) return t;
  }
  return undefined;
}

function coerceNode(value: unknown, schema: JsonSchemaNode | undefined): unknown {
  const type = effectiveType(schema);
  if (typeof value === "string") {
    if (type === "number" || type === "integer") return coerceNumber(value) ?? value;
    if (type === "boolean") return coerceBoolean(value) ?? value;
    return value;
  }

  if (Array.isArray(value)) {
    if (type === "array" && schema?.items) {
      return value.map((item) => coerceNode(item, schema.items));
    }
    return value;
  }

  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const properties = schema?.properties;
    if (!properties) return value;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(obj)) {
      out[key] = coerceNode(entry, properties[key]);
    }
    return out;
  }

  return value;
}

/**
 * Return `args` with values coerced to match `schema`. A new object is returned
 * only when something actually changed, so the common (already-correct) case
 * allocates nothing.
 */
export function coerceArguments<T>(args: T, schema: unknown): T {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return args;
  if (schema === null || typeof schema !== "object") return args;
  const coerced = coerceNode(args, schema as JsonSchemaNode) as T;
  return sameShape(args, coerced) ? args : coerced;
}

/** Cheap structural equality on the two trees we just walked. */
function sameShape(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => sameShape(v, b[i]));
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    return (
      ka.length === kb.length &&
      ka.every((k) =>
        sameShape((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
      )
    );
  }
  return false;
}
