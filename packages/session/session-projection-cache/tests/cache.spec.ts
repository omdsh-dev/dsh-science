/**
 * SessionProjectionCache behavior: mandatory-point writes (turn/end, detach),
 * count/interval throttling between them, fail-soft durability (a failed
 * write logs and stays stale, never throws into the event path), and the
 * cold-read ladder (cached row + readFrom tail + registry restore +
 * write-back; version bump and shrunk-log rows degrade to a full re-read).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import SessionProjectionCache from '../src/index.ts'
import { checkpointRecord } from '../src/spec.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    'cache-test/marks': { marks: string[] }
    'cache-test/count': number
    '__proto__': number
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'cache-test/mark': { marks: string[] }
  }

  interface OutOfBandSessionEventMap {
    'cache-test/mark': true
  }
}

type MarksState = { marks: string[] } | null
const cacheMarksDefinitionToken = Symbol('cache test marks definition')
const marksUnit = (stateVersion = 1): ProjectionDefinition<'cache-test/marks', MarksState> => ({
  key: 'cache-test/marks',
  definitionToken: cacheMarksDefinitionToken,
  schema: z.object({ marks: z.array(z.string()) }),
  checkpointStateSchema: z.union([
    z.object({ marks: z.array(z.string()) }).strict(),
    z.null(),
  ]),
  init: () => null,
  apply: (state, event) => (event.type === 'cache-test/mark' ? (event).data : state),
  view: state => state ?? { marks: [] },
  stateVersion,
})

const countUnit = (): ProjectionDefinition<'cache-test/count', number> => ({
  key: 'cache-test/count',
  definitionToken: Symbol('cache test count definition'),
  schema: z.number().int().nonnegative(),
  checkpointStateSchema: z.number().int().nonnegative(),
  init: () => 0,
  apply: state => state + 1,
  view: state => state,
  stateVersion: 1,
})

const protoUnit = (): ProjectionDefinition<'__proto__', { ['__proto__']: { safe: boolean } }> => ({
  key: '__proto__',
  definitionToken: Symbol('cache proto definition'),
  schema: z.number().int().min(0).max(1),
  checkpointStateSchema: z.custom<{ ['__proto__']: { safe: boolean } }>(
    value => typeof value === 'object' && value !== null && Object.hasOwn(value, '__proto__'),
  ),
  init: () => ({ ['__proto__']: { safe: false } }),
  apply: state => state,
  view: state => state['__proto__'].safe ? 1 : 0,
  stateVersion: 1,
})

/** Stable source-qualified revision for one fake stored log generation. */
const revisionOf = (id: string, generation = 'current') =>
  SessionPersistenceRevision(`fake-store:${id}:${generation}`)

/** A persistence double serving readFrom over a fixed per-id stored log (headers stamp createdAt 0). */
function fakePersistence(logs: Map<string, SessionEvent[]>) {
  const readFrom = vi.fn(async (id: SessionId, fromSeq: number) => {
    const events = logs.get(String(id))
    if (events === undefined) throw new Error(`session "${id}" not found`)
    return {
      meta: { version: 0, id, createdAt: 0 },
      events: events.filter(event => event.seq >= fromSeq),
      revision: revisionOf(id),
    }
  })
  const drain = vi.fn(async (session: Session) => revisionOf(session.id))
  return { readFrom, drain }
}

/** Header shape for cachedSnapshot calls (fake logs stamp createdAt 0, no cwd). */
const headerOf = (id: SessionId, createdAt = 0, cwd?: string) =>
  ({ version: 0, id, createdAt, ...cwd === undefined ? {} : { cwd } })

/** Lightweight persisted observation used by the zero-I/O cache read. */
const snapshotOf = (
  id: SessionId,
  revision = revisionOf(id),
  createdAt = 0,
  cwd?: string,
): SessionPersistenceSnapshot => ({ header: headerOf(id, createdAt, cwd), revision })

interface HarnessOptions {
  pool?: MemoryMediaPool
  config?: { writeEveryEvents: number; writeIntervalMs: number }
  stateVersion?: number
  logs?: Map<string, SessionEvent[]>
}

