/** Persisted-state admission stays off the live path and binds row watermarks. */

import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { ZodType } from 'zod'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    'test/watermarked': number
  }
}

type WatermarkedState = { value: number; observedSeq: number }
const watermarkedDefinitionToken = Symbol('test watermarked definition')

const watermarkedStateSchema = z.object({
  value: z.number(),
  observedSeq: z.number().int().min(-1),
}).strict()

const watermarkedUnit = (
  checkpointStateSchema: ZodType<WatermarkedState> = watermarkedStateSchema,
): ProjectionDefinition<'test/watermarked', WatermarkedState> => ({
  key: 'test/watermarked',
  definitionToken: watermarkedDefinitionToken,
  schema: z.number(),
  checkpointStateSchema,
  checkpointStateSeq: state => state.observedSeq,
  init: () => ({ value: 0, observedSeq: -1 }),
  apply: (state, event) => ({ value: state.value + 1, observedSeq: event.seq }),
  view: state => state.value,
  stateVersion: 1,
})

async function harness() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  return { ctx, session: ctx.sessions.create() }
}

describe('SessionProjectionRegistry checkpoint admission', () => {
  it('rejects a valid older private state spliced under a newer outer watermark', async () => {
    const { ctx } = await harness()
    ctx.sessionProjections.register(watermarkedUnit())
    const spliced = {
      'test/watermarked': {
        ver: 1,
        seq: 9,
        val: { value: 1, observedSeq: 0 },
      },
    }

    expect(ctx.sessionProjections.viewCheckpoint(spliced)).toEqual({})
    expect(ctx.sessionProjections.restoreFloor(spliced)).toBe(0)
    expect(ctx.sessionProjections.restore(spliced, [], 0)).toEqual({
      snapshot: { asOfSeq: -1, values: { 'test/watermarked': 0 } },
      checkpoint: {
        'test/watermarked': {
          ver: 1,
          seq: -1,
          val: { value: 0, observedSeq: -1 },
        },
      },
    })
  })

  it('never invokes persisted-state admission on init, live apply, snapshot, or checkpoint', async () => {
    const { ctx, session } = await harness()
    const parse = vi.fn()
    ctx.sessionProjections.register(watermarkedUnit(z.custom<WatermarkedState>((value) => {
      parse(value)
      return watermarkedStateSchema.safeParse(value).success
    })))

    session.append('turn/start', { turn: 1 })
    ctx.sessionProjections.snapshot(session)
    const checkpoint = ctx.sessionProjections.checkpoint(session)
    expect(parse).not.toHaveBeenCalled()

    ctx.sessionProjections.viewCheckpoint(checkpoint)
    ctx.sessionProjections.restoreFloor(checkpoint)
    ctx.sessionProjections.restore(checkpoint, [session.events[0]!], 0)
    expect(parse).toHaveBeenCalledTimes(3)
  })

  it('contains an in-place schema transform and leaves the caller row untouched', async () => {
    const { ctx } = await harness()
    ctx.sessionProjections.register(watermarkedUnit(z.custom<WatermarkedState>().transform((state) => {
      state.value += 1
      return state
    })))
    const row = {
      'test/watermarked': {
        ver: 1,
        seq: -1,
        val: { value: 0, observedSeq: -1 },
      },
    }

    expect(ctx.sessionProjections.viewCheckpoint(row)).toEqual({})
    expect(row['test/watermarked'].val).toEqual({ value: 0, observedSeq: -1 })
  })

  it('rejects a watermark extractor that mutates its input', async () => {
    const { ctx } = await harness()
    ctx.sessionProjections.register({
      ...watermarkedUnit(),
      checkpointStateSeq: (state) => {
        state.value += 1
        return state.observedSeq
      },
    })
    const row = {
      'test/watermarked': {
        ver: 1,
        seq: -1,
        val: { value: 0, observedSeq: -1 },
      },
    }

    expect(ctx.sessionProjections.viewCheckpoint(row)).toEqual({})
    expect(row['test/watermarked'].val).toEqual({ value: 0, observedSeq: -1 })
  })

  it('refuses to emit a live or refreshed row whose private watermark is wrong', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register({
      ...watermarkedUnit(),
      apply: state => ({ ...state, value: state.value + 1 }),
    })
    session.append('turn/start', { turn: 1 })

    expect(() => ctx.sessionProjections.checkpoint(session))
      .toThrow(/private checkpoint watermark does not match seq 0/)
    expect(() => ctx.sessionProjections.restore({}, [session.events[0]!], 0))
      .toThrow(/private checkpoint watermark does not match seq 0/)
  })
})
