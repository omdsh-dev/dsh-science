/** End-to-end ordering between the live log drain and persisted projection checkpoints. */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  PersistenceCoordinator, SessionPersistenceRevision,
  type PersistenceBackend, type StoredPrefix,
} from '@deepseek-ai/dsh-session-persistence'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import SessionProjectionCache from '../src/index.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    'cache-durability/marks': { marks: string[] }
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'cache-durability/mark': { marks: string[] }
  }

  interface OutOfBandSessionEventMap {
    'cache-durability/mark': true
  }
}

type MarksState = { marks: string[] } | null

const marksUnit: ProjectionDefinition<'cache-durability/marks', MarksState> = {
  key: 'cache-durability/marks',
  definitionToken: Symbol('cache durability marks definition'),
  schema: z.object({ marks: z.array(z.string()) }),
  checkpointStateSchema: z.union([
    z.object({ marks: z.array(z.string()) }).strict(),
    z.null(),
  ]),
  init: () => null,
  apply: (state, event) => event.type === 'cache-durability/mark' ? event.data : state,
  view: state => state ?? { marks: [] },
  stateVersion: 1,
}

const lifecycleMarksUnit: ProjectionDefinition<'cache-durability/marks', MarksState> = {
  ...marksUnit,
  definitionToken: Symbol('cache durability lifecycle marks definition'),
  apply: (state, event) => event.type === 'turn/start'
    ? { marks: [`turn-${event.data.turn}`] }
    : state,
}

interface StoredSession {
  meta: SessionHeader
  events: SessionEvent[]
}

/** Gated durable medium used by a real PersistenceCoordinator. */
class GatedBackend implements PersistenceBackend<never> {
  readonly name = 'session-persistence-gated'
  readonly store = new Map<SessionId, StoredSession>()
  readonly firstAppendStarted = Promise.withResolvers<undefined>()
  readonly releaseFirstAppend = Promise.withResolvers<undefined>()
  appendAttempts = 0
  failNextAppends = 0
  beforeAppend?: (attempt: number) => Promise<void>

  constructor(private readonly gateFirstAppend = true) {}

  async loadStored(id: SessionId): Promise<StoredPrefix<never> | undefined> {
    const stored = this.store.get(id)
    if (stored === undefined) return undefined
    return {
      meta: structuredClone(stored.meta),
      events: structuredClone(stored.events),
      revision: this.revision(stored),
    }
  }

  async readStoredRevision(id: SessionId): Promise<SessionPersistenceRevision | undefined> {
    const stored = this.store.get(id)
    return stored === undefined ? undefined : this.revision(stored)
  }

  async appendBatch(meta: SessionHeader, events: readonly SessionEvent[]): Promise<SessionPersistenceRevision> {
    this.appendAttempts += 1
    this.firstAppendStarted.resolve(undefined)
    if (this.beforeAppend !== undefined) {
      await this.beforeAppend(this.appendAttempts)
    } else if (this.appendAttempts === 1 && this.gateFirstAppend) {
      await this.releaseFirstAppend.promise
    }
    if (this.failNextAppends > 0) {
      this.failNextAppends -= 1
      throw new Error('gated append failed')
    }
    const stored = this.store.get(meta.id)
    if (stored === undefined) {
      this.store.set(meta.id, {
        meta: structuredClone(meta),
        events: structuredClone(events) as SessionEvent[],
      })
      const materialized = this.store.get(meta.id)
      if (materialized === undefined) throw new Error('gated append lost its entry')
      return this.revision(materialized)
    }
    stored.events.push(...structuredClone(events) as SessionEvent[])
    return this.revision(stored)
  }

  async commitRepair(
    meta: SessionHeader,
    _marker: never,
    closers: readonly SessionEvent[],
  ): Promise<SessionPersistenceRevision> {
    const stored = this.store.get(meta.id)
    if (stored === undefined) throw new Error('gated repair lost its entry')
    stored.events.push(...structuredClone(closers) as SessionEvent[])
    return this.revision(stored)
  }

  async list(): Promise<SessionHeader[]> {
    return [...this.store.values()].map(stored => structuredClone(stored.meta))
  }

  revision(stored: StoredSession): SessionPersistenceRevision {
    return SessionPersistenceRevision(JSON.stringify(stored))
  }
}

/** Read one persisted cache row from the in-memory domain medium. */
function cachedRow(pool: MemoryMediaPool, id: SessionId) {
  const record = cachedRecord(pool, id)
  return record?.rows['cache-durability/marks']
}

/** Read one full persisted cache record from the in-memory domain medium. */
function cachedRecord(pool: MemoryMediaPool, id: SessionId) {
  return pool.media.get('session_projcache')?.tables.get('sessions')?.get(String(id)) as
    {
      revision: SessionPersistenceRevision
      rows: Record<string, { ver: number; seq: number; val: unknown }>
    } | undefined
}

