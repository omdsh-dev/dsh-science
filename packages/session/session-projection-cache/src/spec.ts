/**
 * The session-projcache domain declaration: one `sessions` table keyed by
 * {@link SessionId}, each record the full projection checkpoint for one
 * session (`key → {ver, seq, val}` rows). The spec object
 * is the single source of the domain's identity, version, and record schema;
 * the storage-domain routing decides the medium (the shipped composition's
 * json backend lands it at `<root>/session_projcache.json`, beside
 * `workspace.json`).
 * @module @deepseek-ai/dsh-session-projection-cache/src/spec
 */

import { z } from 'zod'
import { SessionId, snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import type { ProjectionCheckpoint, ProjectionCheckpointRow } from '@deepseek-ai/dsh-session-projection'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** Whether a value is a JSON record whose visible properties are all own string keys. */
function isPlainStringRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Reflect.ownKeys(value).every(key => typeof key === 'string'
    && Object.prototype.propertyIsEnumerable.call(value, key))
}

/** Whether a record contains exactly the named own keys. */
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

/** Validate one row without rebuilding its arbitrary JSON state. */
function isCheckpointRow(value: unknown): value is ProjectionCheckpointRow {
  if (!isPlainStringRecord(value) || !hasExactKeys(value, ['ver', 'seq', 'val'])) return false
  return Number.isSafeInteger(value['ver']) && (value['ver'] as number) >= 0
    && Number.isSafeInteger(value['seq']) && (value['seq'] as number) >= -1
}

/**
 * One persisted checkpoint row (the RFC's `(sessionId, key, ver, seq, val)`
 * minus the two record keys). `val` is the unit's internal state — plain
 * JSON by the unit contract; one lossless snapshot enforces that boundary
 * without rebuilding or dropping arbitrary literal keys. A row is
 * non-authoritative: `seq` says how stale it is, a `ver`
 * mismatch discards it, and the live unit's optional checkpoint-state schema
 * rejects a malformed or internally inconsistent `val` at read time. None of
 * those cases migrate the row.
 */
export const checkpointRow: z.ZodType<ProjectionCheckpointRow> = z.unknown().transform((value, ctx) => {
  const snapshot = snapshotJsonValue(value)
  if (snapshot === undefined || !isCheckpointRow(snapshot)) {
    ctx.addIssue({ code: 'custom', message: 'invalid projection checkpoint row' })
    return z.NEVER
  }
  return snapshot
})

/**
 * One source-qualified persistence revision. The provider owns its opaque
 * representation; the cache only validates that durable data contains a
 * non-empty token and compares tokens for exact equality.
 */
export const checkpointRevision = z.custom<SessionPersistenceRevision>(
  value => typeof value === 'string' && value.length > 0,
)

/**
 * One session's stored record: the exact stored-log revision it was folded from plus its
 * checkpoint rows keyed by projection key. The whole record is replaced on
 * every write (whole-value discipline — the registry checkpoint is always
 * the complete per-session cut).
 */
export interface CheckpointRecord {
  /** Exact source-qualified revision folded by every row. */
  readonly revision: SessionPersistenceRevision
  /** Complete projection rows, including arbitrary literal projection keys. */
  readonly rows: ProjectionCheckpoint
}

/** Validate a whole record without reconstructing arbitrary row or state keys. */
function isCheckpointRecord(value: unknown): value is CheckpointRecord {
  if (!isPlainStringRecord(value) || !hasExactKeys(value, ['revision', 'rows'])) return false
  if (!checkpointRevision.safeParse(value['revision']).success || !isPlainStringRecord(value['rows'])) return false
  return Object.values(value['rows']).every(isCheckpointRow)
}

/**
 * Own the admitted graph with one lossless snapshot, without rebuilding away
 * a legal own `__proto__` key at any nesting level.
 */
export const checkpointRecord: z.ZodType<CheckpointRecord> = z.unknown().transform((value, ctx) => {
  const snapshot = snapshotJsonValue(value)
  if (snapshot === undefined || !isCheckpointRecord(snapshot)) {
    ctx.addIssue({ code: 'custom', message: 'invalid projection checkpoint record' })
    return z.NEVER
  }
  return snapshot
})

/**
 * The session-projcache domain spec. Version bumps discard the whole medium
 * (cache semantics: a stale or unreadable cache is discarded and may require
 * a full replay, never a wrong value from that rejected record).
 */
export const projectionCacheDomainSpec = defineDomain({
  name: 'session_projcache',
  version: 4,
  tables: { sessions: domainTable<SessionId, CheckpointRecord>(checkpointRecord) },
})
