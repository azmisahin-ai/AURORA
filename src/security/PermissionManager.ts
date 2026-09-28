/**
 * Permission model. Tools declare what they need; the runtime grants a set per
 * run. A tool whose declared permissions are not all granted cannot execute.
 *
 * Permissions are coarse and additive by design (ADR 004): the point is a
 * legible, auditable gate, not a capability calculus.
 */
export type Permission =
  | "READ_ONLY"
  | "WORKSPACE_WRITE"
  | "COMMAND_EXECUTION"
  | "NETWORK_ACCESS"
  | "FULL_ACCESS";

export const ALL_PERMISSIONS: readonly Permission[] = [
  "READ_ONLY",
  "WORKSPACE_WRITE",
  "COMMAND_EXECUTION",
  "NETWORK_ACCESS",
  "FULL_ACCESS",
];

export type PermissionDecision =
  | { allowed: true }
  | { allowed: false; missing: Permission[] };

/**
 * Holds the permissions granted for a run and answers whether a tool's
 * requirements are satisfied. `FULL_ACCESS` implies every other permission.
 */
export class PermissionManager {
  private readonly granted: ReadonlySet<Permission>;

  constructor(granted: Iterable<Permission> = []) {
    this.granted = new Set(granted);
  }

  /** Permissions that effectively satisfy `required` given the grant set. */
  has(permission: Permission): boolean {
    if (this.granted.has("FULL_ACCESS")) return true;
    return this.granted.has(permission);
  }

  check(required: readonly Permission[]): PermissionDecision {
    const missing = required.filter((p) => !this.has(p));
    return missing.length === 0 ? { allowed: true } : { allowed: false, missing };
  }

  /** Convenience predicate used by the registry before executing a tool. */
  allows(required: readonly Permission[]): boolean {
    return this.check(required).allowed;
  }

  list(): Permission[] {
    return [...this.granted];
  }

  /** A manager granting everything, for tests only. */
  static full(): PermissionManager {
    return new PermissionManager(["FULL_ACCESS"]);
  }
}
