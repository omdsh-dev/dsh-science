/** Focused fake-prefix coverage for Science environment binding and probes. */

import { existsSync, lstatSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { ScienceEnvironmentProfileId } from '@deepseek-ai/dsh-science-session'
import * as ScienceSessionInvariant from '@deepseek-ai/dsh-science-session/invariant'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import ScienceRuntime from '../src/index.ts'
import { resolveConfig } from '../src/config.ts'
import {
  ControlledSubprocess,
  createFastRuntimeHarness,
  createFakeRPrefix,
  createFakePythonPrefix,
  createScienceSession,
  DirectSandbox,
} from './harness.ts'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Inject one probe failure without weakening the successful R provider path. */
class PythonProbeFailureSandbox extends DirectSandbox {
  failPython = true

  override confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
    if (this.failPython && argv[0]?.endsWith('/python')) throw new Error('injected Python probe failure')
    return super.confine(argv, policy)
  }
}

/** Delay exactly one already-exited R probe until the test permits whole-tree observation. */
class DelayedRVersionSubprocess extends ControlledSubprocess {
  readonly rVersionStarted = Promise.withResolvers<undefined>()
  private readonly releaseVersion = Promise.withResolvers<undefined>()
  private delaying = true

  releaseRVersion(): void {
    this.releaseVersion.resolve(undefined)
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const handle = super.spawn(spec)
    if (!this.delaying || !spec.argv[0]?.endsWith('/Rscript') || !spec.argv.includes('--version')) return handle
    this.delaying = false
    this.rVersionStarted.resolve(undefined)
    return {
      ...handle,
      done: this.releaseVersion.promise.then(async () => handle.done),
      waitForExit: async (signal?: AbortSignal) => {
        await this.releaseVersion.promise
        return handle.waitForExit(signal)
      },
    }
  }
}

