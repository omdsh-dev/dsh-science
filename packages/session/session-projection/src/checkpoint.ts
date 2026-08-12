/** Plain-JSON boundaries and persisted-state admission for projections. */

import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import { isDeepStrictEqual } from 'node:util'
import type {
  CheckpointStateParse,
  ErasedDefinition,
  ProjectionCheckpointRow,
} from './definition.ts'

/**
 * Validate and detach private state before it enters a checkpoint face.
 * @param key - projection key used in diagnostics.
 * @param state - unit-owned private state.
 * @returns a lossless plain-JSON copy.
 */
export function snapshotProjectionState(key: string, state: unknown): unknown {
  const value = snapshotJsonValue(state)
  if (value === undefined) {
    throw new Error(
      `session projection ${JSON.stringify(key)} checkpoint state is not losslessly JSON-serializable`,
    )
  }
  return value
}

/**
 * Validate a public view and detach it from both the unit and its schema.
 * @param def - active type-erased unit definition.
 * @param state - unit-owned private state.
 * @returns a schema-admitted lossless plain-JSON copy.
 */
export function snapshotProjectionValue(def: ErasedDefinition, state: unknown): unknown {
  const viewed = snapshotJsonValue(def.view(state))
  if (viewed === undefined) {
    throw new Error(
      `session projection ${JSON.stringify(def.key)} public value is not losslessly JSON-serializable`,
    )
  }
  const parsed = def.schema.parse(viewed)
  const value = snapshotJsonValue(parsed)
  if (value === undefined) {
    throw new Error(
      `session projection ${JSON.stringify(def.key)} public value is not losslessly JSON-serializable`,
    )
  }
  return value
}

/**
 * Make an independent listener/caller copy of an already-admitted value.
 * @param key - projection key used in the defensive diagnostic.
 * @param value - already-admitted public JSON value.
 * @returns an independent lossless plain-JSON copy.
 */
export function cloneProjectionValue(key: string, value: unknown): unknown {
  const copy = snapshotJsonValue(value)
  /* v8 ignore next -- snapshotProjectionValue already proved this JSON value */
  if (copy === undefined) throw new Error(`session projection ${JSON.stringify(key)} lost its JSON value`)
  return copy
}

/**
 * Check a domain-encoded watermark without exposing the admitted state.
 * @param def - active type-erased unit definition.
 * @param state - detached private checkpoint state.
 * @param seq - outer checkpoint-row watermark.
 * @returns whether the extractor is pure and reports exactly `seq`.
 */
export function checkpointStateMatchesSeq(
  def: ErasedDefinition,
  state: unknown,
  seq: number,
): boolean {
  if (def.checkpointStateSeq === undefined) return true
  const watermarkInput = snapshotProjectionState(def.key, state)
  const before = snapshotProjectionState(def.key, watermarkInput)
  const stateSeq = def.checkpointStateSeq(watermarkInput)
  return stateSeq === seq && isDeepStrictEqual(before, watermarkInput)
}

/**
 * Admit one untrusted persisted row. State schemas are admission-only: their
 * output must be deeply equal to the input JSON. An optional domain watermark
 * extractor additionally binds the admitted state to the row's outer seq.
 * @param def - active type-erased unit definition.
 * @param row - untrusted persisted checkpoint row.
 * @returns tagged admitted detached state or rejection.
 */
export function parseCheckpointState(
  def: ErasedDefinition,
  row: ProjectionCheckpointRow,
): CheckpointStateParse {
  try {
    const input = snapshotProjectionState(def.key, row.val)
    const parserInput = snapshotProjectionState(def.key, input)
    const parsed = def.checkpointStateSchema === undefined
      ? parserInput
      : def.checkpointStateSchema.parse(parserInput)
    const output = snapshotProjectionState(def.key, parsed)
    if (!isDeepStrictEqual(input, output)) return { valid: false }
    if (!checkpointStateMatchesSeq(def, input, row.seq)) return { valid: false }
    return { valid: true, state: input }
  } catch (_invalidPersistedProjectionState) {
    return { valid: false }
  }
}
