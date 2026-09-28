/**
 * Execution abstraction. Tools ask for a command to run; a provider decides
 * how and where. The local provider runs on this machine; a future sandbox
 * provider can run elsewhere without any tool changing.
 */

export interface ExecutionRequest {
  /** Executable plus arguments. Never a shell string. */
  argv: string[];
  cwd: string;
  /** Hard wall-clock limit for the process. */
  timeoutMs: number;
  /** Extra environment variables, merged over a minimal base environment. */
  env?: Record<string, string>;
  /** Truncate stdout/stderr beyond this many bytes to bound context size. */
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export interface ExecutionResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** True when the process was killed for exceeding `timeoutMs`. */
  timedOut: boolean;
  /** True when output was truncated to respect `maxOutputBytes`. */
  truncated: boolean;
}

export interface ExecutionProvider {
  readonly name: string;
  run(request: ExecutionRequest): Promise<ExecutionResult>;
}
