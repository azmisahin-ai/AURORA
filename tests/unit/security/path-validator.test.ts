import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  PathValidator,
  PathValidationError,
} from "../../../src/security/PathValidator.js";

let root: string;
let outside: string;

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), "aurora-pv-"));
  root = join(base, "workspace");
  outside = join(base, "outside");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "secret.txt"), "top secret");
});

afterEach(async () => {
  await rm(resolve(root, ".."), { recursive: true, force: true });
});

describe("PathValidator.resolve", () => {
  const v = () => new PathValidator([root]);

  it("resolves a relative path inside the root", () => {
    expect(v().resolve("src/index.ts")).toBe(join(root, "src/index.ts"));
  });

  it("resolves an absolute path inside the root", () => {
    expect(v().resolve(join(root, "a.txt"))).toBe(join(root, "a.txt"));
  });

  it("accepts the root itself", () => {
    expect(v().resolve(".")).toBe(root);
  });

  it("rejects the classic traversal ../../etc/passwd", () => {
    expect(() => v().resolve("../../etc/passwd")).toThrow(PathValidationError);
    expect(() => v().resolve("../../etc/passwd")).toThrow(/escapes the allowed roots/);
  });

  it("rejects traversal that climbs out and back in via a sibling", () => {
    expect(() => v().resolve("../outside/secret.txt")).toThrow(PathValidationError);
  });

  it("rejects an absolute path outside the root", () => {
    expect(() => v().resolve("/etc/passwd")).toThrow(PathValidationError);
  });

  it("rejects a NUL byte", () => {
    expect(() => v().resolve("a\0b")).toThrow(/NUL/);
  });

  it("accepts a path whose name merely starts with dots", () => {
    expect(v().resolve("..hidden/file")).toBe(join(root, "..hidden/file"));
  });

  it("supports multiple roots", () => {
    const multi = new PathValidator([root, outside]);
    expect(multi.resolve(join(outside, "secret.txt"))).toBe(join(outside, "secret.txt"));
  });

  it("requires at least one root", () => {
    expect(() => new PathValidator([])).toThrow(/at least one allowed root/);
  });
});

describe("PathValidator.resolveReal (symlink escape)", () => {
  it("rejects a symlink pointing outside the root", async () => {
    const link = join(root, "escape");
    await symlink(outside, link, "dir");
    const v = new PathValidator([root]);
    await expect(v.resolveReal("escape/secret.txt")).rejects.toThrow(PathValidationError);
  });

  it("rejects a symlinked file pointing outside the root", async () => {
    const link = join(root, "secret-link");
    await symlink(join(outside, "secret.txt"), link, "file");
    const v = new PathValidator([root]);
    await expect(v.resolveReal("secret-link")).rejects.toThrow(/symlink escape/);
  });

  it("allows a symlink that stays inside the root", async () => {
    await mkdir(join(root, "real"), { recursive: true });
    await writeFile(join(root, "real", "f.txt"), "ok");
    await symlink(join(root, "real"), join(root, "alias"), "dir");
    const v = new PathValidator([root]);
    const resolved = await v.resolveReal("alias/f.txt");
    expect(resolved).toBe(join(root, "real", "f.txt"));
  });

  it("handles a not-yet-existing nested path under an existing root", async () => {
    const v = new PathValidator([root]);
    const resolved = await v.resolveReal("new/deep/file.txt");
    expect(resolved).toBe(join(root, "new/deep/file.txt"));
  });

  it("still rejects lexical traversal before touching the filesystem", async () => {
    const v = new PathValidator([root]);
    await expect(v.resolveReal("../outside/secret.txt")).rejects.toThrow(PathValidationError);
  });
});
