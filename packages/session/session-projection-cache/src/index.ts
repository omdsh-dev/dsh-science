/**
 * Persisted projection cache (`ctx.sessionProjectionCache`): durable
 * checkpoints of every registered projection unit's state, one record per
 * session on the domain data form (`session_projcache` domain — the shipped
 * json backend lands it beside `workspace.json`). The cache is a fold
 * shortcut, never an authority: a row may be stale (its `seq` says how
 * stale), version-incompatible, or rejected by its unit's checkpoint-state
 * schema, so every automatic write path is fail-soft (a lost write becomes a
 * cache miss and full replay once the durable log revision changes) and a
 * `ver` mismatch discards the row instead of migrating it. Design
 * authority: the session-projection RFC
 * (.agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.md).
 * @module @deepseek-ai/dsh-session-projection-cache
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {
  SessionPersistenceRevision,
  SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import type { ProjectionCheckpoint, ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { projectionCacheDomainSpec } from './spec.ts'
import type { CheckpointRecord } from './spec.ts'

export { checkpointRecord, checkpointRevision, checkpointRow, projectionCacheDomainSpec } from './spec.ts'
export type { CheckpointRecord } from './spec.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionProjectionCache: SessionProjectionCache
  }
}

/**
 * Plugin config. Both throttle triggers are deployment choices with no
 * universally correct value, so the composition states them explicitly
 * (cordis.yml); the two mandatory write points (`turn/end` and session
 * disposal) are policy, not tunables, and always fire.
 */
export interface Config {
  /** Committed events per session that force a durable checkpoint write between mandatory points. */
  writeEveryEvents: number
  /** Longest time (milliseconds) a dirty checkpoint may stay unwritten between mandatory points. */
  writeIntervalMs: number
}

export const Config: z<Config> = z.object({
  writeEveryEvents: z.natural().min(1).required(),
  writeIntervalMs: z.natural().min(1).required(),
})

/** Per-session write-behind bookkeeping, retained through detached retries. */
interface DirtyState {
  /** Committed events not yet covered by a successful cache write. */
  pending: number
  /** Interval trigger armed while this state remains dirty. */
  timer: ReturnType<typeof setTimeout> | undefined
  /** Whether the exact Session has detached and must retain retry ownership. */
  detached: boolean
}

/**
 * The persisted projection cache service. Opens the `session_projcache`
 * domain at init, checkpoints live sessions on a throttled write-behind
 * (count/interval triggers from {@link Config}) plus two mandatory points —
 * `turn/end` and session disposal (the live-to-cold moment) — and serves the
 * cold-read ladder: cached row, persistence `readFrom` tail, registry
 * `restore`, durable write-back. Automatic writes are fail-soft: failures log
 * a warning; a live dirty session retries on its interval or next mandatory
 * point, while a failed detach retains its exact lifecycle for interval and
 * cold-read retries.
 */
export class SessionProjectionCache extends Service {
  static inject = ['storageDomain', 'sessionProjections', 'sessionPersistence', 'sessions']

  static Config: z<Config> = Config

