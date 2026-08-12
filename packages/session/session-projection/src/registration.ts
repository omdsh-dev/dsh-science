/** Owner-aware registration and HMR arbitration for projection definitions. */

import { FiberState } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ErasedDefinition } from './definition.ts'

/** Per-session private state and the last event passed through `apply`. */
export interface UnitCell {
  state: unknown
  observedSeq: number
}

/** One registrant-owned definition. */
export interface RegistrationEntry {
  readonly def: ErasedDefinition
  readonly owner: Fiber
}

/** One key's ordered owners, canonical active definition, and shared cells. */
export interface Registration {
  readonly entries: RegistrationEntry[]
  active: RegistrationEntry
  cells: WeakMap<Session, UnitCell>
}

/**
 * Add one owner. Active owners share only one explicitly tokened definition;
 * HMR takeover is allowed only after every prior owner begins unloading.
 * @param registrations - process-local key registration table.
 * @param def - incoming type-erased definition.
 * @param owner - Cordis fiber that owns the registration effect.
 * @returns the exact entry later passed to `removeRegistration`.
 */
export function addRegistration(
  registrations: Map<string, Registration>,
  def: ErasedDefinition,
  owner: Fiber,
): RegistrationEntry {
  const key = def.key
  const entry: RegistrationEntry = { def, owner }
  const existing = registrations.get(key)
  if (existing === undefined) {
    registrations.set(key, { entries: [entry], active: entry, cells: new WeakMap() })
    return entry
  }
  const versionChanged = existing.active.def.stateVersion !== def.stateVersion
  const replaceable = existing.entries.every(({ owner: priorOwner }) =>
    priorOwner.state === FiberState.UNLOADING || priorOwner.state === FiberState.DISPOSED)
  if (!replaceable) {
    const sameDefinition = existing.active.def.definitionToken === def.definitionToken
      && !versionChanged
    if (!sameDefinition) {
      throw new Error(
        `session projection key ${JSON.stringify(key)} already has an active owner; `
        + 'only the same definitionToken and stateVersion may share its cells',
      )
    }
    // Repeated composition of the same module adds ownership only. Keeping
    // the canonical definition prevents a no-event view change.
    existing.entries.push(entry)
    return entry
  }
  const definitionChanged = existing.active.def.definitionToken !== def.definitionToken
  existing.entries.push(entry)
  existing.active = entry
  // A changed definition token or version replays from the authoritative log.
  // A same-module remount may retain the token and version after every prior
  // fiber begins unloading; that canonical family can safely retain cells.
  if (versionChanged || definitionChanged) existing.cells = new WeakMap()
  return entry
}

/**
 * Remove exactly one owner and select only a still-live fallback definition.
 * @param registrations - process-local key registration table.
 * @param key - projection key owned by the entry.
 * @param entry - exact owner entry being disposed.
 */
export function removeRegistration(
  registrations: Map<string, Registration>,
  key: string,
  entry: RegistrationEntry,
): void {
  const live = registrations.get(key)
  if (live === undefined) return
  const index = live.entries.indexOf(entry)
  /* v8 ignore next -- each successful effect owns one entry and disposes once */
  if (index < 0) return
  live.entries.splice(index, 1)
  if (live.entries.length === 0) {
    registrations.delete(key)
    return
  }
  if (live.active !== entry) return
  const previous = live.entries.findLast(({ owner }) =>
    owner.state !== FiberState.UNLOADING && owner.state !== FiberState.DISPOSED)
  if (previous === undefined) {
    registrations.delete(key)
    return
  }
  const definitionChanged = previous.def.definitionToken !== entry.def.definitionToken
  const versionChanged = previous.def.stateVersion !== entry.def.stateVersion
  live.active = previous
  /* v8 ignore next -- live fallback with another token is excluded by active registration arbitration */
  if (versionChanged || definitionChanged) live.cells = new WeakMap()
}