/** Install the real session/persistence/projection/cache stack around a controllable backend. */
async function installHarness(
  backend: GatedBackend,
  writeIntervalMs = 250,
  unit: ProjectionDefinition<'cache-durability/marks', MarksState> = marksUnit,
) {
  const ctx = new Context()
  const pool = new MemoryMediaPool()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register(unit)
  const persistenceFiber = await ctx.plugin(Object.assign((inner: Context) => {
    const coordinator = new PersistenceCoordinator(inner, backend)
    inner.provide('sessionPersistence', {
      readFrom: (id: SessionId, fromSeq: number, signal?: AbortSignal) =>
        coordinator.readFrom(id, fromSeq, signal),
      drain: (tracked: Session) => coordinator.drain(tracked),
    } as never)
  }, { inject: ['sessions'] }))
  const cacheFiber = await ctx.plugin(SessionProjectionCache, {
    writeEveryEvents: 100,
    writeIntervalMs,
  })
  return { ctx, pool, persistenceFiber, cacheFiber }
}

/** Let promise continuations admitted by synchronous lifecycle observers settle. */
async function settleLifecycle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve()
}

describe('SessionProjectionCache durability ordering', () => {
  it('keeps a same-id successor checkpoint behind its own durable append revision', async () => {
    const backend = new GatedBackend(false)
    const firstGate = Promise.withResolvers<undefined>()
    const successorGate = Promise.withResolvers<undefined>()
    backend.beforeAppend = async (attempt) => {
      if (attempt === 1) await firstGate.promise
      if (attempt === 2) await successorGate.promise
    }
    const { ctx, pool, persistenceFiber, cacheFiber } = await installHarness(
      backend,
      60_000,
      lifecycleMarksUnit,
    )
    let firstOwner: Awaited<ReturnType<Context['plugin']>> | undefined
    let successorOwner: Awaited<ReturnType<Context['plugin']>> | undefined

    try {
      const id = SessionId('same-id-successor-cache')
      let first!: Session
      firstOwner = await ctx.plugin(Object.assign((inner: Context) => {
        first = inner.sessions.create(id)
      }, { inject: ['sessions'] }))
      first.append('turn/start', { turn: 1 })
      first.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await firstOwner.dispose()
      firstOwner = undefined
      await vi.waitFor(() => { expect(backend.appendAttempts).toBe(1) })

      let successor!: Session
      successorOwner = await ctx.plugin(Object.assign((inner: Context) => {
        successor = inner.sessions.create(id, { seed: first.events })
      }, { inject: ['sessions'] }))
      successor.append('turn/start', { turn: 2 })
      const newest = successor.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
      await successorOwner.dispose()
      successorOwner = undefined

      firstGate.resolve(undefined)
      await vi.waitFor(() => { expect(backend.appendAttempts).toBe(2) })
      const firstStored = backend.store.get(id)
      if (firstStored === undefined) throw new Error('first lifecycle was not materialized')
      const firstRevision = backend.revision(firstStored)
      expect(backend.store.get(id)?.events.map(event => event.seq)).toEqual([0, 1])
      expect(cachedRecord(pool, id)?.revision).toBe(firstRevision)
      expect(cachedRow(pool, id)?.val).toEqual({ marks: ['turn-1'] })

      successorGate.resolve(undefined)
      await vi.waitFor(() => {
        expect(backend.store.get(id)?.events.map(event => event.seq)).toEqual([0, 1, 2, 3, 4])
        expect(cachedRow(pool, id)).toEqual({
          ver: 1,
          seq: newest.seq,
          val: { marks: ['turn-2'] },
        })
      })
      const successorStored = backend.store.get(id)
      if (successorStored === undefined) throw new Error('successor lifecycle was not materialized')
      expect(cachedRecord(pool, id)?.revision).toBe(backend.revision(successorStored))
      expect(cachedRecord(pool, id)?.revision).not.toBe(firstRevision)
    } finally {
      firstGate.resolve(undefined)
      successorGate.resolve(undefined)
      await firstOwner?.dispose()
      await successorOwner?.dispose()
      await cacheFiber.dispose()
      await persistenceFiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('keeps a detach checkpoint behind the real retirement drain and finishes at the newest cut', async () => {
    const ctx = new Context()
    const pool = new MemoryMediaPool()
    const backend = new GatedBackend()
    let coordinator!: PersistenceCoordinator<never>
    let session!: Session
    let owner: Awaited<ReturnType<Context['plugin']>> | undefined
    let persistenceFiber: Awaited<ReturnType<Context['plugin']>> | undefined
    let cacheFiber: Awaited<ReturnType<Context['plugin']>> | undefined

    try {
      await ctx.plugin(Storage)
      ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
      const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
      ctx.storage.mount('domain', facility)
      ctx.provide('storageDomain', facility)
      await ctx.plugin(SessionStore)
      await ctx.plugin(SessionProjectionRegistry)
      ctx.sessionProjections.register(marksUnit)
      persistenceFiber = await ctx.plugin(Object.assign((inner: Context) => {
        coordinator = new PersistenceCoordinator(inner, backend)
        inner.provide('sessionPersistence', {
          readFrom: (id: SessionId, fromSeq: number, signal?: AbortSignal) =>
            coordinator.readFrom(id, fromSeq, signal),
          drain: (tracked: Session) => coordinator.drain(tracked),
        } as never)
      }, { inject: ['sessions'] }))
      cacheFiber = await ctx.plugin(SessionProjectionCache, {
        writeEveryEvents: 100,
        writeIntervalMs: 60_000,
      })
      owner = await ctx.plugin(Object.assign((inner: Context) => {
        session = inner.sessions.create(SessionId('real-detach-ordering'))
      }, { inject: ['sessions'] }))

      session.append('cache-durability/mark', { marks: ['old'] })
      const olderWrite = ctx.sessionProjectionCache.write(session)
      await backend.firstAppendStarted.promise
      expect(backend.store.get(session.id)).toBeUndefined()
      expect(cachedRow(pool, session.id)).toBeUndefined()

      const newest = session.append('cache-durability/mark', { marks: ['new'] })
      await owner.dispose()
      owner = undefined
      await Promise.resolve()
      expect(backend.store.get(session.id)).toBeUndefined()
      expect(cachedRow(pool, session.id)).toBeUndefined()

      backend.releaseFirstAppend.resolve(undefined)
      await olderWrite
      await vi.waitFor(() => {
        expect(backend.store.get(session.id)?.events.map(event => event.seq)).toEqual([0, 1])
        expect(cachedRow(pool, session.id)).toEqual({
          ver: 1,
          seq: newest.seq,
          val: { marks: ['new'] },
        })
      })
      await Promise.resolve()
      expect(cachedRow(pool, session.id)?.val).toEqual({ marks: ['new'] })
    } finally {
      backend.releaseFirstAppend.resolve(undefined)
      await owner?.dispose()
      await cacheFiber?.dispose()
      await persistenceFiber?.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('retries a failed real retirement on the cache interval and suppresses the shorter old cut', async () => {
    vi.useFakeTimers()
    const backend = new GatedBackend(false)
    const { ctx, pool, persistenceFiber, cacheFiber } = await installHarness(backend)
    let owner: Awaited<ReturnType<Context['plugin']>> | undefined

    try {
      let session!: Session
      owner = await ctx.plugin(Object.assign((inner: Context) => {
        session = inner.sessions.create(SessionId('retirement-interval-retry'))
      }, { inject: ['sessions'] }))
      session.append('cache-durability/mark', { marks: ['old'] })
      await ctx.sessionProjectionCache.write(session)
      const oldStored = backend.store.get(session.id)
      if (oldStored === undefined) throw new Error('baseline log was not materialized')
      const oldRevision = backend.revision(oldStored)

      backend.failNextAppends = 1
      const newest = session.append('cache-durability/mark', { marks: ['new'] })
      await owner.dispose()
      owner = undefined
      await settleLifecycle()

      expect(backend.appendAttempts).toBe(2)
      expect(backend.store.get(session.id)?.events.map(event => event.seq)).toEqual([0])
      expect(ctx.sessionProjectionCache.cachedSnapshot({
        header: structuredClone(oldStored.meta),
        revision: oldRevision,
      })).toBeUndefined()

      await vi.advanceTimersByTimeAsync(250)
      await vi.advanceTimersByTimeAsync(0)
      expect(backend.store.get(session.id)?.events.map(event => event.seq)).toEqual([0, 1])
      expect(cachedRow(pool, session.id)).toEqual({
        ver: 1,
        seq: newest.seq,
        val: { marks: ['new'] },
      })
    } finally {
      backend.releaseFirstAppend.resolve(undefined)
      await owner?.dispose()
      await cacheFiber.dispose()
      await persistenceFiber.dispose()
      await ctx.fiber.dispose()
      vi.useRealTimers()
    }
  })

  it('retries a seed-only detach cache-put failure without a later session event', async () => {
    vi.useFakeTimers()
    const backend = new GatedBackend(false)
    const { ctx, pool, persistenceFiber, cacheFiber } = await installHarness(backend)
    let owner: Awaited<ReturnType<Context['plugin']>> | undefined

    try {
      const id = SessionId('seed-only-cache-retry')
      const seed: SessionEvent[] = [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        { type: 'cache-durability/mark', seq: 1, time: 2, data: { marks: ['seeded'] } },
        { type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
      ]
      let session!: Session
      owner = await ctx.plugin(Object.assign((inner: Context) => {
        session = inner.sessions.create(id, { seed })
      }, { inject: ['sessions'] }))
      await ctx.sessions.flush(session)
      pool.failNextWrites = 1

      await owner.dispose()
      owner = undefined
      await settleLifecycle()
      expect(cachedRow(pool, id)).toBeUndefined()

      await vi.advanceTimersByTimeAsync(250)
      await vi.advanceTimersByTimeAsync(0)
      expect(backend.store.get(id)?.events.map(event => event.seq)).toEqual([0, 1, 2, 3])
      expect(cachedRow(pool, id)).toEqual({
        ver: 1,
        seq: 3,
        val: { marks: ['seeded'] },
      })
    } finally {
      backend.releaseFirstAppend.resolve(undefined)
      await owner?.dispose()
      await cacheFiber.dispose()
      await persistenceFiber.dispose()
      await ctx.fiber.dispose()
      vi.useRealTimers()
    }
  })
})
