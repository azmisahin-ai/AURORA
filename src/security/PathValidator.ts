import { isAbsolute, relative, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { mkdirSync } from "node:fs";

/**
 * Confines filesystem access to a set of allowed roots.
 *
 * Two distinct threats are handled:
 *  1. Lexical traversal (`../../etc/passwd`) — rejected by normalising and
 *     checking containment.
 *  2. Symlink escape — a path that *lexically* sits inside a root but resolves,
 *     via a symlink, to somewhere outside it. Handled by resolving the real
 *     path of the deepest existing ancestor and re-checking containment.
 */
export class PathValidator {
  private readonly roots: readonly string[];

  constructor(roots: Iterable<string>) {
    this.roots = [...roots].map((r) => resolve(r));
    if (this.roots.length === 0) {
      throw new Error("PathValidator requires at least one allowed root");
    }
  }

  get allowedRoots(): readonly string[] {
    return this.roots;
  }

  /**
   * Resolve `candidate` against `baseDir` and require it to be inside a root.
   * Returns the absolute, contained path. Throws on any violation.
   */
  resolve(candidate: string, baseDir?: string): string {
    if (candidate.includes("\0")) {
      throw new PathValidationError("Path contains a NUL byte", candidate);
    }

    const absolute = isAbsolute(candidate)
      ? resolve(candidate)
      : resolve(baseDir ?? this.roots[0]!, candidate);

    if (!this.isContained(absolute)) {
      throw new PathValidationError(
        `Path escapes the allowed roots: ${candidate}`,
        candidate,
      );
    }
    return absolute;
  }

  /** True when `absolute` is one of the roots or sits beneath one. */
  private isContained(absolute: string): boolean {
    return this.roots.some((root) => {
      const rel = relative(root, absolute);
      if (rel === "") return true;
      if (isAbsolute(rel)) return false;
      // Must not be the parent itself or climb into a parent directory. A plain
      // `startsWith("..")` is wrong: "..hidden" is a legitimate file name.
      return rel !== ".." && !rel.startsWith(`..${sep}`);
    });
  }

  /**
   * Resolve, then verify with the real filesystem that no symlink on the path
   * escapes a root. Call before any write; for reads the lexical check plus a
   * post-open check is usually enough, but writes must be certain.
   */
  async resolveReal(candidate: string, baseDir?: string): Promise<string> {
    const absolute = this.resolve(candidate, baseDir);
    // Walk up to the deepest existing ancestor; non-existent tail components
    // cannot be symlinks, so they are safe to append after checking the prefix.
    let prefix = absolute;
    const tail: string[] = [];
    for (;;) {
      try {
        const real = await realpath(prefix);
        const recombined = tail.length > 0 ? resolve(real, ...[...tail].reverse()) : real;
        if (!this.isContained(recombined)) {
          throw new PathValidationError(
            `Path resolves outside the allowed roots (symlink escape): ${candidate}`,
            candidate,
          );
        }
        return recombined;
      } catch (err) {
        if (err instanceof PathValidationError) throw err;
        const cut = prefix.lastIndexOf(sep);
        tail.push(prefix.slice(cut + 1));
        const parent = cut > 0 ? prefix.slice(0, cut) : sep;
        if (parent === prefix) break;
        prefix = parent;
      }
    }
    // No ancestor existed at all; fall back to the lexical result.
    return absolute;
  }

  /** Create the containment root if it does not yet exist (workspace bootstrap). */
  ensureRootExists(index = 0): void {
    const root = this.roots[index];
    if (root) mkdirSync(root, { recursive: true });
  }
}

export class PathValidationError extends Error {
  readonly candidate: string;
  constructor(message: string, candidate: string) {
    super(message);
    this.name = "PathValidationError";
    this.candidate = candidate;
  }
}