describe('ScienceRuntime.bindEnvironment', () => {
  it('records two empty-base, fully confined probes and commits one applied revision', async () => {
    const root = mkdtempSync(join(process.cwd(), '.science runtime-environment-'))
    roots.push(root)
    const prefix = createFakePythonPrefix(root)
    expect(lstatSync(join(prefix, 'bin', 'python')).mode & 0o777).toBe(0o700)
    const harness = await createFastRuntimeHarness(root, { fake: { pythonPrefix: prefix } })
    contexts.push(harness.ctx)
    const { ctx, runtime, sandbox, subprocess } = harness
    const session = createScienceSession(ctx, 'science-bind-fake')
    const environment = await runtime.bindEnvironment({
      session,
      profileId: ScienceEnvironmentProfileId('fake'),
      signal: new AbortController().signal,
    })

    expect(environment).toMatchObject({
      revision: 1,
      profileId: 'fake',
      status: 'applied',
      python: {
        capability: 'available',
        language: 'python',
        canonicalPrefix: prefix,
        executable: join(prefix, 'bin', 'python'),
        languageVersion: 'Fake Python 3.13.5',
      },
    })
    expect(session.events.map(event => event.type)).toEqual([
      'science/mode-bound',
      'science/environment-bound',
    ])
    expect(subprocess.specs).toHaveLength(2)
    for (const spec of subprocess.specs) {
      expect(spec.environmentBase).toBe('empty')
      expect(Object.keys(spec.env ?? {}).sort()).toEqual(['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'TZ'])
      expect(spec.stdio).toEqual({
        stdin: 'ignore',
        stdout: { maxBytes: 1_024 },
        stderr: { maxBytes: 1_024 },
      })
      expect(spec.cwd).toContain('/probes/')
    }
    expect(sandbox.policies).toHaveLength(2)
    expect(sandbox.policies.every(policy => policy.mode === 'workspace-write')).toBe(true)
    expect(sandbox.policies.every(policy => policy.workspaceRoot.includes('/probes/'))).toBe(true)
  })

  it('rejects a configured prefix that overlaps the future writable Science root before it creates any scratch', async () => {
    const root = mkdtempSync(join(process.cwd(), '.science-runtime-overlap-'))
    roots.push(root)
    const dshHome = join(root, 'dsh-home')
    const prefix = join(dshHome, 'science')
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(ScienceSessionInvariant)
    await ctx.plugin(ControlledSubprocess)
    await ctx.plugin(DirectSandbox)
    await ctx.plugin(ScienceRuntime, { dshHome, profiles: { overlap: { pythonPrefix: prefix } } })
    const session = ctx.sessions.create(SessionId('science-bind-overlap'), { meta: { agentPreset: 'science' } })
    session.append('science/mode-bound', {
      version: 1,
      mode: { modeId: 'science', presetId: 'science', modeRevision: 'phase-2-test' },
    })

    await expect(ctx.scienceRuntime.bindEnvironment({
      session,
      profileId: ScienceEnvironmentProfileId('overlap'),
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'CONFINEMENT_UNAVAILABLE' })
    expect(session.events.map(event => event.type)).toEqual(['science/mode-bound'])
    expect(existsSync(join(dshHome, 'science'))).toBe(false)
  })

  it('rejects remote execution or partial enforcement before publishing an environment revision', async () => {
    const remoteRoot = mkdtempSync(join(process.cwd(), '.science-runtime-remote-'))
    const partialRoot = mkdtempSync(join(process.cwd(), '.science-runtime-partial-'))
    roots.push(remoteRoot, partialRoot)
    const remotePrefix = createFakePythonPrefix(remoteRoot)
    const remote = await createFastRuntimeHarness(remoteRoot, { fake: { pythonPrefix: remotePrefix } })
    contexts.push(remote.ctx)
    ;(remote.subprocess as unknown as { executionWorld: 'host-local' | 'remote' }).executionWorld = 'remote'
    const remoteSession = createScienceSession(remote.ctx, 'science-remote-world')
    await expect(remote.runtime.bindEnvironment({
      session: remoteSession,
      profileId: ScienceEnvironmentProfileId('fake'),
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'CONFINEMENT_UNAVAILABLE' })
    expect(remote.subprocess.specs).toEqual([])
    expect(existsSync(join(remoteRoot, 'dsh-home', 'science'))).toBe(false)

    const partialPrefix = createFakePythonPrefix(partialRoot)
    const partial = await createFastRuntimeHarness(partialRoot, { fake: { pythonPrefix: partialPrefix } })
    contexts.push(partial.ctx)
    partial.sandbox.enforcement = 'partial'
    const partialSession = createScienceSession(partial.ctx, 'science-partial-enforcement')
    await expect(partial.runtime.bindEnvironment({
      session: partialSession,
      profileId: ScienceEnvironmentProfileId('fake'),
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'CONFINEMENT_UNAVAILABLE' })
    expect(partialSession.events.map(event => event.type)).toEqual(['science/mode-bound'])
  })

  it('records an invalid revision for a missing prefix or invalid retained UTF-8 without spawning user source', async () => {
    const root = mkdtempSync(join(process.cwd(), '.science-runtime-invalid-'))
    roots.push(root)
    const invalidPrefix = createFakePythonPrefix(root, 'invalid')
    const missingPrefix = join(root, 'missing-conda')
    const harness = await createFastRuntimeHarness(root, {
      invalid: { pythonPrefix: invalidPrefix },
      missing: { pythonPrefix: missingPrefix },
    })
    contexts.push(harness.ctx)
    harness.subprocess.utf8Probe = 'invalid'
    const { ctx, runtime, subprocess } = harness
    const invalidSession = createScienceSession(ctx, 'science-bind-invalid-utf8')
    const invalid = await runtime.bindEnvironment({
      session: invalidSession,
      profileId: ScienceEnvironmentProfileId('invalid'),
      signal: new AbortController().signal,
    })
    const missingSession = createScienceSession(ctx, 'science-bind-missing')
    const beforeMissing = subprocess.specs.length
    const missing = await runtime.bindEnvironment({
      session: missingSession,
      profileId: ScienceEnvironmentProfileId('missing'),
      signal: new AbortController().signal,
    })

    expect(invalid).toMatchObject({
      status: 'invalid',
      python: { capability: 'invalid', canonicalPrefix: invalidPrefix, executable: join(invalidPrefix, 'bin', 'python') },
    })
    expect(missing).toMatchObject({
      status: 'invalid',
      python: { capability: 'invalid', configuredPrefix: missingPrefix },
    })
    expect(subprocess.specs).toHaveLength(beforeMissing)
  })

  it('observes a shared Python/R prefix, while an R TMPDIR under a space-containing scratch path fails before a probe starts', async () => {
    const sharedRoot = mkdtempSync(join(process.cwd(), '.science-runtime-shared-'))
    const spaceRoot = mkdtempSync(join(process.cwd(), '.science runtime-r-space-'))
    roots.push(sharedRoot, spaceRoot)
    const sharedPrefix = createFakePythonPrefix(sharedRoot)
    createFakeRPrefix(sharedRoot, sharedPrefix)
    const shared = await createFastRuntimeHarness(sharedRoot, { both: { pythonPrefix: sharedPrefix, rPrefix: sharedPrefix } })
    contexts.push(shared.ctx)
    const sharedSession = createScienceSession(shared.ctx, 'science-bind-shared')
    const environment = await shared.runtime.bindEnvironment({
      session: sharedSession,
      profileId: ScienceEnvironmentProfileId('both'),
      signal: new AbortController().signal,
    })
    expect(environment).toMatchObject({
      status: 'applied',
      python: { capability: 'available', languageVersion: 'Fake Python 3.13.5' },
      r: { capability: 'available', languageVersion: 'Fake R 4.5.0' },
    })

    const rPrefix = createFakeRPrefix(spaceRoot)
    const spaced = await createFastRuntimeHarness(spaceRoot, { r: { rPrefix } })
    contexts.push(spaced.ctx)
    const spacedSession = createScienceSession(spaced.ctx, 'science-bind-r-space')
    await expect(spaced.runtime.bindEnvironment({
      session: spacedSession,
      profileId: ScienceEnvironmentProfileId('r'),
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'CONFINEMENT_UNAVAILABLE' })
    expect(spaced.subprocess.specs).toEqual([])
  })

  it('keeps distinct configured Python and R prefixes distinct, and records an escaping executable as invalid without a probe', async () => {
    const root = mkdtempSync(join(process.cwd(), '.science-runtime-distinct-'))
    const escapingRoot = mkdtempSync(join(process.cwd(), '.science-runtime-escaping-'))
    roots.push(root, escapingRoot)
    const pythonPrefix = createFakePythonPrefix(root)
    const rPrefix = createFakeRPrefix(root)
    const distinct = await createFastRuntimeHarness(root, { both: { pythonPrefix, rPrefix } })
    contexts.push(distinct.ctx)
    const distinctSession = createScienceSession(distinct.ctx, 'science-bind-distinct')
    const environment = await distinct.runtime.bindEnvironment({
      session: distinctSession,
      profileId: ScienceEnvironmentProfileId('both'),
      signal: new AbortController().signal,
    })
    expect(environment).toMatchObject({
      status: 'applied',
      python: { canonicalPrefix: pythonPrefix },
      r: { canonicalPrefix: rPrefix },
    })
    expect(environment.python?.canonicalPrefix).not.toBe(environment.r?.canonicalPrefix)

    const escapingPrefix = createFakePythonPrefix(escapingRoot)
    const candidate = join(escapingPrefix, 'bin', 'python')
    unlinkSync(candidate)
    symlinkSync('/bin/sh', candidate)
    const escaping = await createFastRuntimeHarness(escapingRoot, { escaping: { pythonPrefix: escapingPrefix } })
    contexts.push(escaping.ctx)
    const escapingSession = createScienceSession(escaping.ctx, 'science-bind-escaping')
    const before = escaping.subprocess.specs.length
    const invalid = await escaping.runtime.bindEnvironment({
      session: escapingSession,
      profileId: ScienceEnvironmentProfileId('escaping'),
      signal: new AbortController().signal,
    })
    expect(invalid).toMatchObject({ status: 'invalid', python: { capability: 'invalid' } })
    expect(escaping.subprocess.specs).toHaveLength(before)
  })

  it('holds the exact Session lease until a sibling probe quiesces after an earlier probe failure', async () => {
    const root = mkdtempSync(join(process.cwd(), '.science-runtime-probe-cleanup-'))
    roots.push(root)
    const pythonPrefix = createFakePythonPrefix(root)
    const rPrefix = createFakeRPrefix(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(ScienceSessionInvariant)
    await ctx.plugin(DelayedRVersionSubprocess)
    await ctx.plugin(PythonProbeFailureSandbox)
    await ctx.plugin(ScienceRuntime, {
      dshHome: join(root, 'dsh-home'),
      profiles: { both: { pythonPrefix, rPrefix } },
    })
    const runtime = ctx.scienceRuntime
    const subprocess = ctx.subprocess as DelayedRVersionSubprocess
    const sandbox = ctx.sandbox as PythonProbeFailureSandbox
    const session = createScienceSession(ctx, 'science-probe-cleanup')
    const request = {
      session,
      profileId: ScienceEnvironmentProfileId('both'),
      signal: new AbortController().signal,
    }

    const binding = runtime.bindEnvironment(request)
    await subprocess.rVersionStarted.promise
    await expect(runtime.bindEnvironment(request)).rejects.toMatchObject({ code: 'RUNTIME_BUSY' })

    subprocess.releaseRVersion()
    await expect(binding).rejects.toMatchObject({
      code: 'INFRASTRUCTURE_FAILURE',
      cause: { message: 'injected Python probe failure' },
    })

    sandbox.failPython = false
    await expect(runtime.bindEnvironment(request)).resolves.toMatchObject({ status: 'applied' })
  })
})

describe('Science Runtime configuration', () => {
  it('requires a non-empty, closed profile map with absolute prefixes and a safe integer timeout', () => {
    expect(() => resolveConfig({ profiles: {} })).toThrow(/non-empty/)
    expect(() => resolveConfig({
      profiles: { fake: { pythonPrefix: 'relative' } },
    })).toThrow(/absolute/)
    expect(() => resolveConfig({
      profiles: { fake: { pythonPrefix: '/prefix', extra: true } as never },
    })).toThrow(/unknown field/)
    expect(() => resolveConfig({
      profiles: { fake: { pythonPrefix: '/prefix' } }, timeoutMs: 1.5,
    })).toThrow(/safe integer/)
  })
})
