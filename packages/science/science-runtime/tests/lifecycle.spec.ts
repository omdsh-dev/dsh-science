/** Exact-Session quarantine, detachment, and provider-disposal behavior. */

import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ScienceEnvironmentProfileId } from '@deepseek-ai/dsh-science-session'
import { ScienceRuntimeError } from '../src/index.ts'
import {
  attachScienceSession,
  authorizePythonRun,
  createControlledRuntimeHarness,
  createFakePythonPrefix,
} from './harness.ts'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Bind the controlled fake prefix through the public operation. */
async function bindFakePython(
  runtime: Awaited<ReturnType<typeof createControlledRuntimeHarness>>['runtime'],
  session: ReturnType<typeof attachScienceSession>['session'],
): Promise<void> {
  await runtime.bindEnvironment({
    session,
    profileId: ScienceEnvironmentProfileId('fake'),
    signal: new AbortController().signal,
  })
}

describe('ScienceRuntime lifecycle ownership', () => {
  it('quarantines a same-ID successor until a non-quiescent old tree is later proven dead', async () => {
    const root = mkdtempSync(join(process.cwd(), '.science-runtime-quarantine-'))
    roots.push(root)
    const prefix = createFakePythonPrefix(root)
    const harness = await createControlledRuntimeHarness(root, { fake: { pythonPrefix: prefix } })
    contexts.push(harness.ctx)
    const { ctx, runtime, subprocess } = harness
    const original = attachScienceSession(ctx, 'science-same-id')
    await bindFakePython(runtime, original.session)
    const oldRun = subprocess.queueRun('deferred')
    const oldHandle = await runtime.startRun({
      session: original.session,
      language: 'python',
      code: 'long-running old lifecycle',
      ...authorizePythonRun(original.session),
      signal: new AbortController().signal,
    })

    original.detach()
    await expect(oldHandle.done).rejects.toMatchObject({ code: 'QUIESCENCE_UNPROVEN' })
    expect(oldRun.terminations).toBeGreaterThan(0)
    const successor = attachScienceSession(ctx, 'science-same-id', original.session.events)
    const successorAuthorization = authorizePythonRun(successor.session, 'science-same-id-successor')
    const retry = () => runtime.startRun({
      session: successor.session,
      language: 'python',
      code: 'must not touch shared scratch while quarantined',
      ...successorAuthorization,
      signal: new AbortController().signal,
    })

    await expect(retry()).rejects.toMatchObject({ code: 'RUNTIME_BUSY' })
    oldRun.proveQuiescence()
    const successorRun = subprocess.queueRun('immediate')
    let successorHandle: Awaited<ReturnType<typeof retry>> | undefined
    await vi.waitFor(async () => {
      try {
        successorHandle = await retry()
      } catch (error) {
        expect(error).toMatchObject({ code: 'RUNTIME_BUSY' })
        throw error
      }
    }, { timeout: 500, interval: 10 })
    if (successorHandle === undefined) throw new Error('same-ID successor did not leave quarantine')
    successorHandle.cancel()
    await expect(successorHandle.done).resolves.toMatchObject({
      terminal: { runId: successorHandle.runId, status: 'cancelled', failureCode: 'CANCELLED' },
    })
    expect(successorRun.terminations).toBe(1)
  })

  it('cleans an unexpectedly detached exact Session but never appends to its old log', async () => {
    const root = mkdtempSync(join(process.cwd(), '.science-runtime-detach-'))
    roots.push(root)
    const prefix = createFakePythonPrefix(root)
    const harness = await createControlledRuntimeHarness(root, { fake: { pythonPrefix: prefix } })
    contexts.push(harness.ctx)
    const { ctx, runtime, subprocess } = harness
    const attached = attachScienceSession(ctx, 'science-detached')
    await bindFakePython(runtime, attached.session)
    subprocess.queueRun('immediate')
    const handle = await runtime.startRun({
      session: attached.session,
      language: 'python',
      code: 'detached while running',
      ...authorizePythonRun(attached.session),
      signal: new AbortController().signal,
    })

    attached.detach()
    await expect(handle.done).rejects.toMatchObject({ code: 'SESSION_NOT_LIVE' })
    expect(attached.session.events.some(event => event.type === 'science/run-finished')).toBe(false)
  })

  it('cancels and quiesces a live run, then removes its service registration on fiber disposal', async () => {
    const root = mkdtempSync(join(process.cwd(), '.science-runtime-dispose-'))
    roots.push(root)
    const prefix = createFakePythonPrefix(root)
    const harness = await createControlledRuntimeHarness(root, { fake: { pythonPrefix: prefix } })
    contexts.push(harness.ctx)
    const { ctx, runtime, runtimeFiber, subprocess } = harness
    const session = attachScienceSession(ctx, 'science-runtime-dispose')
    await bindFakePython(runtime, session.session)
    const run = subprocess.queueRun('immediate')
    const handle = await runtime.startRun({
      session: session.session,
      language: 'python',
      code: 'dispose while running',
      ...authorizePythonRun(session.session),
      signal: new AbortController().signal,
    })

    await runtimeFiber.dispose()
    await expect(handle.done).resolves.toMatchObject({
      terminal: { runId: handle.runId, status: 'cancelled', failureCode: 'CANCELLED' },
    })
    expect(run.terminations).toBeGreaterThan(0)
    expect(ctx.scienceRuntime).toBeUndefined()
    await expect(runtime.bindEnvironment({
      session: session.session,
      profileId: ScienceEnvironmentProfileId('fake'),
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'SERVICE_DISPOSING' } satisfies Partial<ScienceRuntimeError>)
  })
})
