/**
 * SessionProjectionRegistry unit drive: eager apply on committed events with
 * lazy cell build (registration after events, session after registration),
 * the Object.is no-change gate (same reference ⇒ zero change-feed work),
 * snapshot consistency (asOfSeq = last event seq; values from the watermark
 * cache), same-version shared registration, stateVersion validation, and
 * effect-tied removal of registrations and change listeners (HMR safety).
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    'test/marks': { marks: string[] }
    'test/count': number
    '__proto__': number
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'test/mark': { marks: string[] }
    'test/evidence': Record<string, never>
  }
}

/** Whole-value unit: latest test/mark event wins; unrelated events return the same reference. */
type MarksState = { marks: string[] } | null
const marksDefinitionToken = Symbol('test marks definition')
const marksUnit = (): ProjectionDefinition<'test/marks', MarksState> => ({
  key: 'test/marks',
  definitionToken: marksDefinitionToken,
  schema: z.object({ marks: z.array(z.string()) }),
  checkpointStateSchema: z.union([
    z.object({ marks: z.array(z.string()) }).strict(),
    z.null(),
  ]),
  init: () => null,
  apply: (state, event) => (event.type === 'test/mark' ? (event).data : state),
  view: state => state ?? { marks: [] },
  stateVersion: 1,
})

/** Counting unit over every event — state changes on each apply. */
const countDefinitionToken = Symbol('test count definition')
const countUnit = (): ProjectionDefinition<'test/count', number> => ({
  key: 'test/count',
  definitionToken: countDefinitionToken,
  schema: z.number().int().nonnegative(),
  init: () => 0,
  apply: state => state + 1,
  view: state => state,
  stateVersion: 1,
})

const protoDefinitionToken = Symbol('test literal proto definition')
const protoUnit = (): ProjectionDefinition<'__proto__', number> => ({
  key: '__proto__',
  definitionToken: protoDefinitionToken,
  schema: z.number().int().nonnegative(),
  init: () => 0,
  apply: state => state + 1,
  view: state => state,
  stateVersion: 1,
})

/** Unit whose private evidence changes more often than its public count. */
type EvidenceCountState = { value: number; evidence: number }
const evidenceCountUnit = (): ProjectionDefinition<'test/count', EvidenceCountState> => ({
  key: 'test/count',
  definitionToken: Symbol('test evidence count definition'),
  schema: z.number().int().nonnegative(),
  init: () => ({ value: 0, evidence: 0 }),
  apply: (state, event) => {
    if (event.type === 'test/evidence') return { ...state, evidence: state.evidence + 1 }
    if (event.type === 'test/mark') return { ...state, value: event.data.marks.length }
    return state
  },
  view: state => state.value,
  viewChanged: (previous, next) => previous.value !== next.value,
  stateVersion: 1,
})

async function harness(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  return { ctx, session: ctx.sessions.create() }
}

const mark = (session: Session, marks: string[]): SessionEvent =>
  session.append('test/mark', { marks })

