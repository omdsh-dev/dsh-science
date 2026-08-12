/** Cordis HMR overlap: new owners take over before old async cleanup ends. */

import { Context, FiberState } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    'test/hmr': { marks: string[] }
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'test/hmr-mark': { marks: string[] }
  }
}

type State = { marks: string[] } | null
const oldDefinitionToken = Symbol('old HMR projection definition')
const newDefinitionToken = Symbol('new HMR projection definition')

const unit = (
  stateVersion: number,
  label: string,
  definitionToken: symbol,
): ProjectionDefinition<'test/hmr', State> => ({
  key: 'test/hmr',
  definitionToken,
  schema: z.object({ marks: z.array(z.string()) }),
  init: () => null,
  apply: (state, event) => event.type === 'test/hmr-mark' ? event.data : state,
  view: state => ({ marks: (state?.marks ?? []).map(mark => `${label}:${mark}`) }),
  stateVersion,
})

const mark = (session: Session, marks: string[]): void => {
  session.append('test/hmr-mark', { marks })
}

describe('SessionProjectionRegistry HMR overlap', () => {
  it('allows an unloading version to be replaced and never republishes it as fallback', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const session = ctx.sessions.create()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })

    const oldFiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.sessionProjections.register(unit(1, 'old', oldDefinitionToken))
      // Registered after the projection effect, so reverse-order disposal
      // holds the old definition in its real UNLOADING overlap window.
      inner.effect(() => async () => held, 'test.hold-old-hmr-cleanup')
    }, { inject: ['sessionProjections'] }))
    mark(session, ['a'])
    expect(ctx.sessionProjections.snapshot(session).values['test/hmr'])
      .toEqual({ marks: ['old:a'] })

    const oldDisposal = oldFiber.dispose()
    await vi.waitFor(() => {
      expect(oldFiber.state).toBe(FiberState.UNLOADING)
    })

    const replacement = await ctx.plugin(Object.assign((inner: Context) => {
      inner.sessionProjections.register(unit(2, 'new', newDefinitionToken))
    }, { inject: ['sessionProjections'] }))
    expect(ctx.sessionProjections.snapshot(session).values['test/hmr'])
      .toEqual({ marks: ['new:a'] })

    await replacement.dispose()
    expect(ctx.sessionProjections.snapshot(session).values).not.toHaveProperty('test/hmr')

    release()
    await oldDisposal
    expect(ctx.sessionProjections.snapshot(session).values).not.toHaveProperty('test/hmr')
  })
})
