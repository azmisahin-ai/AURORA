/**
 * Best-effort parsing of test-runner summaries.
 *
 * Kept in `providers` (not `tools`) so both the model-facing `run_tests` tool
 * and the loop-trusted `CommandVerifier` read runner output the same way. A
 * verifier that interpreted a summary differently from the tool the model calls
 * would be a silent inconsistency.
 *
 * "Best-effort" is load-bearing: an unrecognised format returns `undefined`
 * rather than a guess, and callers must not treat `undefined` as "zero tests".
 * The verdict is always the process exit code; these counts only refine it.
 */

export interface TestCounts {
  pass: number;
  fail: number;
  total?: number;
}

export function parseTestSummary(output: string): TestCounts | undefined {
  // node --test: "ℹ pass 3" / "ℹ fail 1" / "ℹ tests 4"
  const nodePass = /\bpass\s+(\d+)/i.exec(output);
  const nodeFail = /\bfail\s+(\d+)/i.exec(output);
  const nodeTotal = /\btests\s+(\d+)/i.exec(output);
  if (nodePass || nodeFail) {
    return {
      pass: nodePass ? Number(nodePass[1]) : 0,
      fail: nodeFail ? Number(nodeFail[1]) : 0,
      ...(nodeTotal ? { total: Number(nodeTotal[1]) } : {}),
    };
  }

  // Vitest/Jest: "Tests  1 failed | 2 passed (3)"
  const combined = /tests?\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed\s*\((\d+)\)/i.exec(output);
  if (combined) {
    return {
      fail: combined[1] ? Number(combined[1]) : 0,
      pass: Number(combined[2]),
      total: Number(combined[3]),
    };
  }

  return undefined;
}

/**
 * True when a parseable summary proves the runner executed nothing.
 *
 * Node's `node --test` exits **0** when its glob matches no test files, so
 * without this check a command verifier would report a vacuous run as a pass —
 * the exact failure the external-signal design exists to prevent. Verified
 * against Node v24.21.0: no test files yields `ℹ pass 0 / ℹ fail 0` and exit 0.
 */
export function ranNoTests(counts: TestCounts | undefined): boolean {
  if (!counts) return false;
  return counts.pass === 0 && counts.fail === 0 && (counts.total ?? 0) === 0;
}