const contexts: Context[] = []

async function harness(options: HarnessOptions = {}) {
  const pool = options.pool ?? new MemoryMediaPool()
  const logs = options.logs ?? new Map<string, SessionEvent[]>()
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register(marksUnit(options.stateVersion))
  const persistence = fakePersistence(logs)
  ctx.provide('sessionPersistence', persistence as never)
  const fiber = await ctx.plugin(SessionProjectionCache, options.config ?? { writeEveryEvents: 100, writeIntervalMs: 60_000 })
  return { ctx, pool, logs, fiber, persistence, cache: ctx.sessionProjectionCache }
}

const mark = (session: Session, marks: string[]): SessionEvent =>
  session.append('cache-test/mark', { marks })

const endTurn = (session: Session): SessionEvent =>
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

/** The stored medium record for one session id (undefined = never written). */
function storedRecord(pool: MemoryMediaPool, id: Session['id']) {
  return pool.media.get('session_projcache')?.tables.get('sessions')?.get(String(id)) as
    {
      revision: ReturnType<typeof revisionOf>
      rows: Record<string, { ver: number; seq: number; val: unknown }>
    } | undefined
}

/** The stored medium rows for one session id (undefined = never written). */
function storedRows(pool: MemoryMediaPool, id: Session['id']) {
  return storedRecord(pool, id)?.rows
}

