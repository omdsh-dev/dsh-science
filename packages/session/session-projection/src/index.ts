/**
 * Service Definition and drive registry for the session-projection capability seam: the merge-extensible `SessionProjectionMap` type
 * table, the `ProjectionDefinition` state-driven computation unit contract,
 * and the `ctx.sessionProjections` registry that DRIVES every registered unit
 * forward eagerly over committed session events. Domain host plugins
 * contribute pure mathematics (init/apply/view); the framework owns the
 * subscription, the per-session watermark cache, persisted-state admission,
 * and change notification;
 * carriers consume the snapshot read face and the change feed. Neither side
 * knows the other
 * (capability-seam three-way split). Design authority: the session-projection
 * RFC (.agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.md).
 *
 * Whole-value event rule (load-bearing): a state-carrying log event MUST
 * carry the complete post-change state, never a bare delta — it keeps that
 * event's transition cheap and every served value self-describing.
 *
 * @module @deepseek-ai/dsh-session-projection
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import {
  checkpointStateMatchesSeq,
  cloneProjectionValue,
  parseCheckpointState,
  snapshotProjectionState,
  snapshotProjectionValue,
} from './checkpoint.ts'
import type {
  ErasedDefinition,
  ProjectionChangeListener,
  ProjectionCheckpoint,
  ProjectionCheckpointRow,
  ProjectionDefinition,
  ProjectionSnapshot,
} from './definition.ts'
import { addRegistration, removeRegistration } from './registration.ts'
import type { Registration, UnitCell } from './registration.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionProjections: SessionProjectionRegistry
  }
}

import type { SessionProjectionMap } from './types.ts'

/** Define one literal projection key without invoking Object.prototype setters. */
function defineProjectionEntry<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  })
}

/** Shared language symbols cannot identify one module's canonical definition. */
const wellKnownDefinitionTokens = new Set<symbol>(
  Object.getOwnPropertyNames(Symbol)
    .map(name => Reflect.get(Symbol, name) as unknown)
    .filter((value): value is symbol => typeof value === 'symbol'),
)

export type {
  ProjectionChangeListener,
  ProjectionCheckpoint,
  ProjectionCheckpointRow,
  ProjectionDefinition,
  ProjectionSnapshot,
} from './definition.ts'
export type { SessionProjectionMap } from './types.ts'

/**
 * `ctx.sessionProjections`: the projection unit table and its drive. The
 * service subscribes to `session/event` once; every committed event passes
 * every registered unit's `apply` (eager drive), and a changed public view
 * notifies the change feed with the schema-validated value.
 * Cells build lazily — a unit registered after events flowed, or a session
 * older than the registry, folds `init` over the in-memory log on first
 * touch (event or read). Registration is an effect (disposer rides the
 * calling fiber): an unloaded domain plugin's key disappears from snapshots
 * and clients read it as capability absence. Domain
 * plugins register under `ctx.inject(['sessionProjections'], …)` so headless
 * assemblies without the registry stay unaffected. Registrants sharing a key
 * are tracked by owner: only the same process-local `definitionToken` and
 * `stateVersion` may share one canonical definition and its cells, and the key
 * survives until the last owner unloads. An HMR replacement may take over only
 * while every prior owner is already unloading or disposed; a token or
 * version change rebuilds its cells from the authoritative log.
 */
export class SessionProjectionRegistry extends Service {
  private readonly registrations = new Map<string, Registration>()
  private readonly listeners = new Set<ProjectionChangeListener>()

