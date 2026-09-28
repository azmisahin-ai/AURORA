import { describe, expect, it } from "vitest";
import {
  CommandValidator,
  CommandValidationError,
  tokenize,
} from "../../../src/security/CommandValidator.js";

const make = (allowed: string[], blocked: string[] = []) =>
  new CommandValidator({ allowed, blocked });

describe("CommandValidator", () => {
  it("accepts an allowlisted command", () => {
    const v = make(["npm", "node", "echo"]);
    expect(v.validate("npm test").argv).toEqual(["npm", "test"]);
    expect(v.validate("npm test").base).toBe("npm");
  });

  it("accepts an allowlisted command with flags and paths", () => {
    const v = make(["ls"]);
    expect(v.validate("ls -la src/foo").argv).toEqual(["ls", "-la", "src/foo"]);
  });

  it("rejects a command not on the allowlist", () => {
    const v = make(["npm"]);
    expect(() => v.validate("python script.py")).toThrow(CommandValidationError);
    expect(() => v.validate("python script.py")).toThrow(/not on the allowed list/);
  });

  it("rejects a blocked command", () => {
    const v = make(["rm", "npm"], ["rm"]);
    expect(() => v.validate("rm -rf /")).toThrow(/blocked list/);
  });

  it("rejects always-blocked commands even if allowlisted", () => {
    const v = make(["sudo", "bash", "sh"]);
    expect(() => v.validate("sudo ls")).toThrow(/never permitted/);
    expect(() => v.validate("bash -c x")).toThrow(/never permitted/);
  });

  it("rejects shell metacharacters: semicolon chaining", () => {
    const v = make(["echo", "cat"]);
    expect(() => v.validate("echo hi; cat /etc/passwd")).toThrow(/metacharacters/);
  });

  it("rejects pipes", () => {
    const v = make(["echo", "grep"]);
    expect(() => v.validate("echo hi | grep h")).toThrow(/metacharacters/);
  });

  it("rejects redirects", () => {
    const v = make(["echo"]);
    expect(() => v.validate("echo hi > /etc/passwd")).toThrow(/metacharacters/);
    expect(() => v.validate("echo hi >> f")).toThrow(/metacharacters/);
    expect(() => v.validate("echo hi < f")).toThrow(/metacharacters/);
  });

  it("rejects command substitution and backticks", () => {
    const v = make(["echo"]);
    expect(() => v.validate("echo $(whoami)")).toThrow(/metacharacters/);
    expect(() => v.validate("echo `whoami`")).toThrow(/metacharacters/);
  });

  it("rejects variable expansion and ampersands", () => {
    const v = make(["echo"]);
    expect(() => v.validate("echo $HOME")).toThrow(/metacharacters/);
    expect(() => v.validate("echo a && echo b")).toThrow(/metacharacters/);
  });

  it("rejects a newline-embedded command", () => {
    const v = make(["echo"]);
    expect(() => v.validate("echo a\necho b")).toThrow(/metacharacters/);
  });

  it("rejects an empty command", () => {
    const v = make(["npm"]);
    expect(() => v.validate("   ")).toThrow(/Empty command/);
  });

  it("normalises a path-qualified executable to its base name", () => {
    const v = make(["node"]);
    expect(v.validate("/usr/local/bin/node -v").base).toBe("node");
  });

  it("strips a .exe suffix", () => {
    const v = make(["node"]);
    expect(v.validate("node.exe -v").base).toBe("node");
  });

  it("is case-insensitive on the command name", () => {
    const v = make(["npm"]);
    expect(v.validate("NPM test").base).toBe("npm");
  });

  it("keeps quoted arguments intact", () => {
    const v = make(["echo"]);
    expect(v.validate('echo "hello world"').argv).toEqual(["echo", "hello world"]);
    expect(v.validate("echo 'single quoted'").argv).toEqual(["echo", "single quoted"]);
  });

  it("rejects unbalanced quotes", () => {
    const v = make(["echo"]);
    expect(() => v.validate('echo "unterminated')).toThrow(/Unbalanced quote/);
  });

  it("tryValidate returns a discriminated result instead of throwing", () => {
    const v = make(["npm"]);
    expect(v.tryValidate("npm test").ok).toBe(true);
    const bad = v.tryValidate("rm -rf /");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/not on the allowed list/);
  });
});

describe("tokenize", () => {
  it("splits on whitespace", () => {
    expect(tokenize("a b   c")).toEqual(["a", "b", "c"]);
  });

  it("handles adjacent quotes and text", () => {
    expect(tokenize('a"b c"d')).toEqual(["ab cd"]);
  });

  it("preserves empty quoted arguments", () => {
    expect(tokenize('echo ""')).toEqual(["echo", ""]);
  });

  it("throws on an unterminated quote", () => {
    expect(() => tokenize("echo 'oops")).toThrow(CommandValidationError);
  });
});