  private table?: KvTable<SessionId, CheckpointRecord>
  private readonly dirty = new Map<Session, DirtyState>()
  /** Exact detached lifecycles whose log/cache write still needs proof. */
  private readonly detached = new Map<SessionId, Set<Session>>()
  /** Per-id tails serialize every cache operation across lifecycle replacement. */
  private readonly operations = new Map<SessionId, Promise<unknown>>()

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'sessionProjectionCache')
  }

  /** Open the domain and install the write-behind listeners. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(projectionCacheDomainSpec)
    this.table = domain.table('sessions')
    const stopWritePath = this.installWritePath()
    // One disposer makes teardown ordering explicit: close admission and
    // timers, drain admitted operations, then close their storage domain.
    this.ctx.effect(() => async () => {
      stopWritePath()
      for (const state of this.dirty.values()) {
        if (state.timer !== undefined) {
          clearTimeout(state.timer)
          state.timer = undefined
        }
      }
      // Retry detached lifecycle heads before discarding timers. Success lets
      // queued successors advance; failure ends that id's fail-soft shutdown
      // pass without waiting forever on its pending persistence predecessor.
      for (const sessions of this.detached.values()) {
        for (const session of [...sessions]) {
          if (this.detached.get(session.id)?.values().next().value !== session) break
          await this.flushSoft(session, 'teardown')
        }
      }
      for (const state of this.dirty.values()) {
        if (state.timer !== undefined) clearTimeout(state.timer)
      }
      this.dirty.clear()
      this.detached.clear()
      await Promise.allSettled([...this.operations.values()])
      await domain.close()
    }, 'sessionProjectionCache.lifecycle')
  }

  /**
   * The stored record for one session, accepted only when its source-qualified
   * log revision exactly matches `expected`.
   * Synchronous from the domain's in-memory state.
   * @param id - the session whose record is read.
   * @param expected - the persistence revision observed by the caller.
   * @returns the revision-matching record, or `undefined` (absent or unrelated).
   */
  private recordFor(id: SessionId, expected: SessionPersistenceRevision): CheckpointRecord | undefined {
    const record = this.requireTable().get(id)
    if (record === undefined) return undefined
    return record.revision === expected ? record : undefined
  }

  /**
   * The zero-I/O listing read: whole values viewed straight from the stored
   * rows (version- and checkpoint-schema-matching keys only). Every served
   * row must share one watermark so a client value store can seed the exact
   * cut under its higher-seq-wins rule — as stale as the last durable
   * checkpoint but never from an unrelated source or log revision (the
   * caller's persistence snapshot is the witness). Fresher
   * paths (the history tail baseline, {@link coldSnapshot}) supersede these
   * values whenever a session is actually opened.
   * @param persisted - the listed session header and revision (no log read).
   * @returns the exact cut, or `undefined` when no usable row exists for this
   *   lifecycle or its admitted rows do not share one watermark.
   */
  cachedSnapshot(persisted: SessionPersistenceSnapshot): ProjectionSnapshot | undefined {
    if (this.detached.has(persisted.header.id)) return undefined
    const record = this.recordFor(persisted.header.id, persisted.revision)
    if (record === undefined) return undefined
    const values = this.ctx.sessionProjections.viewCheckpoint(record.rows)
    const keys = Object.keys(values)
    if (keys.length === 0) return undefined
    const watermarks = keys.map(key => (record.rows[key] as { seq: number }).seq)
    const asOfSeq = watermarks[0]
    /* v8 ignore next -- keys.length above proves one admitted row */
    if (asOfSeq === undefined) return undefined
    if (watermarks.some(seq => seq !== asOfSeq)) return undefined
    return { asOfSeq, values }
  }

  /**
   * Durably checkpoint one live or retiring session (both mandatory points
   * call this; tests and carriers may too). Transactions for one session id
   * are serialized. Each transaction snapshots the registry only after its
   * predecessor settles, waits for the exact Session lifecycle's log drain,
   * then replaces the whole record. NOT fail-soft — callers on the fail-soft
   * paths contain it.
   * @param session - the live session to checkpoint.
   * @returns resolution after log durability and cache replacement.
   */
  write(session: Session): Promise<void> {
    return this.serialize(session.id, () => this.writeNow(session))
  }

  /** Execute one serialized checkpoint transaction for an exact Session lifecycle. */
  private async writeNow(session: Session): Promise<void> {
    let includedDirtyEvents = 0
    try {
      const rows = this.ctx.sessionProjections.checkpoint(session)
      includedDirtyEvents = this.beginWrite(session)
      // The exact-lifecycle barrier remains valid after SessionStore detach.
      // The log may advance beyond this cut while the barrier runs, which only
      // leaves the cache safely behind it.
      const revision = await this.ctx.sessionPersistence.drain(session)
      await this.put(session.id, revision, rows)
      this.markClean(session, includedDirtyEvents)
    } catch (error: unknown) {
      this.armTimer(session)
      throw error
    }
  }

  /**
   * Cold-read one persisted session's projections: cached rows plus a
   * persistence `readFrom` tail from the registry's restore floor, refolded
   * by the registry and written back (fail-soft). The rows seed that fold only
   * when their source-qualified revision equals the tail read's revision. A
   * revision mismatch, shrunk log, or unit-owned state rejection triggers one
   * full re-read from seq 0 — the
   * ladder's slow rung, still no crash. Rejects when the session has no
   * persisted log (`not found` from the persistence seam).
   * @param id - the persisted session to read.
   * @param signal - optional cancellation for the persistence reads.
   * @returns the snapshot cut at the stored log end, serialized with cache writes for this id.
   */
  coldSnapshot(id: SessionId, signal?: AbortSignal): Promise<ProjectionSnapshot> {
    return this.serialize(id, () => this.coldSnapshotNow(id, signal))
  }

  /** Run one cold-read ladder inside the id's cache-operation serialization. */
  private async coldSnapshotNow(id: SessionId, signal?: AbortSignal): Promise<ProjectionSnapshot> {
    const detached = [...(this.detached.get(id) ?? [])]
    const record = this.requireTable().get(id)
    const cached = record?.rows ?? {}
    const floor = this.ctx.sessionProjections.restoreFloor(cached)
    const persistence = this.ctx.sessionPersistence
    // A failed automatic retirement can leave the durable log behind the
    // detached Session. Prove every retained lifecycle durable before a cold
    // read is allowed to observe the id.
    for (const session of detached) await persistence.drain(session)
    if (floor === undefined) {
      // No unit registered: nothing to fold, but the not-found contract must
      // hold in this topology too — the probe read rejects for an absent log
      // and dates the empty cut for a present one.
      const probe = await persistence.readFrom(id, 0, signal)
      for (const session of detached) this.dropDirty(session)
      return { asOfSeq: probe.events.at(-1)?.seq ?? -1, values: {} }
    }
    let restored: { snapshot: ProjectionSnapshot; checkpoint: ProjectionCheckpoint }
    const tail = await persistence.readFrom(id, floor, signal)
    let restoredRevision = tail.revision
    // An opaque revision proves equality, not ancestry. A changed revision
    // therefore invalidates the cached prefix and requires an authoritative
    // read from seq 0 before any row can seed a fold.
    const related = record === undefined || record.revision === tail.revision
    try {
      if (!related) throw new Error('unrelated log identity')
      restored = this.ctx.sessionProjections.restore(cached, tail.events, floor)
    } catch {
      // Recoverable restore failures include an unrelated record, an invalid
      // private row, and a row overreaching the stored log end (or predating
      // the floor). The full log is a fresh authoritative read.
      const whole = await persistence.readFrom(id, 0, signal)
      restored = this.ctx.sessionProjections.restore({}, whole.events, 0)
      restoredRevision = whole.revision
    }
    const stored = await this.putSoft(id, restoredRevision, restored.checkpoint, 'cold-read write-back')
    if (stored) {
      for (const session of detached) this.dropDirty(session)
    }
    return restored.snapshot
  }

  // --- write-behind (throttle + mandatory points) ---

  private installWritePath(): () => void {
    // Every committed event advances the dirty counter; turn/end is a
    // mandatory point (the durable value most reads want is the turn-final
    // one), count/interval throttle the in-turn stream.
    const stopEvents = this.ctx.on('session/event', (session: Session, event: SessionEvent) => {
      if (event.type === 'turn/end') {
        this.markDirty(session)
        void this.flushSoft(session, 'turn/end')
        return
      }
      const state = this.markDirty(session)
      if (state.pending >= this.config.writeEveryEvents && !this.operations.has(session.id)) {
        void this.flushSoft(session, 'count threshold')
        return
      }
      this.armTimer(session)
    })

    // Detach (the live-to-cold moment): the second mandatory point. After
    // this write the cold-read ladder serves the session from the cache.
    // Detach contributes its own retry token even when the Session had no
    // cache-observed live event or its preceding checkpoint was already clean.
    // The exact Session remains retained until log drain and cache put succeed.
    const stopDisposals = this.ctx.on('session/disposed', (session: Session) => {
      // A truly empty lifecycle has no materialized persistence revision to
      // bind. Lazy persistence intentionally leaves it absent.
      if (session.events.length === 0) {
        this.dropDirty(session)
        return
      }
      this.markDirty(session).detached = true
      const sessions = this.detached.get(session.id) ?? new Set<Session>()
      sessions.add(session)
      this.detached.set(session.id, sessions)
      void this.flushSoft(session, 'detach')
    })
    return () => {
      stopEvents()
      stopDisposals()
    }
  }

  /**
   * One fail-soft automatic checkpoint. Every caller has work by construction:
   * the throttle triggers only fire dirty and the two mandatory points write
   * unconditionally. A live failure retains dirtiness for an interval retry;
   * a detached failure retains the exact Session for interval or cold-read retry.
   */
  private async flushSoft(session: Session, trigger: string): Promise<void> {
    const admitted = this.dirty.get(session)
    if (admitted === undefined || admitted.pending === 0) return
    try {
      await this.serialize(session.id, async () => {
        // A cold repair or successful preceding write may have retired this
        // exact automatic attempt while it waited behind another id operation.
        if (this.dirty.get(session) !== admitted || admitted.pending === 0) return
        const detachedHead = this.detached.get(session.id)?.values().next().value
        if (detachedHead !== undefined && detachedHead !== session) {
          this.armTimer(session)
          return
        }
        await this.writeNow(session)
      })
    } catch (error) {
      this.ctx.logger.warn(`session projection cache: ${trigger} write for "${session.id}" failed (cache stays stale): ${String(error)}`)
    }
  }

  /** Count one committed event so a failed write retains retryable work. */
  private markDirty(session: Session): DirtyState {
    const state = this.dirty.get(session) ?? { pending: 0, timer: undefined, detached: false }
    this.dirty.set(session, state)
    state.pending += 1
    return state
  }

  /** Capture dirty work in this cut and cancel its superseded interval trigger. */
  private beginWrite(session: Session): number {
    const state = this.dirty.get(session)
    if (state === undefined) return 0
    if (state.timer !== undefined) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
    return state.pending
  }

  /** Mark only events included by a successful cut clean; later events remain dirty. */
  private markClean(session: Session, includedDirtyEvents: number): void {
    const state = this.dirty.get(session)
    if (state === undefined) return
    state.pending = Math.max(0, state.pending - includedDirtyEvents)
    if (state.pending === 0) {
      if (state.detached) {
        this.dropDirty(session)
      } else {
        if (state.timer !== undefined) clearTimeout(state.timer)
        state.timer = undefined
      }
      return
    }
    this.armTimer(session)
  }

  /** Arm one interval retry for a dirty live session. */
  private armTimer(session: Session): void {
    const state = this.dirty.get(session)
    if (state === undefined || state.pending === 0 || state.timer !== undefined) return
    state.timer = setTimeout(() => {
      state.timer = undefined
      void this.flushSoft(session, 'interval')
    }, this.config.writeIntervalMs)
  }

  /** Remove one lifecycle's completed retry bookkeeping. */
  private dropDirty(session: Session): void {
    const state = this.dirty.get(session)
    if (state?.timer !== undefined) clearTimeout(state.timer)
    this.dirty.delete(session)
    const detached = this.detached.get(session.id)
    if (detached !== undefined) {
      detached.delete(session)
      if (detached.size === 0) this.detached.delete(session.id)
    }
  }

  /** Replace one session's record with its observed log revision and a detached snapshot of `rows`. */
  private async put(id: SessionId, revision: SessionPersistenceRevision, rows: ProjectionCheckpoint): Promise<void> {
    const detached = snapshotJsonValue(rows)
    if (detached === undefined) {
      throw new TypeError('projection checkpoint is not losslessly JSON-serializable (a unit state violates the plain-JSON contract)')
    }
    await this.requireTable().put(id, { revision, rows: detached })
  }

  /** Fail-soft {@link put}: return whether the derived row became durable. */
  private async putSoft(
    id: SessionId,
    revision: SessionPersistenceRevision,
    rows: ProjectionCheckpoint,
    what: string,
  ): Promise<boolean> {
    try {
      await this.put(id, revision, rows)
      return true
    } catch (error) {
      this.ctx.logger.warn(`session projection cache: ${what} for "${id}" failed (cache stays stale): ${String(error)}`)
      return false
    }
  }

  /** Serialize one cache operation after the prior operation for the same session id. */
  private serialize<T>(id: SessionId, operation: () => Promise<T>): Promise<T> {
    const prior = this.operations.get(id)
    const current = prior === undefined
      ? operation()
      : prior.catch(() => {}).then(operation)
    this.operations.set(id, current)
    return current.finally(() => {
      if (this.operations.get(id) === current) this.operations.delete(id)
    })
  }

  private requireTable(): KvTable<SessionId, CheckpointRecord> {
    /* v8 ignore next -- Service.init assigns the table before the service becomes injectable */
    if (this.table === undefined) throw new Error('session projection cache is not initialized')
    return this.table
  }
}

export default SessionProjectionCache
