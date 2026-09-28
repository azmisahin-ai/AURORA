import { spawn } from "node:child_process";
import type {
  ExecutionProvider,
  ExecutionRequest,
  ExecutionResult,
} from "./ExecutionProvider.js";

const DEFAULT_MAX_OUTPUT = 64 * 1024;

/**
 * Runs commands as child processes on the local machine.
 *
 * Security properties, all load-bearing:
 *  - `shell: false` — the argv array is executed directly, so no shell
 *    metacharacter can ever be interpreted. This is why CommandValidator can
 *    reject shell syntax without worrying about bypasses.
 *  - A minimal, explicit environment: only PATH plus vars the caller passed.
 *    Host secrets (API keys, tokens) are not inherited by default.
 *  - `detached` process group + kill on timeout, so a hung child can be reaped
 *    rather than leaking.
 */
export class LocalExecutionProvider implements ExecutionProvider {
  readonly name = "local";

  constructor(private readonly envBase: Record<string, string> = defaultBaseEnv()) {}

  run(request: ExecutionRequest): Promise<ExecutionResult> {
    const { argv, cwd, timeoutMs } = request;
    if (argv.length === 0) {
      return Promise.reject(new Error("ExecutionRequest.argv must not be empty"));
    }

    const maxOutputBytes = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    const started = Date.now();

    return new Promise<ExecutionResult>((resolve, reject) => {
      const child = spawn(argv[0]!, argv.slice(1), {
        cwd,
        shell: false,
        env: { ...this.envBase, ...(request.env ?? {}) },
        // Own process group so we can signal the whole tree on timeout.
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let truncated = false;
      let timedOut = false;
      let settled = false;

      const append = (target: "out" | "err") => (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        const current = target === "out" ? stdout : stderr;
        if (current.length + text.length > maxOutputBytes) {
          truncated = true;
          const remaining = Math.max(0, maxOutputBytes - current.length);
          if (target === "out") stdout += text.slice(0, remaining);
          else stderr += text.slice(0, remaining);
          return;
        }
        if (target === "out") stdout += text;
        else stderr += text;
      };

      child.stdout.on("data", append("out"));
      child.stderr.on("data", append("err"));

      const killTree = () => {
        timedOut = true;
        if (child.pid === undefined) return;
        if (process.platform === "win32") {
          child.kill();
          return;
        }
        // Negative pid signals the whole process group.
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };

      const timer = setTimeout(killTree, timeoutMs);

      const onAbort = () => killTree();
      if (request.signal) {
        if (request.signal.aborted) killTree();
        else request.signal.addEventListener("abort", onAbort, { once: true });
      }

      const cleanup = () => {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
      };

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          exitCode: code,
          stdout,
          stderr,
          durationMs: Date.now() - started,
          timedOut,
          truncated,
        });
      });
    });
  }
}

/**
 * Deliberately small: PATH is required to resolve executables, everything else
 * (API keys, tokens) must be opted into explicitly by the caller.
 */
function defaultBaseEnv(): Record<string, string> {
  const base: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR"]) {
    const value = process.env[key];
    if (value !== undefined) base[key] = value;
  }
  return base;
}