describe('SessionProjectionRegistry drive', () => {
  it('preserves a literal __proto__ key across every public and checkpoint face', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(protoUnit())
    mark(session, ['committed'])

    const snapshot = ctx.sessionProjections.snapshot(session)
    const checkpoint = ctx.sessionProjections.checkpoint(session)
    const viewed = ctx.sessionProjections.viewCheckpoint(checkpoint)
    const restored = ctx.sessionProjections.restore(checkpoint, [], session.seq)

    for (const record of [snapshot.values, checkpoint, viewed, restored.snapshot.values, restored.checkpoint]) {
      expect(Object.prototype.hasOwnProperty.call(record, '__proto__')).toBe(true)
    }
    expect(snapshot.values.__proto__).toBe(1)
    expect(checkpoint.__proto__).toEqual({ ver: 1, seq: 0, val: 1 })
    expect(viewed.__proto__).toBe(1)
    expect(restored.snapshot.values.__proto__).toBe(1)
    expect(restored.checkpoint.__proto__).toEqual({ ver: 1, seq: 0, val: 1 })
  })

  it('drives a registered unit over committed events and snapshots the current value', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(marksUnit())
    mark(session, ['a'])
    mark(session, ['a', 'b'])
    const snapshot = ctx.sessionProjections.snapshot(session)
    expect(snapshot.values['test/marks']).toEqual({ marks: ['a', 'b'] })
    expect(snapshot.asOfSeq).toBe(session.seq - 1)
  })

  it('builds the cell lazily from the full log for a unit registered after events flowed', async () => {
    const { ctx, session } = await harness()
    mark(session, ['pre-registration'])
    ctx.sessionProjections.register(marksUnit())
    expect(ctx.sessionProjections.snapshot(session).values['test/marks']).toEqual({ marks: ['pre-registration'] })
    // The lazily-built cell then continues on the live drive path.
    mark(session, ['after'])
    expect(ctx.sessionProjections.snapshot(session).values['test/marks']).toEqual({ marks: ['after'] })
  })

  it('serves init-derived state and asOfSeq -1 for an empty log', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(marksUnit())
    const snapshot = ctx.sessionProjections.snapshot(session)
    expect(snapshot.asOfSeq).toBe(-1)
    expect(snapshot.values['test/marks']).toEqual({ marks: [] })
  })

  it('notifies with the validated view and skips same-reference applies even when the predicate returns true', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register({ ...marksUnit(), viewChanged: () => true })
    const seen: { key: string; value: unknown; seq: number; sessionId: string }[] = []
    ctx.sessionProjections.onChanged((changedSession, key, value, seq) => {
      seen.push({ key, value, seq, sessionId: String(changedSession.id) })
    })
    const event = mark(session, ['a'])
    // Non-matching event: apply returns the same reference — no notification.
    session.append('turn/start', { turn: 1 })
    expect(seen).toEqual([{ key: 'test/marks', value: { marks: ['a'] }, seq: event.seq, sessionId: String(session.id) }])
  })

  it('contains throwing and rejecting change listeners and continues to later listeners', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(marksUnit())
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const seen: unknown[] = []
    ctx.sessionProjections.onChanged(() => {
      throw new Error('broken subscriber')
    })
    ctx.sessionProjections.onChanged(async () => {
      throw new Error('rejected subscriber')
    })
    ctx.sessionProjections.onChanged((_changedSession, _key, value) => {
      seen.push(value)
    })

    expect(() => mark(session, ['committed'])).not.toThrow()
    expect(seen).toEqual([{ marks: ['committed'] }])
    await Promise.resolve()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('onChanged listener failed for "test/marks": Error: broken subscriber'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('onChanged listener failed for "test/marks": Error: rejected subscriber'))
  })

  it('lets a unit advance private replay state without publishing an unchanged view', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(evidenceCountUnit())
    const seen: unknown[] = []
    ctx.sessionProjections.onChanged((_changedSession, _key, value) => {
      seen.push(value)
    })

    session.append('test/evidence', {})
    expect(seen).toEqual([])
    expect(ctx.sessionProjections.checkpoint(session)['test/count']?.val)
      .toEqual({ value: 0, evidence: 1 })

    mark(session, ['visible'])
    expect(seen).toEqual([1])
  })

  it('drives independently per session (cells are per-session watermarks)', async () => {
    const { ctx, session } = await harness()
    const other = ctx.sessions.create()
    ctx.sessionProjections.register(marksUnit())
    mark(session, ['one'])
    mark(other, ['two'])
    expect(ctx.sessionProjections.snapshot(session).values['test/marks']).toEqual({ marks: ['one'] })
    expect(ctx.sessionProjections.snapshot(other).values['test/marks']).toEqual({ marks: ['two'] })
  })

  it('runs every registered unit — a changing unit notifies while a same-reference unit stays silent', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(marksUnit())
    ctx.sessionProjections.register(countUnit())
    const changedKeys: string[] = []
    ctx.sessionProjections.onChanged((_session, key) => {
      changedKeys.push(key)
    })
    session.append('turn/start', { turn: 1 })
    // count applied (+1 change), marks returned the same reference.
    expect(changedKeys).toEqual(['test/count'])
    const snapshot = ctx.sessionProjections.snapshot(session)
    expect(snapshot.values['test/count']).toBe(1)
    expect(snapshot.values['test/marks']).toEqual({ marks: [] })
  })

  it('shares one unit between registrants of the same key', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(marksUnit())

    // One definition already serves every Session (cells are keyed by
    // Session), while owners are per agent/fiber: an agent preset may mount
    // the same package once for each agent.
    expect(() => ctx.sessionProjections.register(marksUnit())).not.toThrow()
    mark(session, ['kept'])
    expect(ctx.sessionProjections.snapshot(session).values['test/marks']).toEqual({ marks: ['kept'] })
  })

  it('keeps the unit until the last registrant releases it', async () => {
    const { ctx, session } = await harness()
    const first = ctx.sessionProjections.register(marksUnit())
    const second = ctx.sessionProjections.register(marksUnit())
    mark(session, ['kept'])

    first()

    // The regression this counts against: one session ending used to strip
    // the projection from every other live session, because the first
    // registrant owned the only disposer.
    expect(ctx.sessionProjections.snapshot(session).values['test/marks']).toEqual({ marks: ['kept'] })
    second()
    expect(ctx.sessionProjections.snapshot(session).values).toEqual({})
  })

  it('refuses to share a key across a stateVersion change', async () => {
    const { ctx } = await harness()
    ctx.sessionProjections.register(marksUnit())

    // The versioned private-state contract differs, so even the same
    // definition family cannot share cells. A different definitionToken is
    // independently incompatible, as the following regression proves.
    expect(() => ctx.sessionProjections.register({ ...marksUnit(), stateVersion: 9 }))
      .toThrow(/already has an active owner/)
  })

  it('refuses an active same-version owner with a different definition token', async () => {
    const { ctx } = await harness()
    ctx.sessionProjections.register(marksUnit())

    expect(() => ctx.sessionProjections.register({
      ...marksUnit(),
      definitionToken: Symbol('different marks definition'),
    })).toThrow(/only the same definitionToken and stateVersion/)
  })

  it('rejects global definition tokens', async () => {
    const { ctx } = await harness()
    expect(() => ctx.sessionProjections.register({
      ...marksUnit(),
      definitionToken: Symbol.for('test marks definition'),
    })).toThrow(/module-private Symbol/)
  })

  it('rejects well-known definition tokens', async () => {
    const { ctx } = await harness()
    expect(() => ctx.sessionProjections.register({
      ...marksUnit(),
      definitionToken: Symbol.iterator,
    })).toThrow(/module-private Symbol/)
  })

  it('rejects an empty projection key before it can diverge from the push wire', async () => {
    const { ctx } = await harness()
    expect(() => ctx.sessionProjections.register({ ...marksUnit(), key: '' as 'test/marks' }))
      .toThrow(/key must be a non-empty string/)
  })

  it('rejects a non-integer or negative stateVersion at register time', async () => {
    const { ctx } = await harness()
    expect(() => ctx.sessionProjections.register({ ...marksUnit(), stateVersion: -1 })).toThrow(/stateVersion/)
    expect(() => ctx.sessionProjections.register({ ...marksUnit(), stateVersion: 1.5 })).toThrow(/stateVersion/)
  })

  it('register() disposer removes the key (with its cells) and frees it for re-registration', async () => {
    const { ctx, session } = await harness()
    const dispose = ctx.sessionProjections.register(marksUnit())
    mark(session, ['cached'])
    dispose()
    expect(ctx.sessionProjections.snapshot(session).values).toEqual({})
    ctx.sessionProjections.register(marksUnit())
    // Fresh registration rebuilds from the log, not from a stale cell.
    expect(ctx.sessionProjections.snapshot(session).values['test/marks']).toEqual({ marks: ['cached'] })
  })

  it('removes registrations and change listeners when their owning fiber unloads (HMR safety)', async () => {
    const { ctx, session } = await harness()
    const notifications: string[] = []
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.sessionProjections.register(marksUnit())
      inner.sessionProjections.onChanged((_session, key) => {
        notifications.push(key)
      })
    }, { inject: ['sessionProjections'] }))
    mark(session, ['live'])
    expect(notifications).toEqual(['test/marks'])
    await fiber.dispose()
    mark(session, ['after-dispose'])
    expect(notifications).toEqual(['test/marks'])
    expect(ctx.sessionProjections.snapshot(session).values).toEqual({})
  })

  it('checkpoints every registered unit with its stateVersion and per-cell watermark', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(marksUnit())
    ctx.sessionProjections.register({ ...countUnit(), stateVersion: 7 })
    const markEvent = mark(session, ['a'])
    const rows = ctx.sessionProjections.checkpoint(session)
    expect(rows['test/marks']).toEqual({ ver: 1, seq: markEvent.seq, val: { marks: ['a'] } })
    expect(rows['test/count']).toEqual({ ver: 7, seq: markEvent.seq, val: 1 })
    // Empty log: init-derived state at watermark -1.
    const fresh = ctx.sessions.create()
    expect(ctx.sessionProjections.checkpoint(fresh)['test/marks']).toEqual({ ver: 1, seq: -1, val: null })
  })

  it('checkpoint states are detached clones — mutating them cannot corrupt the watermark cache', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(marksUnit())
    mark(session, ['a'])
    const rows = ctx.sessionProjections.checkpoint(session)
    // Hostile (or merely careless) consumer mutates the handed-out state.
    ;(rows['test/marks']?.val as { marks: string[] }).marks.push('INJECTED')
    // The registry's authoritative cell is untouched: snapshot and a fresh
    // checkpoint both still serve the committed value.
    expect(ctx.sessionProjections.snapshot(session).values['test/marks']).toEqual({ marks: ['a'] })
    expect(ctx.sessionProjections.checkpoint(session)['test/marks']?.val).toEqual({ marks: ['a'] })
  })

  it.each([
    ['Map', new Map([['key', 'value']])],
    ['Date', new Date(0)],
  ])('checkpoint rejects a non-JSON %s state at the registry boundary', async (_label, value) => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register({
      key: 'test/non-json' as never,
      definitionToken: Symbol('test non-json definition'),
      schema: { parse: (input: unknown) => input } as never,
      init: () => value,
      apply: state => state,
      view: state => state as never,
      stateVersion: 1,
    })

    expect(() => ctx.sessionProjections.checkpoint(session))
      .toThrow('checkpoint state is not losslessly JSON-serializable')
    expect(() => ctx.sessionProjections.restore({}, [], 0))
      .toThrow('checkpoint state is not losslessly JSON-serializable')
  })

  it('uses checkpoint schemas for admission without allowing read-time state migration', async () => {
    const transformed = await harness()
    transformed.ctx.sessionProjections.register({
      key: 'test/count',
      definitionToken: Symbol('test transformed count definition'),
      schema: z.number(),
      checkpointStateSchema: z.number().transform(value => value + 1),
      init: () => 0,
      apply: state => state,
      view: state => state,
      stateVersion: 1,
    })
    const row = { 'test/count': { ver: 1, seq: -1, val: 2 } }
    expect(transformed.ctx.sessionProjections.viewCheckpoint(row)).toEqual({})
    expect(transformed.ctx.sessionProjections.restoreFloor(row)).toBe(0)
    expect(transformed.ctx.sessionProjections.restore(row, [], 0)).toEqual({
      snapshot: { asOfSeq: -1, values: { 'test/count': 0 } },
      checkpoint: { 'test/count': { ver: 1, seq: -1, val: 0 } },
    })

    const nullable = await harness()
    nullable.ctx.sessionProjections.register({
      key: 'test/nullable' as never,
      definitionToken: Symbol('test nullable definition'),
      schema: z.null() as never,
      checkpointStateSchema: z.null().transform(() => null),
      init: () => null,
      apply: state => state,
      view: (state: null) => state as never,
      stateVersion: 1,
    })
    const nullRow = { 'test/nullable': { ver: 1, seq: -1, val: null } }
    expect(nullable.ctx.sessionProjections.viewCheckpoint(nullRow)).toEqual({ 'test/nullable': null })
    expect(nullable.ctx.sessionProjections.restore(nullRow, [], 0)).toEqual({
      snapshot: { asOfSeq: -1, values: { 'test/nullable': null } },
      checkpoint: { 'test/nullable': { ver: 1, seq: -1, val: null } },
    })

    const undefinedState = await harness()
    undefinedState.ctx.sessionProjections.register({
      key: 'test/undefined' as never,
      definitionToken: Symbol('test undefined definition'),
      schema: z.null() as never,
      checkpointStateSchema: z.null().transform(() => undefined),
      init: () => null,
      apply: state => state,
      view: state => state as never,
      stateVersion: 1,
    })
    const invalid = { 'test/undefined': { ver: 1, seq: -1, val: null } }
    expect(undefinedState.ctx.sessionProjections.viewCheckpoint(invalid)).toEqual({})
    expect(undefinedState.ctx.sessionProjections.restoreFloor(invalid)).toBe(0)
    expect(undefinedState.ctx.sessionProjections.restore(invalid, [], 0)).toEqual({
      snapshot: { asOfSeq: -1, values: { 'test/undefined': null } },
      checkpoint: { 'test/undefined': { ver: 1, seq: -1, val: null } },
    })
  })

  it('restoreFloor overlaps the lowest usable watermark and returns 0 for missing or mismatched rows', async () => {
    const { ctx } = await harness()
    expect(ctx.sessionProjections.restoreFloor({})).toBeUndefined() // no unit registered
    ctx.sessionProjections.register(marksUnit())
    ctx.sessionProjections.register(countUnit())
    expect(ctx.sessionProjections.restoreFloor({})).toBe(0)
    // Lowest usable watermark is count's 5 → the anchored tail starts AT 5
    // (one below the first needed seq 6), so the read proves seq 5 still exists.
    expect(ctx.sessionProjections.restoreFloor({
      'test/marks': { ver: 1, seq: 10, val: { marks: [] } },
      'test/count': { ver: 1, seq: 5, val: 6 },
    })).toBe(5)
    // A version-mismatched row forces that key back to a full refold.
    expect(ctx.sessionProjections.restoreFloor({
      'test/marks': { ver: 2, seq: 10, val: { marks: [] } },
      'test/count': { ver: 1, seq: 5, val: 6 },
    })).toBe(0)
    // A fresh (-1) row still needs the whole tail from 0.
    expect(ctx.sessionProjections.restoreFloor({
      'test/marks': { ver: 1, seq: -1, val: null },
      'test/count': { ver: 1, seq: -1, val: 0 },
    })).toBe(0)
  })

  it('restore folds the tail past each usable row and refolds from init on version mismatch', async () => {
    const { ctx } = await harness()
    ctx.sessionProjections.register(marksUnit())
    ctx.sessionProjections.register(countUnit())
    const tail: SessionEvent[] = [
      { type: 'test/mark', seq: 3, time: 3, data: { marks: ['new'] } },
      { type: 'turn/end', seq: 4, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    // marks row usable (watermark 2, tail starts at 3); count row mismatched — but
    // a mismatch with baseSeq > 0 cannot silently refold: it throws for a re-read.
    expect(() => ctx.sessionProjections.restore({
      'test/marks': { ver: 1, seq: 2, val: { marks: ['old'] } },
      'test/count': { ver: 99, seq: 2, val: 3 },
    }, tail, 3)).toThrow(/re-read from seq 0/)
    // The full-log re-read (baseSeq 0) refolds the mismatched key from init.
    const full: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
      { type: 'test/mark', seq: 1, time: 1, data: { marks: ['old'] } },
      { type: 'test/mark', seq: 2, time: 2, data: { marks: ['old', '2'] } },
      ...tail,
    ]
    const { snapshot, checkpoint } = ctx.sessionProjections.restore({
      'test/marks': { ver: 1, seq: 2, val: { marks: ['old', '2'] } },
      'test/count': { ver: 99, seq: 2, val: 3 },
    }, full, 0)
    expect(snapshot.asOfSeq).toBe(4)
    expect(snapshot.values['test/marks']).toEqual({ marks: ['new'] })
    expect(snapshot.values['test/count']).toBe(5) // refolded from init over all 5 events
    // The refreshed rows sit at the served cut, ready for a durable write-back.
    expect(checkpoint['test/marks']).toEqual({ ver: 1, seq: 4, val: { marks: ['new'] } })
    expect(checkpoint['test/count']).toEqual({ ver: 1, seq: 4, val: 5 })
  })

  it('restore over a suffix folds only past each row watermark and serves an exact empty-tail cut', async () => {
    const { ctx } = await harness()
    ctx.sessionProjections.register(marksUnit())
    ctx.sessionProjections.register(countUnit())
    const rows = {
      'test/marks': { ver: 1, seq: 4, val: { marks: ['done'] } },
      'test/count': { ver: 1, seq: 2, val: 3 },
    }
    const tail: SessionEvent[] = [
      { type: 'turn/start', seq: 3, time: 3, data: { turn: 2 } },
      { type: 'turn/end', seq: 4, time: 4, data: { turn: 2, reason: { kind: 'completed' } } },
    ]
    const { snapshot } = ctx.sessionProjections.restore(rows, tail, 3)
    expect(snapshot.asOfSeq).toBe(4)
    // marks already covers the tail (watermark 4): nothing re-applied.
    expect(snapshot.values['test/marks']).toEqual({ marks: ['done'] })
    // count folds exactly seqs 3 and 4 on top of its checkpoint.
    expect(snapshot.values['test/count']).toBe(5)

    // Empty tail (checkpoint is current): the cut sits at baseSeq - 1.
    const { snapshot: current } = ctx.sessionProjections.restore({
      'test/marks': { ver: 1, seq: 4, val: { marks: ['done'] } },
      'test/count': { ver: 1, seq: 4, val: 5 },
    }, [], 5)
    expect(current.asOfSeq).toBe(4)
    expect(current.values['test/count']).toBe(5)
  })

  it('viewCheckpoint serves version-matching rows without any log and skips mismatched keys', async () => {
    const { ctx } = await harness()
    ctx.sessionProjections.register(marksUnit())
    ctx.sessionProjections.register(countUnit())
    const values = ctx.sessionProjections.viewCheckpoint({
      'test/marks': { ver: 1, seq: 4, val: { marks: ['stored'] } },
      'test/count': { ver: 99, seq: 4, val: 5 }, // mismatched: absent
    })
    expect(values['test/marks']).toEqual({ marks: ['stored'] })
    expect('test/count' in values).toBe(false)
    expect(ctx.sessionProjections.viewCheckpoint({})).toEqual({})
  })

  it('rejects invalid private checkpoint state at every persisted-state read face', async () => {
    const { ctx } = await harness()
    ctx.sessionProjections.register(marksUnit())
    const invalid = {
      'test/marks': { ver: 1, seq: 2, val: { marks: [1] } },
    }

    expect(ctx.sessionProjections.viewCheckpoint(invalid)).toEqual({})
    expect(ctx.sessionProjections.restoreFloor(invalid)).toBe(0)
    expect(() => ctx.sessionProjections.restore(invalid, [
      { type: 'turn/end', seq: 2, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ], 2)).toThrow(/state-invalid/)

    const full: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
      { type: 'test/mark', seq: 1, time: 1, data: { marks: ['rebuilt'] } },
    ]
    const restored = ctx.sessionProjections.restore(invalid, full, 0)
    expect(restored.snapshot.values['test/marks']).toEqual({ marks: ['rebuilt'] })
    expect(restored.checkpoint['test/marks']?.val).toEqual({ marks: ['rebuilt'] })
  })

  it('restore rejects a row claiming events past the supplied log end (shrunk log ⇒ re-read)', async () => {
    const { ctx } = await harness()
    ctx.sessionProjections.register(countUnit())
    const rows = { 'test/count': { ver: 1, seq: 9, val: 10 } }
    // The anchored floor sits ON the watermark, so the tail read must return
    // at least seq 9 from an intact log…
    const floor = ctx.sessionProjections.restoreFloor(rows)
    expect(floor).toBe(9)
    // …an intact log serves the anchor event and the checkpoint stands as-is.
    const anchor: SessionEvent = { type: 'turn/end', seq: 9, time: 9, data: { turn: 2, reason: { kind: 'completed' } } }
    expect(ctx.sessionProjections.restore(rows, [anchor], 9).snapshot.values['test/count']).toBe(10)
    // …while a log crash-repaired down to fewer events returns an empty tail:
    // the row overreaches the proven end and a tail read cannot fix this key.
    expect(() => ctx.sessionProjections.restore(rows, [], 9)).toThrow(/re-read from seq 0/)
    // The full re-read discards the overreaching row and refolds from init.
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const { snapshot } = ctx.sessionProjections.restore(rows, events, 0)
    expect(snapshot.asOfSeq).toBe(1)
    expect(snapshot.values['test/count']).toBe(2)
  })

  it('fails loud when a unit view violates its own schema (async unit output is unrepresentable)', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register({
      key: 'test/marks',
      definitionToken: Symbol('test async-view definition'),
      schema: z.object({ marks: z.array(z.string()) }),
      init: () => null as MarksState,
      apply: state => state,
      // A Promise (what an accidentally-async view would return) is not the
      // declared shape: the boundary parse rejects it before it leaves.
      view: () => Promise.resolve({ marks: [] }) as never,
      stateVersion: 1,
    })
    expect(() => ctx.sessionProjections.snapshot(session)).toThrow()
  })
})