/** Wait until queued fail-soft writes (event-listener fire-and-forget) drain. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('SessionProjectionCache write policy', () => {
  it('writes a durable checkpoint at turn/end (mandatory point)', async () => {
    const { ctx, pool } = await harness()
    const session = ctx.sessions.create(SessionId('turn-end'))
    mark(session, ['a'])
    expect(storedRows(pool, session.id)).toBeUndefined() // throttled: no write yet
    const end = endTurn(session)
    await settle()
    const rows = storedRows(pool, session.id)
    expect(rows?.['cache-test/marks']).toEqual({ ver: 1, seq: end.seq, val: { marks: ['a'] } })
  })

  it('writes at session disposal (detach, the live-to-cold moment)', async () => {
    const { ctx, pool } = await harness()
    // Sessions dispose with their owning fiber: create in a child plugin.
    let session: Session | undefined
    const owner = await ctx.plugin(Object.assign((inner: Context) => {
      session = inner.sessions.create(SessionId('detach'))
    }, { inject: ['sessions'] }))
    if (session === undefined) throw new Error('session was not created')
    mark(session, ['live'])
    await owner.dispose()
    await settle()
    expect(storedRows(pool, session.id)?.['cache-test/marks']?.val).toEqual({ marks: ['live'] })
  })

  it('leaves a truly empty detached lifecycle absent without arming retries', async () => {
    vi.useFakeTimers()
    const { ctx, pool, persistence, cache } = await harness({
      config: { writeEveryEvents: 100, writeIntervalMs: 250 },
    })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    let session!: Session
    const owner = await ctx.plugin(Object.assign((inner: Context) => {
      session = inner.sessions.create(SessionId('empty-detach'))
    }, { inject: ['sessions'] }))

    await owner.dispose()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(persistence.drain).not.toHaveBeenCalled()
    expect(storedRows(pool, session.id)).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
    const internals = cache as unknown as {
      dirty: Map<Session, unknown>
      operations: Map<SessionId, unknown>
    }
    expect(internals.dirty.size).toBe(0)
    expect(internals.operations.size).toBe(0)
  })

  it('waits for the detached lifecycle drain before publishing its checkpoint', async () => {
    const { ctx, pool, persistence } = await harness()
    const durable = Promise.withResolvers<undefined>()
    persistence.drain.mockImplementation(async (tracked) => {
      await durable.promise
      return revisionOf(tracked.id)
    })
    let session: Session | undefined
    const owner = await ctx.plugin(Object.assign((inner: Context) => {
      session = inner.sessions.create(SessionId('detach-drain'))
    }, { inject: ['sessions'] }))
    if (session === undefined) throw new Error('session was not created')
    const detached = session
    mark(detached, ['retiring'])

    await owner.dispose()
    await vi.waitFor(() => { expect(persistence.drain).toHaveBeenCalledWith(detached) })
    expect(storedRows(pool, detached.id)).toBeUndefined()

    durable.resolve(undefined)
    await vi.waitFor(() => {
      expect(storedRows(pool, detached.id)?.['cache-test/marks']?.val).toEqual({ marks: ['retiring'] })
    })
  })

  it('serializes same-session writes so an older blocked transaction cannot replace a newer cut', async () => {
    const { ctx, pool, persistence, cache } = await harness()
    const firstDurable = Promise.withResolvers<undefined>()
    let drainAttempt = 0
    persistence.drain.mockImplementation(async (tracked) => {
      drainAttempt += 1
      if (drainAttempt === 1) await firstDurable.promise
      return revisionOf(tracked.id)
    })
    const session = ctx.sessions.create(SessionId('serialized-writes'))
    mark(session, ['old'])

    const older = cache.write(session)
    await vi.waitFor(() => { expect(persistence.drain).toHaveBeenCalledTimes(1) })
    expect(storedRows(pool, session.id)).toBeUndefined()

    const newestEvent = mark(session, ['new'])
    const newer = cache.write(session)
    await Promise.resolve()
    expect(persistence.drain).toHaveBeenCalledTimes(1)

    firstDurable.resolve(undefined)
    await Promise.all([older, newer])
    expect(persistence.drain).toHaveBeenCalledTimes(2)
    expect(storedRows(pool, session.id)?.['cache-test/marks']).toEqual({
      ver: 1,
      seq: newestEvent.seq,
      val: { marks: ['new'] },
    })
  })

  it('flushes when the in-turn event count reaches the configured threshold', async () => {
    const { ctx, pool } = await harness({ config: { writeEveryEvents: 3, writeIntervalMs: 60_000 } })
    const session = ctx.sessions.create(SessionId('count'))
    mark(session, ['1'])
    mark(session, ['2'])
    await settle()
    expect(storedRows(pool, session.id)).toBeUndefined()
    mark(session, ['3'])
    await settle()
    expect(storedRows(pool, session.id)?.['cache-test/marks']?.val).toEqual({ marks: ['3'] })
  })

  it('flushes on the configured interval when the count threshold is not reached', async () => {
    vi.useFakeTimers()
    const { ctx, pool } = await harness({ config: { writeEveryEvents: 100, writeIntervalMs: 250 } })
    const session = ctx.sessions.create(SessionId('interval'))
    mark(session, ['slow'])
    await vi.advanceTimersByTimeAsync(249)
    expect(storedRows(pool, session.id)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(storedRows(pool, session.id)?.['cache-test/marks']?.val).toEqual({ marks: ['slow'] })
  })

  it('write() checkpoints a cache-unobserved seeded session and rejects a non-JSON registry result', async () => {
    const { ctx, pool } = await harness()
    // Constructor-owned seed events do not traverse the cache event listener;
    // this fake persistence seam dates the explicit cache write for that
    // already-nonempty Session. Real lifecycle durability is covered in
    // durability.spec.ts with PersistenceCoordinator.
    const clean = ctx.sessions.create(SessionId('clean-write'), {
      seed: [
        { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
        { type: 'cache-test/mark', seq: 1, time: 1, data: { marks: ['seeded'] } },
        { type: 'turn/end', seq: 2, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
      ],
    })
    await ctx.sessionProjectionCache.write(clean)
    expect(storedRows(pool, clean.id)?.['cache-test/marks']).toEqual({
      ver: 1,
      seq: 3,
      val: { marks: ['seeded'] },
    })
    // Registry checkpoints already enforce plain JSON. Keep the cache's own
    // durable boundary fail-closed if a substituted provider violates that
    // upstream contract.
    vi.spyOn(ctx.sessionProjections, 'checkpoint').mockReturnValue({
      'cache-test/broken': { ver: 1, seq: -1, val: new Map([['key', 'value']]) },
    })
    await expect(ctx.sessionProjectionCache.write(clean)).rejects.toThrow('not losslessly JSON-serializable')
  })

  it('plugin disposal clears armed interval timers and leaves cleaned sessions alone', async () => {
    vi.useFakeTimers()
    const { ctx, pool, fiber } = await harness({ config: { writeEveryEvents: 100, writeIntervalMs: 5000 } })
    const armed = ctx.sessions.create(SessionId('armed'))
    const cleaned = ctx.sessions.create(SessionId('cleaned'))
    mark(armed, ['pending']) // timer armed, no write yet
    mark(cleaned, ['done'])
    endTurn(cleaned) // mandatory write leaves clean bookkeeping in the map
    await vi.advanceTimersByTimeAsync(0)
    await fiber.dispose()
    // The armed timer died with the plugin: advancing time writes nothing.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(storedRows(pool, armed.id)).toBeUndefined()
  })

  it('plugin disposal drains admitted cache writes before closing the domain', async () => {
    const { ctx, pool, persistence, cache, fiber } = await harness()
    const durable = Promise.withResolvers<undefined>()
    persistence.drain.mockImplementation(async (tracked) => {
      await durable.promise
      return revisionOf(tracked.id)
    })
    const session = ctx.sessions.create(SessionId('cache-dispose-drain'))
    mark(session, ['pending'])
    const write = cache.write(session)
    await vi.waitFor(() => { expect(persistence.drain).toHaveBeenCalledTimes(1) })

    let disposed = false
    const teardown = fiber.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)

    durable.resolve(undefined)
    await Promise.all([write, teardown])
    expect(storedRows(pool, session.id)?.['cache-test/marks']?.val).toEqual({ marks: ['pending'] })
  })

  it('plugin disposal stops at a repeatedly failing detached predecessor without hanging on its successor', async () => {
    const { ctx, persistence, fiber } = await harness()
    vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const id = SessionId('bounded-cache-dispose')
    let first!: Session
    const firstOwner = await ctx.plugin(Object.assign((inner: Context) => {
      first = inner.sessions.create(id)
    }, { inject: ['sessions'] }))
    mark(first, ['first'])
    persistence.drain.mockImplementation(async (tracked) => {
      if (tracked === first) throw new Error('predecessor remains unavailable')
      return revisionOf(tracked.id)
    })
    await firstOwner.dispose()
    await settle()

    let successor!: Session
    const successorOwner = await ctx.plugin(Object.assign((inner: Context) => {
      successor = inner.sessions.create(id, { seed: first.events })
    }, { inject: ['sessions'] }))
    mark(successor, ['successor'])
    await successorOwner.dispose()
    await settle()

    await expect(fiber.dispose()).resolves.toBeUndefined()
    expect(persistence.drain.mock.calls.filter(([tracked]) => tracked === first)).toHaveLength(2)
    expect(persistence.drain).not.toHaveBeenCalledWith(successor)
  })

  it('contains a durable write failure: logs a warning, event path unharmed, next write self-heals', async () => {
    const { ctx, pool } = await harness()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const session = ctx.sessions.create(SessionId('fail-soft'))
    mark(session, ['x'])
    pool.failNextWrites = 1
    endTurn(session)
    await settle()
    expect(storedRows(pool, session.id)).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('turn/end write for "fail-soft" failed'))
    // Self-heal: the next mandatory point writes the current cut.
    mark(session, ['y'])
    endTurn(session)
    await settle()
    expect(storedRows(pool, session.id)?.['cache-test/marks']?.val).toEqual({ marks: ['y'] })
  })

  it('retries a live checkpoint failure on the interval without another event', async () => {
    vi.useFakeTimers()
    const { ctx, pool } = await harness({ config: { writeEveryEvents: 100, writeIntervalMs: 250 } })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const session = ctx.sessions.create(SessionId('checkpoint-retry'))
    mark(session, ['pending'])
    const checkpoint = vi.spyOn(ctx.sessionProjections, 'checkpoint')
    checkpoint.mockImplementationOnce(() => { throw new Error('checkpoint failed once') })

    await vi.advanceTimersByTimeAsync(250)
    expect(storedRows(pool, session.id)).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('checkpoint failed once'))

    await vi.advanceTimersByTimeAsync(250)
    await vi.advanceTimersByTimeAsync(0)
    expect(storedRows(pool, session.id)?.['cache-test/marks']?.val).toEqual({ marks: ['pending'] })
    expect(checkpoint).toHaveBeenCalledTimes(2)
  })

  it('retains dirty work after failure and retries it on the next interval without a new event', async () => {
    vi.useFakeTimers()
    const { ctx, pool } = await harness({ config: { writeEveryEvents: 100, writeIntervalMs: 250 } })
    vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const session = ctx.sessions.create(SessionId('retry-dirty'))
    mark(session, ['retry'])
    pool.failNextWrites = 1
    endTurn(session)

    await vi.advanceTimersByTimeAsync(0)
    expect(storedRows(pool, session.id)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(250)
    expect(storedRows(pool, session.id)?.['cache-test/marks']?.val).toEqual({ marks: ['retry'] })
  })

  it('retries a failed turn/end write after the preceding state was already clean', async () => {
    vi.useFakeTimers()
    const { ctx, pool, cache } = await harness({ config: { writeEveryEvents: 100, writeIntervalMs: 250 } })
    vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const session = ctx.sessions.create(SessionId('clean-turn-end-retry'))
    const baseline = mark(session, ['baseline'])
    await cache.write(session)
    pool.failNextWrites = 1

    const end = endTurn(session)
    await vi.advanceTimersByTimeAsync(0)
    expect(storedRows(pool, session.id)?.['cache-test/marks']).toEqual({
      ver: 1,
      seq: baseline.seq,
      val: { marks: ['baseline'] },
    })

    await vi.advanceTimersByTimeAsync(250)
    expect(storedRows(pool, session.id)?.['cache-test/marks']).toEqual({
      ver: 1,
      seq: end.seq,
      val: { marks: ['baseline'] },
    })
  })
})

describe('SessionProjectionCache cold read', () => {
  const storedLog = (marks: string[][]): SessionEvent[] => {
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
    ]
    for (const m of marks) {
      events.push({ type: 'cache-test/mark', seq: events.length, time: events.length, data: { marks: m } })
    }
    events.push({ type: 'turn/end', seq: events.length, time: events.length, data: { turn: 1, reason: { kind: 'completed' } } })
    return events
  }

  /** Pre-seed the medium with one stored checkpoint record (before the domain opens). */
  function seedRow(
    pool: MemoryMediaPool,
    id: string,
    row: { ver: number; seq: number; val: unknown },
    revision = revisionOf(id),
  ): void {
    pool.versions.set('session_projcache', 4)
    pool.media.set('session_projcache', {
      tables: new Map([['sessions', new Map([[id, { revision, rows: { 'cache-test/marks': row } }]])]]),
      global: null,
    })
  }

  it('preserves literal __proto__ row and nested state keys through durable admission', async () => {
    const id = SessionId('literal-proto-row')
    const raw = JSON.parse(`{
      "revision":"${revisionOf(id)}",
      "rows":{"__proto__":{"ver":1,"seq":4,"val":{"__proto__":{"safe":true}}}}
    }`) as unknown
    const parsed = checkpointRecord.parse(raw)
    expect(parsed).not.toBe(raw)
    expect(Object.hasOwn(parsed.rows, '__proto__')).toBe(true)
    expect(Object.hasOwn(parsed.rows['__proto__']?.val as object, '__proto__')).toBe(true)

    const pool = new MemoryMediaPool()
    pool.versions.set('session_projcache', 4)
    pool.media.set('session_projcache', {
      tables: new Map([['sessions', new Map([[id, raw]])]]),
      global: null,
    })
    const { ctx, cache } = await harness({ pool })
    ctx.sessionProjections.register(protoUnit())
    const rawRows = (raw as { rows: Record<string, { val: Record<string, { safe: boolean }> }> }).rows
    rawRows['__proto__']!.val['__proto__']!.safe = false

    const snapshot = cache.cachedSnapshot(snapshotOf(id))
    expect(snapshot?.asOfSeq).toBe(4)
    expect(Object.hasOwn(snapshot?.values ?? {}, '__proto__')).toBe(true)
    expect(snapshot?.values['__proto__']).toBe(1)
  })

  it('snapshots durable checkpoint getters once before structural admission', () => {
    let reads = 0
    const val = Object.defineProperty({}, '__proto__', {
      enumerable: true,
      value: { safe: true },
    })
    const row = {
      ver: 1,
      seq: 0,
      get val() {
        reads += 1
        return val
      },
    }
    const parsed = checkpointRecord.parse({
      revision: revisionOf('getter-row'),
      rows: { ['__proto__']: row },
    })

    expect(reads).toBe(1)
    expect(Object.hasOwn(parsed.rows, '__proto__')).toBe(true)
    expect(Object.hasOwn(parsed.rows['__proto__']?.val as object, '__proto__')).toBe(true)
  })

  it('serializes a live checkpoint behind an older cold write-back for the same id', async () => {
    const id = SessionId('cold-live-race')
    const logs = new Map([[String(id), storedLog([['cold']])]])
    const { ctx, cache, persistence, pool } = await harness({ logs })
    const readGate = Promise.withResolvers<undefined>()
    const baseRead = persistence.readFrom.getMockImplementation()
    persistence.readFrom.mockImplementation(async (...args) => {
      await readGate.promise
      if (baseRead === undefined) throw new Error('readFrom implementation missing')
      return baseRead(...args)
    })

    const cold = cache.coldSnapshot(id)
    await vi.waitFor(() => { expect(persistence.readFrom).toHaveBeenCalledTimes(1) })
    const live = ctx.sessions.create(id)
    mark(live, ['live'])
    const liveWrite = cache.write(live)
    await Promise.resolve()
    expect(persistence.drain).not.toHaveBeenCalled()

    readGate.resolve(undefined)
    await expect(cold).resolves.toMatchObject({ values: { 'cache-test/marks': { marks: ['cold'] } } })
    await liveWrite
    expect(storedRows(pool, id)?.['cache-test/marks']?.val).toEqual({ marks: ['live'] })
  })

  it('serves a cold session from the cache row plus a bounded tail read, and writes the refresh back', async () => {
    const pool = new MemoryMediaPool()
    const logs = new Map([['cold', storedLog([['a'], ['a', 'b']])]])
    // A warm-era checkpoint at watermark 1 (only ['a'] folded).
    seedRow(pool, 'cold', { ver: 1, seq: 1, val: { marks: ['a'] } })
    const { cache, persistence, pool: samePool } = await harness({ pool, logs })
    const id = SessionId('cold')
    const snapshot = await cache.coldSnapshot(id)
    expect(snapshot.values['cache-test/marks']).toEqual({ marks: ['a', 'b'] })
    expect(snapshot.asOfSeq).toBe(3)
    // The tail read was bounded by the anchored floor (watermark 1 -> floor 1), not 0.
    expect(persistence.readFrom).toHaveBeenCalledWith(id, 1, undefined)
    // Write-back: the stored row advanced to the served cut.
    expect(storedRows(samePool, id)?.['cache-test/marks'])
      .toEqual({ ver: 1, seq: 3, val: { marks: ['a', 'b'] } })
  })

  it('discards a version-mismatched row and refolds the full log', async () => {
    const pool = new MemoryMediaPool()
    const logs = new Map([['bumped', storedLog([['a']])]])
    seedRow(pool, 'bumped', { ver: 1, seq: 2, val: { marks: ['stale'] } })
    const { cache, persistence } = await harness({ pool, logs, stateVersion: 2 })
    const snapshot = await cache.coldSnapshot(SessionId('bumped'))
    expect(snapshot.values['cache-test/marks']).toEqual({ marks: ['a'] })
    // Mismatch pulls the floor to 0: one full read, no second pass needed.
    expect(persistence.readFrom).toHaveBeenCalledTimes(1)
    expect(persistence.readFrom).toHaveBeenCalledWith(SessionId('bumped'), 0, undefined)
  })

  it('omits a state-invalid listing row and refolds the full log on cold read', async () => {
    const pool = new MemoryMediaPool()
    const logs = new Map([['invalid-state', storedLog([['real']])]])
    seedRow(pool, 'invalid-state', { ver: 1, seq: 2, val: { marks: [1] } })
    const { cache, persistence } = await harness({ pool, logs })
    const id = SessionId('invalid-state')

    expect(cache.cachedSnapshot(snapshotOf(id))).toBeUndefined()
    const snapshot = await cache.coldSnapshot(id)
    expect(snapshot.values['cache-test/marks']).toEqual({ marks: ['real'] })
    expect(persistence.readFrom).toHaveBeenCalledTimes(1)
    expect(persistence.readFrom).toHaveBeenCalledWith(id, 0, undefined)
  })

  it('detects a log shrunk below the row watermark and degrades to one full re-read', async () => {
    const pool = new MemoryMediaPool()
    const logs = new Map([['shrunk', storedLog([['a']])]]) // seqs 0..2
    seedRow(pool, 'shrunk', { ver: 1, seq: 9, val: { marks: ['ghost'] } })
    const { cache, persistence } = await harness({ pool, logs })
    const snapshot = await cache.coldSnapshot(SessionId('shrunk'))
    expect(snapshot.values['cache-test/marks']).toEqual({ marks: ['a'] })
    expect(snapshot.asOfSeq).toBe(2)
    // Anchored tail read (floor 9) came back empty -> full re-read from 0.
    expect(persistence.readFrom).toHaveBeenNthCalledWith(1, SessionId('shrunk'), 9, undefined)
    expect(persistence.readFrom).toHaveBeenNthCalledWith(2, SessionId('shrunk'), 0, undefined)
  })

  it('write-back failure is contained: the snapshot is still served', async () => {
    const pool = new MemoryMediaPool()
    const logs = new Map([['soft', storedLog([['a']])]])
    const { ctx, cache } = await harness({ pool, logs })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    pool.failNextWrites = 1
    const snapshot = await cache.coldSnapshot(SessionId('soft'))
    expect(snapshot.values['cache-test/marks']).toEqual({ marks: ['a'] })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cold-read write-back for "soft" failed'))
  })

  it('rejects for a session with no persisted log', async () => {
    const { cache } = await harness()
    await expect(cache.coldSnapshot(SessionId('absent'))).rejects.toThrow('not found')
  })

  it('discards a record bound to a different source-qualified revision and refolds the actual log', async () => {
    const pool = new MemoryMediaPool()
    const id = SessionId('reborn')
    const logs = new Map([[String(id), storedLog([['real']])]])
    seedRow(pool, id, { ver: 1, seq: 2, val: { marks: ['phantom'] } }, revisionOf(id, 'other-source'))
    const { cache, persistence, pool: samePool } = await harness({ pool, logs })
    const snapshot = await cache.coldSnapshot(id)
    expect(snapshot.values['cache-test/marks']).toEqual({ marks: ['real'] })
    expect(persistence.readFrom).toHaveBeenNthCalledWith(1, id, 2, undefined)
    expect(persistence.readFrom).toHaveBeenNthCalledWith(2, id, 0, undefined)
    expect(storedRecord(samePool, id)?.revision).toBe(revisionOf(id))
  })

  it('binds fallback write-back to the full read that supplied the restored events', async () => {
    const pool = new MemoryMediaPool()
    const id = SessionId('swapped-during-read')
    const oldRevision = revisionOf(id, 'old-source')
    const newRevision = revisionOf(id, 'new-source')
    seedRow(pool, String(id), { ver: 1, seq: 9, val: { marks: ['old'] } }, oldRevision)
    const { cache, persistence, pool: samePool } = await harness({ pool })
    persistence.readFrom
      .mockImplementationOnce(async () => ({
        meta: { version: 0, id, createdAt: 10 },
        events: [],
        revision: oldRevision,
      }))
      .mockImplementationOnce(async () => ({
        meta: { version: 0, id, createdAt: 20 },
        events: storedLog([['new-lifecycle']]),
        revision: newRevision,
      }))

    const snapshot = await cache.coldSnapshot(id)

    expect(snapshot.values['cache-test/marks']).toEqual({ marks: ['new-lifecycle'] })
    expect(persistence.readFrom).toHaveBeenNthCalledWith(1, id, 9, undefined)
    expect(persistence.readFrom).toHaveBeenNthCalledWith(2, id, 0, undefined)
    expect(storedRecord(samePool, id)?.revision).toBe(newRevision)
  })

  it('cachedSnapshot returns undefined when every stored row is version-mismatched', async () => {
    const pool = new MemoryMediaPool()
    seedRow(pool, 'all-stale', { ver: 99, seq: 4, val: { marks: ['old'] } })
    const { cache } = await harness({ pool })
    expect(cache.cachedSnapshot(snapshotOf(SessionId('all-stale')))).toBeUndefined()
  })

  it('does not let identical createdAt and cwd collide across persistence revisions', async () => {
    const pool = new MemoryMediaPool()
    const id = SessionId('homed')
    seedRow(pool, id, { ver: 1, seq: 2, val: { marks: ['w'] } })
    const { cache } = await harness({ pool })
    expect(cache.cachedSnapshot(snapshotOf(id, revisionOf(id), 0, '/work'))?.values['cache-test/marks'])
      .toEqual({ marks: ['w'] })
    expect(cache.cachedSnapshot(snapshotOf(id, revisionOf(id, 'other-store'), 0, '/work'))).toBeUndefined()
  })

  it('dates an empty stored log at -1 in the zero-units topology', async () => {
    const pool = new MemoryMediaPool()
    const logs = new Map([['empty', [] as SessionEvent[]]])
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
    const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    ctx.provide('sessionPersistence', fakePersistence(logs) as never)
    await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 100, writeIntervalMs: 60_000 })
    await expect(ctx.sessionProjectionCache.coldSnapshot(SessionId('empty')))
      .resolves.toEqual({ asOfSeq: -1, values: {} })
  })

  it('cachedSnapshot serves revision-matching rows with the cut watermark and refuses unrelated ones', async () => {
    const pool = new MemoryMediaPool()
    seedRow(pool, 'listed', { ver: 1, seq: 4, val: { marks: ['t'] } })
    const { cache } = await harness({ pool })
    const id = SessionId('listed')
    expect(cache.cachedSnapshot(snapshotOf(id))).toEqual({ asOfSeq: 4, values: { 'cache-test/marks': { marks: ['t'] } } })
    expect(cache.cachedSnapshot(snapshotOf(id, revisionOf(id, 'replacement')))).toBeUndefined()
    // Unknown id: no block.
    expect(cache.cachedSnapshot(snapshotOf(SessionId('never-cached')))).toBeUndefined()
  })

  it('cachedSnapshot rejects admitted rows that do not form one exact watermark cut', async () => {
    const pool = new MemoryMediaPool()
    const id = SessionId('mixed-watermarks')
    pool.versions.set('session_projcache', 4)
    pool.media.set('session_projcache', {
      tables: new Map([['sessions', new Map([[id, {
        revision: revisionOf(id),
        rows: {
          'cache-test/marks': { ver: 1, seq: 4, val: { marks: ['newer'] } },
          'cache-test/count': { ver: 1, seq: 2, val: 3 },
        },
      }]])]]),
      global: null,
    })
    const { ctx, cache } = await harness({ pool })
    ctx.sessionProjections.register(countUnit())

    expect(cache.cachedSnapshot(snapshotOf(id))).toBeUndefined()
  })

  it('holds the not-found contract with zero registered units, and dates the empty cut for a present log', async () => {
    // Same composition minus any registered unit: restoreFloor is undefined,
    // yet coldSnapshot must still reject for an absent log (probe read) and
    // serve an empty cut at the stored end for a present one.
    const pool = new MemoryMediaPool()
    const logs = new Map([['bare', storedLog([['a']])]]) // seqs 0..2
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
    const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    ctx.provide('sessionPersistence', fakePersistence(logs) as never)
    await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 100, writeIntervalMs: 60_000 })
    await expect(ctx.sessionProjectionCache.coldSnapshot(SessionId('absent'))).rejects.toThrow('not found')
    await expect(ctx.sessionProjectionCache.coldSnapshot(SessionId('bare')))
      .resolves.toEqual({ asOfSeq: 2, values: {} })
  })
})
