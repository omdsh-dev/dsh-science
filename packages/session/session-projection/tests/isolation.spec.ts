/** Failure containment and detached-value boundaries for projection drive. */

import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    'test/raw': { marks: string[] }
    'test/later': number
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'test/raw': { marks: string[] }
  }
}

type RawState = { marks: string[] }
const rawDefinitionToken = Symbol('test raw definition')
const laterDefinitionToken = Symbol('test later definition')

const rawUnit = (overrides: Partial<ProjectionDefinition<'test/raw', RawState>> = {}):
ProjectionDefinition<'test/raw', RawState> => ({
  key: 'test/raw',
  definitionToken: rawDefinitionToken,
  // z.custom deliberately preserves object identity; the registry boundary
  // must still detach it before any public consumer sees it.
  schema: z.custom<RawState>(value => typeof value === 'object' && value !== null),
  init: () => ({ marks: [] }),
  apply: (state, event) => event.type === 'test/raw' ? event.data : state,
  view: state => state,
  stateVersion: 1,
  ...overrides,
})

const laterUnit = (): ProjectionDefinition<'test/later', number> => ({
  key: 'test/later',
  definitionToken: laterDefinitionToken,
  schema: z.number(),
  init: () => 0,
  apply: state => state + 1,
  view: state => state,
  stateVersion: 1,
})

async function harness(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  return { ctx, session: ctx.sessions.create() }
}

const appendRaw = (session: Session, marks: string[]): SessionEvent =>
  session.append('test/raw', { marks })

describe('SessionProjectionRegistry isolation', () => {
  it('detaches snapshot values from identity views and private cells', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(rawUnit())
    appendRaw(session, ['committed'])

    const first = ctx.sessionProjections.snapshot(session)
    first.values['test/raw']?.marks.push('injected')

    expect(ctx.sessionProjections.snapshot(session).values['test/raw'])
      .toEqual({ marks: ['committed'] })
    expect(ctx.sessionProjections.checkpoint(session)['test/raw']?.val)
      .toEqual({ marks: ['committed'] })
  })

  it('does not let a schema transform mutate the private cell through an identity view', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(rawUnit({
      schema: z.custom<RawState>().transform((value) => {
        value.marks.push('schema-only')
        return value
      }),
    }))
    appendRaw(session, ['committed'])

    expect(ctx.sessionProjections.snapshot(session).values['test/raw'])
      .toEqual({ marks: ['committed', 'schema-only'] })
    expect(ctx.sessionProjections.checkpoint(session)['test/raw']?.val)
      .toEqual({ marks: ['committed'] })
  })

  it('rejects a schema output that is not losslessly JSON', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(rawUnit({
      schema: z.custom<RawState>().transform(() => new Map()) as never,
    }))

    expect(() => ctx.sessionProjections.snapshot(session))
      .toThrow(/public value is not losslessly JSON-serializable/)
  })

  it('gives each listener an independent value copy', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(rawUnit())
    const seen: unknown[] = []
    ctx.sessionProjections.onChanged((_session, _key, value) => {
      ;(value as RawState).marks.push('listener-one')
    })
    ctx.sessionProjections.onChanged((_session, _key, value) => {
      seen.push(value)
    })

    appendRaw(session, ['committed'])

    expect(seen).toEqual([{ marks: ['committed'] }])
    expect(ctx.sessionProjections.snapshot(session).values['test/raw'])
      .toEqual({ marks: ['committed'] })
  })

  it('commits every unit before the first listener can read the new registry cut', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(rawUnit())
    ctx.sessionProjections.register(laterUnit())
    const nestedSnapshots: unknown[] = []
    ctx.sessionProjections.onChanged((_session, key) => {
      if (key === 'test/raw') nestedSnapshots.push(ctx.sessionProjections.snapshot(session))
    })

    appendRaw(session, ['committed'])

    expect(nestedSnapshots).toEqual([{
      asOfSeq: 0,
      values: {
        'test/raw': { marks: ['committed'] },
        'test/later': 1,
      },
    }])
  })

  it('keeps restored public values detached from refreshed checkpoint state', async () => {
    const { ctx } = await harness()
    ctx.sessionProjections.register(rawUnit())
    const restored = ctx.sessionProjections.restore({}, [
      { type: 'test/raw', seq: 0, time: 1, data: { marks: ['restored'] } },
    ], 0)

    restored.snapshot.values['test/raw']?.marks.push('injected')

    expect(restored.checkpoint['test/raw']?.val).toEqual({ marks: ['restored'] })
  })

  it('commits state before containing a throwing change predicate and continues later units', async () => {
    const { ctx, session } = await harness()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    ctx.sessionProjections.register(rawUnit({
      viewChanged: () => {
        throw new Error('predicate failed')
      },
    }))
    ctx.sessionProjections.register(laterUnit())
    ctx.sessionProjections.onChanged(() => {})

    expect(() => appendRaw(session, ['committed'])).not.toThrow()

    const snapshot = ctx.sessionProjections.snapshot(session)
    expect(snapshot.values['test/raw']).toEqual({ marks: ['committed'] })
    expect(snapshot.values['test/later']).toBe(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('viewChanged failed for "test/raw" at seq 0'))
  })

  it('contains one unit apply failure without starving later units', async () => {
    const { ctx, session } = await harness()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const seen: string[] = []
    ctx.sessionProjections.register(rawUnit({
      apply: () => {
        throw new Error('apply failed')
      },
    }))
    ctx.sessionProjections.register(laterUnit())
    ctx.sessionProjections.onChanged((_session, key) => {
      seen.push(key)
    })

    expect(() => appendRaw(session, ['committed'])).not.toThrow()

    expect(seen).toEqual(['test/later'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('apply failed for "test/raw" at seq 0'))
  })

  it('contains one unit public-view failure without starving later units', async () => {
    const { ctx, session } = await harness()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const seen: string[] = []
    ctx.sessionProjections.register(rawUnit({
      view: () => {
        throw new Error('view failed')
      },
    }))
    ctx.sessionProjections.register(laterUnit())
    ctx.sessionProjections.onChanged((_session, key) => {
      seen.push(key)
    })

    expect(() => appendRaw(session, ['committed'])).not.toThrow()

    expect(seen).toEqual(['test/later'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('view failed for "test/raw" at seq 0'))
    expect(ctx.sessionProjections.checkpoint(session)['test/raw']?.val)
      .toEqual({ marks: ['committed'] })
  })
})