  /**
   * Create and install the registry as `ctx.sessionProjections`.
   * @param ctx - Cordis context that owns the service.
   */
  constructor(ctx: Context) {
    super(ctx, 'sessionProjections')
    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      this.drive(session, event)
    })
  }

  /**
   * Register one domain's unit. The registration is an effect on the calling
   * context's fiber: disposing the fiber (or calling the returned disposer)
   * removes exactly that owner. Concurrent owners share only when both the
   * module-private `definitionToken` and `stateVersion` match; the first
   * definition remains canonical, so another owner cannot change a public
   * view without an event. HMR replacement is allowed only when every older
   * owner is unloading; a different definition token or state version
   * rebuilds cells from the authoritative log.
   * @param definition - key, wire and optional checkpoint schemas, pure unit functions, and stateVersion.
   * @returns the exact disposer that unregisters this unit.
   */
  register<K extends keyof SessionProjectionMap, S>(definition: ProjectionDefinition<K, S>): () => void {
    const definitionKey: unknown = definition.key
    if (typeof definitionKey !== 'string' || definitionKey.length === 0) {
      throw new Error('session projection key must be a non-empty string')
    }
    if (typeof definition.definitionToken !== 'symbol'
      || Symbol.keyFor(definition.definitionToken) !== undefined
      || wellKnownDefinitionTokens.has(definition.definitionToken)) {
      throw new Error(
        `session projection ${JSON.stringify(definition.key)} definitionToken must be a module-private Symbol(), not a global or well-known symbol`,
      )
    }
    if (!Number.isSafeInteger(definition.stateVersion) || definition.stateVersion < 0) {
      throw new Error(`session projection ${JSON.stringify(definition.key)} stateVersion must be a non-negative integer, got ${String(definition.stateVersion)}`)
    }
    const dispose = this.ctx.effect(function* (this: SessionProjectionRegistry) {
      const key = definition.key as string
      const entry = addRegistration(this.registrations, definition, this.ctx.fiber)
      yield () => {
        removeRegistration(this.registrations, key, entry)
      }
    }.bind(this), 'sessionProjections.register()')
    return () => void dispose()
  }

  /**
   * Subscribe to the change feed. The registration is an effect on the
   * calling context's fiber. Listener throws and asynchronous rejections are
   * logged and contained so one subscriber cannot starve later subscribers.
   * @param listener - called once per unit whose public view changed, per committed event.
   * @returns the exact disposer that unsubscribes.
   */
  onChanged(listener: ProjectionChangeListener): () => void {
    const dispose = this.ctx.effect(() => {
      this.listeners.add(listener)
      return () => {
        this.listeners.delete(listener)
      }
    }, 'sessionProjections.onChanged()')
    return () => void dispose()
  }

  /**
   * One consistent cut over every registered unit for one session, read from
   * the watermark cache (missing cells fold lazily over the in-memory log).
   * Fully synchronous — every value and `asOfSeq` reflect the same log
   * position. Each value passes its unit's schema before leaving.
   * @param session - the session whose projection values are read.
   * @returns the snapshot; `values` is empty when no unit is registered.
   */
  snapshot(session: Session): ProjectionSnapshot {
    const values: Record<string, unknown> = {}
    for (const registration of this.registrations.values()) {
      const def = registration.active.def
      const cell = this.cellFor(registration, session)
      defineProjectionEntry(values, def.key, snapshotProjectionValue(def, cell.state))
    }
    return { asOfSeq: session.seq - 1, values: values }
  }

  /**
   * State-level checkpoint of every registered unit for one session, read
   * from the watermark cache (missing cells fold lazily over the in-memory
   * log). This is the write side of the persisted projection cache: the
   * returned rows are the `(key → {ver, seq, val})` part of the durable
   * `(sessionId, key, ver, seq, val)`
   * rows. Every `val` is validated and copied as lossless plain JSON — never
   * the live cell reference. A non-JSON state violates the unit contract and
   * throws here; a caller reaching the live reference could otherwise corrupt
   * every subsequent snapshot and frame.
   * @param session - the session whose unit states are checkpointed.
   * @returns one row per registered key; empty when no unit is registered.
   */
  checkpoint(session: Session): ProjectionCheckpoint {
    const rows: ProjectionCheckpoint = {}
    for (const registration of this.registrations.values()) {
      const def = registration.active.def
      const cell = this.cellFor(registration, session)
      const val = snapshotProjectionState(def.key, cell.state)
      if (!checkpointStateMatchesSeq(def, val, cell.observedSeq)) {
        throw new Error(
          `session projection ${JSON.stringify(def.key)} private checkpoint watermark does not match seq ${String(cell.observedSeq)}`,
        )
      }
      defineProjectionEntry<ProjectionCheckpointRow>(rows, def.key, {
        ver: def.stateVersion,
        seq: cell.observedSeq,
        val,
      })
    }
    return rows
  }

  /**
   * The stored seq a {@link restore} tail read over `checkpoint` must start
   * at: the lowest usable watermark, one event before the first event that
   * still needs applying (a row is usable when
   * its `ver` matches the live unit's `stateVersion` and its private state
   * passes the unit's optional `checkpointStateSchema`; an absent, mismatched,
   * or rejected row pulls the floor to `0` — that key must refold the full log). The
   * one-event overlap is load-bearing: the tail then proves how far the
   * stored log still extends, so {@link restore} can detect a log that
   * shrank below a row's watermark (crash-repair truncation) instead of
   * serving the stale row as current — an empty tail read from the anchor
   * yields an end below every watermark and the restore rejects for a full
   * re-read.
   * @param checkpoint - persisted rows for one session (possibly stale or empty).
   * @returns the seq to hand the persistence `readFrom`, or `undefined`
   *   when no unit is registered (no read needed — {@link restore} would
   *   serve empty values regardless).
   */
  restoreFloor(checkpoint: ProjectionCheckpoint): number | undefined {
    let floor: number | undefined
    for (const registration of this.registrations.values()) {
      const def = registration.active.def
      const row = checkpoint[def.key]
      const versionMatches = row !== undefined && row.ver === def.stateVersion
      const parsed = versionMatches
        ? parseCheckpointState(def, row)
        : { valid: false as const }
      const need = versionMatches && parsed.valid
        ? Math.max(row.seq + 1, 0)
        : 0
      floor = floor === undefined ? need : Math.min(floor, need)
    }
    return floor === undefined ? undefined : Math.max(floor - 1, 0)
  }

  /**
   * View a checkpoint's rows without any log read: for every registered
   * unit whose row's `ver` matches and whose private state passes the unit's
   * optional `checkpointStateSchema`, serve the schema-validated `view` of
   * the parsed state; rejected, mismatched, or absent rows leave their key
   * absent (a cold or listing consumer treats it as not-yet-available and a
   * fuller read path refolds it). This is the zero-I/O rung of the read
   * ladder: it proves schema admission and optional state-to-seq consistency,
   * while semantic provenance still depends on the durable cache writer and
   * lifecycle identity that supplied the row.
   * @param checkpoint - persisted rows for one session (possibly stale or empty).
   * @returns whole values per key with a usable row; empty when none.
   */
  viewCheckpoint(checkpoint: ProjectionCheckpoint): Partial<SessionProjectionMap> {
    const values: Record<string, unknown> = {}
    for (const registration of this.registrations.values()) {
      const def = registration.active.def
      const row = checkpoint[def.key]
      if (row === undefined || row.ver !== def.stateVersion) continue
      const parsed = parseCheckpointState(def, row)
      if (!parsed.valid) continue
      defineProjectionEntry(values, def.key, snapshotProjectionValue(def, parsed.state))
    }
    return values
  }

  /**
   * Cold read: fold every registered unit over a stored log suffix, seeding
   * each from its checkpoint row when usable — the one read recipe (cached
   * state + forward tail replay + `view`) applied without a live `Session`.
   * Call with the events returned by a persistence
   * `readFrom(id, restoreFloor(checkpoint))` and that same floor as
   * `baseSeq`; the floor's one-below anchor makes the supplied end honest,
   * so a shrunk log is detected here. A row is usable iff its
   * `ver` matches the live unit's `stateVersion`, it does not predate `baseSeq`
   * (`seq >= baseSeq - 1`), it does not claim events past the supplied end
   * (`seq <= endSeq`), and its private state passes the unit's optional
   * `checkpointStateSchema`; an unusable row is discarded
   * and its key refolds from `init` — which is only sound over the full
   * log, so a discarded row with `baseSeq > 0` throws (the caller re-reads
   * from seq 0, e.g. after a crash-repair truncation shrank the log below
   * a row's watermark).
   * @param checkpoint - persisted rows for one session (possibly stale or empty).
   * @param events - the stored events with `seq >= baseSeq`, in seq order.
   * @param baseSeq - the seq `events` starts at (its first event's seq when non-empty).
   * @returns the snapshot cut at the supplied log end (`asOfSeq` is the last
   *   supplied event's seq, `baseSeq - 1` for an empty tail) plus the
   *   refreshed checkpoint rows at that cut, ready for a durable write-back.
   */
  restore(checkpoint: ProjectionCheckpoint, events: readonly SessionEvent[], baseSeq: number):
  { snapshot: ProjectionSnapshot; checkpoint: ProjectionCheckpoint } {
    const endSeq = events.at(-1)?.seq ?? baseSeq - 1
    const values: Record<string, unknown> = {}
    const refreshed: ProjectionCheckpoint = {}
    for (const registration of this.registrations.values()) {
      const def = registration.active.def
      const row = checkpoint[def.key]
      const coordinatesUsable = row !== undefined
        && row.ver === def.stateVersion
        && row.seq >= baseSeq - 1
        && row.seq <= endSeq
      const parsed = coordinatesUsable
        ? parseCheckpointState(def, row)
        : { valid: false as const }
      const usable = coordinatesUsable && parsed.valid
      if (!usable && baseSeq > 0) {
        throw new Error(
          `session projection ${JSON.stringify(def.key)} cannot restore from seq ${baseSeq}: `
          + 'its checkpoint row is missing, version-mismatched, state-invalid, or outside the supplied log interval; re-read from seq 0',
        )
      }
      let state = usable ? parsed.state : def.init()
      const from = usable ? row.seq : baseSeq - 1
      for (const event of events) {
        if (event.seq > from) state = def.apply(state, event)
      }
      const checkpointState = snapshotProjectionState(def.key, state)
      if (!checkpointStateMatchesSeq(def, checkpointState, endSeq)) {
        throw new Error(
          `session projection ${JSON.stringify(def.key)} private checkpoint watermark does not match seq ${String(endSeq)}`,
        )
      }
      defineProjectionEntry(values, def.key, snapshotProjectionValue(def, checkpointState))
      defineProjectionEntry<ProjectionCheckpointRow>(refreshed, def.key, {
        ver: def.stateVersion,
        seq: endSeq,
        val: checkpointState,
      })
    }
    return {
      snapshot: { asOfSeq: endSeq, values: values },
      checkpoint: refreshed,
    }
  }

  /** Fold one unit from init over `events`, producing a cell watermarked at the last folded event. */
  private buildCell(def: ErasedDefinition, events: readonly SessionEvent[]): UnitCell {
    let state = def.init()
    for (const event of events) state = def.apply(state, event)
    return { state, observedSeq: (events.at(-1)?.seq ?? -1) }
  }

  /** Read (or lazily build, folding the full in-memory log) one unit's cell. */
  private cellFor(registration: Registration, session: Session): UnitCell {
    let cell = registration.cells.get(session)
    if (cell === undefined) {
      cell = this.buildCell(registration.active.def, session.events)
      registration.cells.set(session, cell)
    }
    return cell
  }

  /** Eager drive: commit one event across the registry cut, then notify changed public views. */
  private drive(session: Session, event: SessionEvent): void {
    const changed: Array<{
      readonly registration: Registration
      readonly def: ErasedDefinition
      readonly previous: unknown
      readonly next: unknown
    }> = []
    for (const registration of [...this.registrations.values()]) {
      const def = registration.active.def
      let cell = registration.cells.get(session)
      let previous: unknown
      let next: unknown
      try {
        if (cell === undefined) {
          // Late build mid-stream: fold history before this event (seq = log
          // index, so the prefix slice is exact), then take the normal gate.
          cell = this.buildCell(def, session.events.slice(0, event.seq))
          registration.cells.set(session, cell)
        }
        previous = cell.state
        next = def.apply(previous, event)
      } catch (error) {
        // A failed unit cannot honestly claim this committed event. Drop its
        // cell so a later read retries from the full authoritative log, while
        // other units still receive the event.
        registration.cells.delete(session)
        this.warnUnitFailure(def.key, 'apply', event.seq, error)
        continue
      }
      // Commit the private state and watermark before any optional/public
      // notification work. A throwing predicate cannot make the fold skip a
      // committed event.
      cell.state = next
      cell.observedSeq = event.seq
      if (!Object.is(next, previous)) changed.push({ registration, def, previous, next })
    }
    // No listener can observe a half-applied registry cut: every successful
    // unit committed above before the first callback or public-view operation.
    for (const candidate of changed) {
      const { registration, def, previous, next } = candidate
      if (this.listeners.size === 0
        || this.registrations.get(def.key) !== registration
        || registration.active.def !== def
        || registration.cells.get(session)?.observedSeq !== event.seq) continue
      let publicChanged: boolean
      try {
        publicChanged = def.viewChanged?.(previous, next) ?? true
      } catch (error) {
        this.warnUnitFailure(def.key, 'viewChanged', event.seq, error)
        continue
      }
      if (!publicChanged) continue
      let value: unknown
      try {
        value = snapshotProjectionValue(def, next)
      } catch (error) {
        this.warnUnitFailure(def.key, 'view', event.seq, error)
        continue
      }
      for (const listener of [...this.listeners]) {
        try {
          const key = def.key as Extract<keyof SessionProjectionMap, string>
          const returned = listener(session, key, cloneProjectionValue(def.key, value), event.seq)
          void Promise.resolve(returned).catch((error: unknown) => {
            this.warnListenerFailure(def.key, error)
          })
        } catch (error) {
          this.warnListenerFailure(def.key, error)
        }
      }
    }
  }

  /** Report one contained change-listener failure without interrupting dispatch. */
  private warnListenerFailure(key: string, error: unknown): void {
    this.ctx.logger.warn(`session projection: onChanged listener failed for ${JSON.stringify(key)}: ${String(error)}`)
  }

  /** Report one contained unit-stage failure without starving later units. */
  private warnUnitFailure(key: string, stage: string, seq: number, error: unknown): void {
    this.ctx.logger.warn(
      `session projection: ${stage} failed for ${JSON.stringify(key)} at seq ${String(seq)}: ${String(error)}`,
    )
  }
}

export default SessionProjectionRegistry
