/** Focused durable run ordering, clean-environment, drift, and cancellation coverage. */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ScienceEnvironmentProfileId, replayScience } from '@deepseek-ai/dsh-science-session'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ScienceRuntimeError } from '../src/index.ts'
import {
  authorizeRun,
  authorizePythonRun,
  createFastRuntimeHarness,
  createFakeRPrefix,
  createFakePythonPrefix,
  createScienceSession,
} from './harness.ts'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Bind the fake Python profile through the public Runtime operation. */
async function bindFakePython(
  runtime: Awaited<ReturnType<typeof createFastRuntimeHarness>>['runtime'],
  session: ReturnType<typeof createScienceSession>,
): Promise<void> {
  await runtime.bindEnvironment({
    session,
    profileId: ScienceEnvironmentProfileId('fake'),
    signal: new AbortController().signal,
  })
}

describe('ScienceRuntime.startRun', () => {
  it('commits start before direct source spawn, then commits the matching terminal with bounded operational output', async () => {
    const root = mkdtempSync(join(process.cwd(), '.science-runtime-run-'))
    roots.push(root)
    const prefix = createFakePythonPrefix(root)
    const harness = await createFastRuntimeHarness(root, { fake: { pythonPrefix: prefix } })
    contexts.push(harness.ctx)
    const { ctx, runtime, subprocess } = harness
    const session = createScienceSession(ctx, 'science-run-success')
    await bindFakePython(runtime, session)
    const authorization = authorizePythonRun(session)
    let eventsAtSpawn: string[] | undefined
    subprocess.onSpawn = (spec) => {
      if (spec.argv.includes('-u')) eventsAtSpawn = session.events.map(event => event.type)
    }

    const handle = await runtime.startRun({
      session,
      language: 'python',
      code: 'print("not interpreted by the fake prefix")',
      ...authorization,
      signal: new AbortController().signal,
    })
    const result = await handle.done
    const runSpec = subprocess.specs.at(-1)
    const started = session.events.find(event => event.type === 'science/run-started')

    expect(eventsAtSpawn?.at(-1)).toBe('science/run-started')
    expect(runSpec).toMatchObject({
      argv: [join(prefix, 'bin', 'python'), '-I', '-B', '-u', '-X', 'utf8', expect.any(String)],
      environmentBase: 'empty',
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 64_000 },
        stderr: { maxBytes: 64_000 },
      },
    })
    expect(Object.keys(runSpec?.env ?? {}).sort()).toEqual([
      'HOME', 'LANG', 'LC_ALL', 'PATH', 'SCIENCE_ARTIFACT_DIR', 'SCIENCE_STATE_DIR', 'TMPDIR', 'TZ',
    ])
    expect(result).toMatchObject({
      terminal: { runId: handle.runId, status: 'success', stdoutBytes: 16, stderrBytes: 0 },
      stdout: { text: 'fake run output\n', bytes: 16, truncated: false },
      stderr: { text: '', bytes: 0, truncated: false },
    })
    expect(started?.data.run).toMatchObject({
      runId: handle.runId,
      runDirectoryRef: `runs/${String(handle.runId)}/`,
      status: 'running',
    })
    expect(JSON.stringify(started?.data.run)).not.toContain(join(root, 'dsh-home'))
    expect(session.events.map(event => event.type).slice(-2)).toEqual([
      'science/run-started',
      'science/run-finished',
    ])
    const cold = Session.create(SessionId('science-run-success-cold'), session.events)
    expect(replayScience(cold.events)).toEqual(replayScience(session.events))
  })

  it('executes direct Rscript argv under the accepted R binding', async () => {
    const root = mkdtempSync(join(process.cwd(), '.science-runtime-r-run-'))
    roots.push(root)
    const prefix = createFakeRPrefix(root)
    const harness = await createFastRuntimeHarness(root, { r: { rPrefix: prefix } })
    contexts.push(harness.ctx)
    const { ctx, runtime, subprocess } = harness
    const session = createScienceSession(ctx, 'science-run-r')
    await runtime.bindEnvironment({
      session,
      profileId: ScienceEnvironmentProfileId('r'),
      signal: new AbortController().signal,
    })
    const handle = await runtime.startRun({
      session,
      language: 'r',
      code: 'print("R path")',
      ...authorizeRun(session, 'r', 'science-runtime-r-call'),
      signal: new AbortController().signal,
    })

    await expect(handle.done).resolves.toMatchObject({
      terminal: { runId: handle.runId, status: 'success' },
      stdout: { text: 'fake R run output\n' },
    })
    expect(subprocess.specs.at(-1)?.argv).toEqual([
      join(prefix, 'bin', 'Rscript'), '--vanilla', '--encoding=UTF-8', expect.any(String),
    ])
  })

  it('runs Python from a space-containing owned root with metacharacters only as direct source bytes', async () => {
    const root = mkdtempSync(join(process.cwd(), '.science runtime-python-direct-'))
    roots.push(root)
    const prefix = createFakePythonPrefix(root)
    const harness = await createFastRuntimeHarness(root, { fake: { pythonPrefix: prefix } })
    contexts.push(harness.ctx)
    const { ctx, runtime, subprocess } = harness
    const session = createScienceSession(ctx, 'science-run-direct-space')
    await bindFakePython(runtime, session)
    const handle = await runtime.startRun({
      session,
      language: 'python',
      code: 'print("$() ; [] && unicode 运行")',
      ...authorizePythonRun(session, 'science-runtime-direct-space-call'),
      signal: new AbortController().signal,
    })

    await expect(handle.done).resolves.toMatchObject({ terminal: { status: 'success' } })
    const argv = subprocess.specs.at(-1)?.argv
    expect(argv).toEqual([
      join(prefix, 'bin', 'python'), '-I', '-B', '-u', '-X', 'utf8', expect.stringContaining('science runtime-python-direct-'),
    ])
  })

  it('preserves non-ASCII output without placing text in Science facts', async () => {
    const unicodeRoot = mkdtempSync(join(process.cwd(), '.science-runtime-unicode-output-'))
    roots.push(unicodeRoot)
    const unicodePrefix = createFakePythonPrefix(unicodeRoot)
    const unicodeHarness = await createFastRuntimeHarness(unicodeRoot, { fake: { pythonPrefix: unicodePrefix } })
    contexts.push(unicodeHarness.ctx)
    const unicodeSession = createScienceSession(unicodeHarness.ctx, 'science-run-unicode')
    await bindFakePython(unicodeHarness.runtime, unicodeSession)
    const unicodeRun = unicodeHarness.subprocess.queueRun('immediate', { stdout: '运行-✓\n' })
    const unicodeHandle = await unicodeHarness.runtime.startRun({
      session: unicodeSession,
      language: 'python',
      code: 'print("运行-✓")',
      ...authorizePythonRun(unicodeSession, 'science-runtime-unicode-call'),
      signal: new AbortController().signal,
    })
    unicodeRun.complete({ exitCode: 0, signal: null })
    const unicode = await unicodeHandle.done
    expect(unicode.stdout).toEqual({
      text: '运行-✓\n',
      bytes: Buffer.byteLength('运行-✓\n'),
      truncated: false,
    })
    expect(JSON.stringify(unicodeSession.events)).not.toContain('运行-✓')
  })

  it('reports exact retained-tail byte totals for a larger output stream', async () => {
    const largeRoot = mkdtempSync(join(process.cwd(), '.science-runtime-large-output-'))
    roots.push(largeRoot)
    const largePrefix = createFakePythonPrefix(largeRoot)
    const largeHarness = await createFastRuntimeHarness(largeRoot, { fake: { pythonPrefix: largePrefix } })
    contexts.push(largeHarness.ctx)
    const largeSession = createScienceSession(largeHarness.ctx, 'science-run-large')
    await bindFakePython(largeHarness.runtime, largeSession)
    const largeRun = largeHarness.subprocess.queueRun('immediate', {
      stdout: 'x'.repeat(64_000),
      stdoutBytes: 70_000,
      stdoutLossy: true,
    })
    const largeHandle = await largeHarness.runtime.startRun({
      session: largeSession,
      language: 'python',
      code: 'print("large output")',
      ...authorizePythonRun(largeSession, 'science-runtime-large-call'),
      signal: new AbortController().signal,
    })
    largeRun.complete({ exitCode: 0, signal: null })
    await expect(largeHandle.done).resolves.toMatchObject({
      terminal: { stdoutBytes: 70_000, stdoutTruncated: true },
      stdout: { bytes: 70_000, text: 'x'.repeat(64_000), truncated: true },
    })
  })

  it('holds one running Session reservation, then cancels the managed tree before appending its terminal value', async () => {
    const root = mkdtempSync(join(process.cwd(), '.science-runtime-cancel-'))
    roots.push(root)
    const prefix = createFakePythonPrefix(root)
    const harness = await createFastRuntimeHarness(root, { fake: { pythonPrefix: prefix } })
    contexts.push(harness.ctx)
    const { ctx, runtime, subprocess } = harness
    const session = createScienceSession(ctx, 'science-run-cancel')
    await bindFakePython(runtime, session)
    const authorization = authorizePythonRun(session)
    const running = subprocess.queueRun('immediate')
    const handle = await runtime.startRun({
      session,
      language: 'python',
      code: 'print("cancel me")',
      ...authorization,
      signal: new AbortController().signal,
    })
    await expect(runtime.startRun({
      session,
      language: 'python',
      code: 'print("concurrent")',
      ...authorization,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'RUNTIME_BUSY' })
    handle.cancel()
    await expect(handle.done).resolves.toMatchObject({
      terminal: { runId: handle.runId, status: 'cancelled', failureCode: 'CANCELLED' },
    })
    expect(session.events.map(event => event.type).slice(-1)).toEqual(['science/run-finished'])
    expect(running.terminations).toBe(1)
  })

  it('waits for managed-tree quiescence before committing an ordinary nonzero terminal', async () => {
    const root = mkdtempSync(join(process.cwd(), '.science-runtime-failure-'))
    roots.push(root)
    const prefix = createFakePythonPrefix(root)
    const harness = await createFastRuntimeHarness(root, { fake: { pythonPrefix: prefix } })
    contexts.push(harness.ctx)
    const { ctx, runtime, subprocess } = harness
    const session = createScienceSession(ctx, 'science-run-failure')
    await bindFakePython(runtime, session)
    const authorization = authorizePythonRun(session)
    const failed = subprocess.queueRun('immediate', { stderr: 'fake program failure\n' })
    let terminalObservedBeforeTreeExit: boolean | undefined
    failed.onFirstWait = () => {
      terminalObservedBeforeTreeExit = session.events.some(event => event.type === 'science/run-finished')
    }

    const handle = await runtime.startRun({
      session,
      language: 'python',
      code: 'print("fail")',
      ...authorization,
      signal: new AbortController().signal,
    })

    failed.complete({ exitCode: 23, signal: null })
    await expect(handle.done).resolves.toMatchObject({
      terminal: {
        runId: handle.runId,
        status: 'failed',
        exitCode: 23,
        failureCode: 'PROCESS_EXIT_NONZERO',
        stderrBytes: 21,
      },
      stderr: { text: 'fake program failure\n', bytes: 21, truncated: false },
    })
    expect(terminalObservedBeforeTreeExit).toBe(false)
    expect(session.events.at(-1)?.type).toBe('science/run-finished')
  })

  it('settles a published run as timed-out and commits its terminal after forced cleanup', async () => {
    const root = mkdtempSync(join(process.cwd(), '.science-runtime-timeout-'))
    roots.push(root)
    const prefix = createFakePythonPrefix(root)
    const harness = await createFastRuntimeHarness(root, { fake: { pythonPrefix: prefix } }, 500)
    contexts.push(harness.ctx)
    const { ctx, runtime, subprocess } = harness
    const session = createScienceSession(ctx, 'science-run-timeout')
    await bindFakePython(runtime, session)
    const authorization = authorizePythonRun(session)
    const timedOut = subprocess.queueRun('immediate')
    const handle = await runtime.startRun({
      session,
      language: 'python',
      code: 'print("time out")',
      ...authorization,
      signal: new AbortController().signal,
    })

    await expect(handle.done).resolves.toMatchObject({
      terminal: { runId: handle.runId, status: 'timed-out', failureCode: 'TIMEOUT' },
    })
    expect(timedOut.terminations).toBe(1)
  })

  it('records one drift revision and refuses to spawn when the accepted prefix history changes', async () => {
    const root = mkdtempSync(join(process.cwd(), '.science-runtime-drift-'))
    roots.push(root)
    const prefix = createFakePythonPrefix(root)
    const harness = await createFastRuntimeHarness(root, { fake: { pythonPrefix: prefix } })
    contexts.push(harness.ctx)
    const { ctx, runtime, subprocess } = harness
    const session = createScienceSession(ctx, 'science-run-drift')
    await bindFakePython(runtime, session)
    writeFileSync(join(prefix, 'conda-meta', 'history'), 'changed after bind\n')
    const authorization = authorizePythonRun(session)
    const before = subprocess.specs.length

    const error = await runtime.startRun({
      session,
      language: 'python',
      code: 'print("must not spawn")',
      ...authorization,
      signal: new AbortController().signal,
    }).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(ScienceRuntimeError)
    expect(error).toMatchObject({ code: 'ENVIRONMENT_NOT_READY' })
    expect(subprocess.specs).toHaveLength(before + 2)
    expect(session.events.filter(event => event.type === 'science/environment-bound').map(event => event.data.environment.status))
      .toEqual(['applied', 'drifted'])
    expect(session.events.some(event => event.type === 'science/run-started')).toBe(false)
  })
})
