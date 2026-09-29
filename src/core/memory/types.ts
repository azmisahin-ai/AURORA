/**
 * Memory tiers (Phase 7, ADR 009).
 *
 * The production consensus is a three-tier hierarchy
 * (`docs/research/memory-systems.md` §1):
 *
 * | Tier      | Scope            | Storage            |
 * |-----------|------------------|--------------------|
 * | Working   | current loop     | in-memory          |
 * | Session   | one conversation | file (JSON)        |
 * | Knowledge | cross-session    | filesystem (ADR 002) |
 *
 * The knowledge tier already exists from Phase 3 and is *not* duplicated here:
 * retrieval into context stays tool-driven (`knowledge_search`), because the
 * research doc lists "which retrieval mechanism" as an explicit open question.
 */

import type { ChatMessage } from "../../providers/llm/LLMProvider.js";

/**
 * Working memory: the live transcript for one run.
 *
 * This is a *view over the transcript the loop is already building*, plus the
 * derived facts the context builder needs. It is intentionally not a database —
 * it dies with the run, which is what "working" means.
 */
export interface WorkingMemory {
  /** Append a message to the live transcript. */
  append(message: ChatMessage): void;
  /** The live transcript, oldest first. */
  messages(): ChatMessage[];
  /** Number of messages currently held. */
  size(): number;
  /** Drop everything. Used when a loop is reset. */
  clear(): void;
}

/** A conversation's durable, cross-restart record (Session memory tier). */
export interface SessionRecord {
  id: string;
  task: string;
  createdAt: string;
  updatedAt: string;
  /** Present once the session finished. */
  status?: string;
  /** Final assistant answer, truncated for storage. */
  output?: string;
  /** Tool names invoked, in order of first use. */
  toolsUsed: string[];
  iterations?: number;
  toolCalls?: number;
  /** Task ids this session was restoring, if it was a resumption. */
  resumedFrom?: string[];
}

export interface SessionWriteInput {
  task: string;
  status?: string;
  output?: string;
  toolsUsed?: string[];
  iterations?: number;
  toolCalls?: number;
  resumedFrom?: string[];
  id?: string;
}

/** Persists conversation records across restarts (Session tier). */
export interface SessionStore {
  /** Write (or overwrite) a session record. Idempotent by id. */
  save(record: SessionRecord): Promise<void>;
  /** Read one session record, or undefined when it does not exist. */
  get(id: string): Promise<SessionRecord | undefined>;
  /** All records, newest first by `updatedAt`. */
  list(): Promise<SessionRecord[]>;
  /**
   * The most recent records, newest first, excluding `exclude` ids. Used to
   * seed a new run from prior work.
   */
  recent(limit: number, exclude?: readonly string[]): Promise<SessionRecord[]>;
}

/** Builds the seed text a resumed run starts from, from prior session records. */
export interface SessionRecallBuilder {
  build(records: readonly SessionRecord[]): string;
}
