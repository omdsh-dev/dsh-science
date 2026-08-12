/** Public and type-erased contracts for one session projection unit. */

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ZodType } from 'zod'
import type { SessionProjectionMap } from './types.ts'

/**
 * One domain's pure projection computation. The framework owns event drive,
 * watermarks, persistence admission, and notifications; the domain owns only
 * `init`, `apply`, `view`, and any private-state validation.
 */
export interface ProjectionDefinition<K extends keyof SessionProjectionMap, S> {
  /** The non-empty projection key this unit owns. */
  key: K
  /**
   * Process-local identity of this exact definition family. Use one
   * module-private `Symbol()` for definitions whose functions and schemas are
   * interchangeable across repeated composition. Do not use `Symbol.for()` or
   * reuse a token across instance-configured semantics.
   */
  definitionToken: symbol
  /** Validates the wire payload (`view` output) before it leaves the host. */
  schema: ZodType<SessionProjectionMap[K]>
  /**
   * Admits persisted private state. Parsing is validation-only: a transform
   * that changes the JSON value rejects the row rather than migrating it.
   * Live states never pass through this parser.
   */
  checkpointStateSchema?: ZodType<S>
  /**
   * Extracts the event watermark encoded by private checkpoint state. When
   * supplied, the registry requires every emitted or admitted state to equal
   * the row's outer `seq`, which prevents a valid older state from being
   * spliced under a newer watermark.
   */
  checkpointStateSeq?(state: S): number
  /** State for the empty log. */
  init(): S
  /**
   * Pure transition over one committed event. An uninterested unit SHOULD
   * return the same state reference so the default change gate does no work.
   */
  apply(state: S, event: SessionEvent): S
  /** Derive the whole public wire value from private state. */
  view(state: S): SessionProjectionMap[K]
  /**
   * Optionally narrow public-change notification after `apply` returned a
   * different reference. It cannot turn a same-reference no-op into a change.
   */
  viewChanged?(previous: S, next: S): boolean
  /** Persisted-state invalidation version; a non-negative safe integer. */
  stateVersion: number
}

/** One schema-validated public value changed at a committed event watermark. */
export type ProjectionChangeListener = (
  session: Session,
  key: Extract<keyof SessionProjectionMap, string>,
  value: unknown,
  seq: number,
) => void | PromiseLike<void>

/** One consistent read cut over every registered projection unit. */
export interface ProjectionSnapshot {
  /** Seq of the last event reflected by every value; -1 for an empty log. */
  asOfSeq: number
  /** Detached whole public values keyed by registered projection name. */
  values: Partial<SessionProjectionMap>
}

/** One unit's persisted cache shortcut. */
export interface ProjectionCheckpointRow {
  /** The registering unit's `stateVersion` at fold time. */
  ver: number
  /** Seq of the last event folded into `val`; -1 for the empty log. */
  seq: number
  /** Detached private state; losslessly plain JSON. */
  val: unknown
}

/** Checkpoint rows keyed by projection key. */
export type ProjectionCheckpoint = Record<string, ProjectionCheckpointRow>

/** Type-erased definition used only by registry orchestration. */
export interface ErasedDefinition {
  key: string
  definitionToken: symbol
  schema: { parse(value: unknown): unknown }
  checkpointStateSchema?: { parse(value: unknown): unknown }
  checkpointStateSeq?(state: unknown): number
  init(): unknown
  apply(state: unknown, event: SessionEvent): unknown
  view(state: unknown): unknown
  viewChanged?(previous: unknown, next: unknown): boolean
  stateVersion: number
}

/** Result of admitting one persisted unit state. */
export type CheckpointStateParse =
  | { valid: true; state: unknown }
  | { valid: false }
