/**
 * Folded local Conda implementation of the Phase 2 Science Runtime operation
 * service. It has no model-facing Consumer or shipped profile entry.
 *
 * @module @deepseek-ai/dsh-science-runtime
 */

import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ScienceEnvironmentProfileId, replayScience } from '@deepseek-ai/dsh-science-session'
import type {
  ScienceEnvironmentBinding,
  ScienceInterpreterBinding,
  ScienceProjection,
} from '@deepseek-ai/dsh-science-session'
import type {} from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-science-session'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subprocess'
import { configSchema, resolveConfig } from './config.ts'
import type { Config, ConfiguredProfile } from './config.ts'
import { assertProfileRunConfinement, observeProfile, sameObservation } from './environment.ts'
import { confineRun, planRun, settleRun, startCandidate } from './execution.ts'
import { LeaseRegistry, OperationControl } from './lifecycle.ts'
import {
  createRunScratch,
  ensureSessionScratch,
  removeUnpublishedRunScratch,
  scienceSessionScratchRoot,
} from './scratch.ts'
import { ScienceRuntimeError } from './types.ts'
import type {
  BindScienceEnvironmentRequest,
  ScienceRunHandle,
  ScienceRunResult,
  ScienceRuntimeService,
  StartScienceRunRequest,
} from './types.ts'

export type {
  BindScienceEnvironmentRequest,
  ScienceRunHandle,
  ScienceRunOutput,
  ScienceRunResult,
  ScienceRuntimeErrorCode,
  ScienceRuntimeService,
  StartScienceRunRequest,
} from './types.ts'
export { ScienceRuntimeError } from './types.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'science-runtime'
/** Required shared services kept alive through terminal settlement. */
export const inject = ['sessions', 'subprocess', 'sandbox']

declare module '@deepseek-ai/cordis' {
  interface Context {
    scienceRuntime: ScienceRuntime
  }
}

/** Folded local Science Runtime provider with public types free of Host paths. */
export class ScienceRuntime extends Service implements ScienceRuntimeService {
  static inject = inject
  static Config: z<Config> = configSchema

  /** Parsed immutable profile selection owned by this provider. */
  private readonly profiles: ReadonlyMap<string, ConfiguredProfile>
  /** Configured operation deadline. */
  private readonly timeoutMs: number
  /** Explicit or shared-resolver Harness home input. */
  private readonly dshHome: string | undefined
  /** Exact-object reservation and same-id quarantine owner. */
  private readonly leases = new LeaseRegistry()
  private disposing = false

  /**
   * @param ctx - Cordis context providing Session, subprocess, and sandbox services.
   * @param config - Strict local prefix configuration.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'scienceRuntime')
    const resolved = resolveConfig(config)
    this.profiles = resolved.profiles
    this.timeoutMs = resolved.timeoutMs
    this.dshHome = resolved.dshHome
    ctx.effect(() => {
      const stopSessionObserver = ctx.on('session/disposed', (session) => { this.leases.detach(session) }, { global: true })
      return async () => {
        this.disposing = true
        stopSessionObserver()
        await this.leases.disposeAll()
      }
    }, 'science runtime teardown')
  }

  /**
   * Observe one configured existing Conda profile and append its whole-value
   * environment revision. Static unusability becomes an honest `invalid`
   * revision; capability, cancellation, and I/O failures append nothing.
   * @param request - Exact live Session, profile identity, and caller signal.
   * @returns The accepted durable environment revision.
   */
  async bindEnvironment(request: BindScienceEnvironmentRequest): Promise<ScienceEnvironmentBinding> {
    const initial = this.assertSession(request.session)
    this.assertHostLocal()
    const profile = this.profile(String(request.profileId))
    if (initial.runs.length !== 0) {
      throw new ScienceRuntimeError('ENVIRONMENT_NOT_READY', 'Science environment cannot be rebound after the first run')
    }
    const lease = this.reserve(request.session, request.signal)
    try {
      this.assertPrepublication(request.session, lease.control)
      const scratchRoot = await scienceSessionScratchRoot(this.dshHome, request.session)
      await assertProfileRunConfinement(profile, request.session, scratchRoot)
      this.assertPrepublication(request.session, lease.control)
      const sessionScratch = await ensureSessionScratch(this.dshHome, request.session)
      this.assertPrepublication(request.session, lease.control)
      const observed = await observeProfile({
        subprocess: this.ctx.subprocess,
        sandbox: this.ctx.sandbox,
        sessionScratch,
        sessionId: request.session.id,
        signal: lease.control.signal,
      }, profile)
      this.assertPrepublication(request.session, lease.control)
      const current = this.assertSession(request.session)
      if (current.runs.length !== 0) {
        throw new ScienceRuntimeError('ENVIRONMENT_NOT_READY', 'Science environment cannot be rebound after the first run')
      }
      const bindings = [observed.python?.binding, observed.r?.binding].filter(binding => binding !== undefined)
      const failures = bindings.filter(binding => binding.capability !== 'available')
      const now = Date.now()
      const environment: ScienceEnvironmentBinding = {
        revision: (current.environment?.revision ?? 0) + 1,
        profileId: ScienceEnvironmentProfileId(String(request.profileId)),
        configuredAt: now,
        validatedAt: now,
        status: failures.length === 0 ? 'applied' : 'invalid',
        ...(observed.python === undefined ? {} : { python: observed.python.binding }),
        ...(observed.r === undefined ? {} : { r: observed.r.binding }),
        ...(failures.length === 0 ? {} : { failureReason: failures.map(binding => binding.reason).join('; ') }),
      }
      this.assertPrepublication(request.session, lease.control)
      request.session.append('science/environment-bound', { version: 1, environment })
      return environment
    } catch (error) {
      throw this.prepublicationError(lease.control, error)
    } finally {
      this.leases.release(lease)
    }
  }

  /**
   * Publish a direct-argv run start, then settle exactly one matching terminal
   * fact after the shared subprocess provider proves tree quiescence.
   * @param request - Exact live Session, source, authorization facts, and cancellation.
   * @returns A handle exposed only after `science/run-started` committed.
   */
  async startRun(request: StartScienceRunRequest): Promise<ScienceRunHandle> {
    const projection = this.assertSession(request.session)
    this.assertHostLocal()
    const environment = projection.environment
    if (environment === null || environment.status !== 'applied') {
      throw new ScienceRuntimeError('ENVIRONMENT_NOT_READY', 'Science Runtime requires an applied environment')
    }
    if (projection.runs.some(run => run.status === 'running')) {
      throw new ScienceRuntimeError('RUNTIME_BUSY', 'Science Session already has an open run')
    }
    const profile = this.profile(String(environment.profileId))
    const lease = this.reserve(request.session, request.signal)
    let sessionScratch: Awaited<ReturnType<typeof ensureSessionScratch>> | undefined
    let runScratch: Awaited<ReturnType<typeof createRunScratch>> | undefined
    let published = false
    try {
      this.assertPrepublication(request.session, lease.control)
      const plan = planRun(environment, request.language, request.code)
      const scratchRoot = await scienceSessionScratchRoot(this.dshHome, request.session)
      await assertProfileRunConfinement(profile, request.session, scratchRoot)
      sessionScratch = await ensureSessionScratch(this.dshHome, request.session)
      this.assertPrepublication(request.session, lease.control)
      const observed = await observeProfile({
        subprocess: this.ctx.subprocess,
        sandbox: this.ctx.sandbox,
        sessionScratch,
        sessionId: request.session.id,
        signal: lease.control.signal,
      }, profile)
      this.assertPrepublication(request.session, lease.control)
      if (!this.matchesEnvironment(environment, observed.python?.binding, observed.r?.binding)) {
        const drifted = this.reobservedEnvironment(environment, observed.python?.binding, observed.r?.binding)
        request.session.append('science/environment-bound', { version: 1, environment: drifted })
        throw new ScienceRuntimeError('ENVIRONMENT_NOT_READY', 'Science environment changed during run preflight')
      }
      const source = join(sessionScratch.runs, String(plan.runId), request.language === 'python' ? 'code.py' : 'code.R')
      if (request.language === 'r' && join(sessionScratch.runs, String(plan.runId), 'tmp').includes(' ')) {
        throw new ScienceRuntimeError('CONFINEMENT_UNAVAILABLE', 'R run TMPDIR cannot contain an ASCII space')
      }
      const confined = confineRun({
        subprocess: this.ctx.subprocess,
        sandbox: this.ctx.sandbox,
        session: request.session,
        sessionScratch,
        control: lease.control,
      }, plan, source)
      this.assertPrepublication(request.session, lease.control)
      runScratch = await createRunScratch(sessionScratch, plan.runId, request.language, plan.sourceBytes)
      this.assertPrepublication(request.session, lease.control)
      const started = startCandidate(
        plan,
        runScratch,
        request.language,
        environment,
        request.toolCallId,
        request.requestHeaderSeq,
      )
      request.session.append('science/run-started', { version: 1, run: started })
      published = true
      const done = this.settlePublishedRun(lease, request.session, sessionScratch, plan, runScratch, confined, started)
      return {
        runId: plan.runId,
        done,
        cancel: () => { lease.control.cancel() },
      }
    } catch (error) {
      const cleanup = !published && sessionScratch !== undefined && runScratch !== undefined
        ? removeUnpublishedRunScratch(sessionScratch, runScratch)
        : undefined
      try {
        await cleanup
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'science-runtime: unpublished run rollback failed')
      } finally {
        if (!published) this.leases.release(lease)
      }
      throw this.prepublicationError(lease.control, error)
    }
  }

  /** Reserve a non-queuing exact Session lease without leaking a rejected timer. */
  private reserve(session: BindScienceEnvironmentRequest['session'], signal: AbortSignal) {
    const control = new OperationControl(signal, this.timeoutMs)
    try {
      return this.leases.reserve(session, control)
    } catch (error) {
      control.dispose()
      throw error
    }
  }

  /** Resolve one configured profile without exposing the mutable configuration record. */
  private profile(id: string): ConfiguredProfile {
    const profile = this.profiles.get(id)
    if (profile === undefined) {
      throw new ScienceRuntimeError('INVALID_REQUEST', `unknown Science environment profile ${JSON.stringify(id)}`)
    }
    return profile
  }

  /** Refuse all Host-scratch work outside the local subprocess execution world. */
  private assertHostLocal(): void {
    if (this.ctx.subprocess.executionWorld !== 'host-local') {
      throw new ScienceRuntimeError('CONFINEMENT_UNAVAILABLE', 'Science private Host scratch requires a host-local subprocess provider')
    }
  }

  /** Require an exact currently attached Science Session and its strict projection. */
  private assertSession(session: BindScienceEnvironmentRequest['session']): ScienceProjection {
    if (this.disposing) throw new ScienceRuntimeError('SERVICE_DISPOSING', 'Science Runtime is disposing')
    if (this.ctx.sessions.get(session.id) !== session) {
      throw new ScienceRuntimeError('SESSION_NOT_LIVE', 'Science Runtime requires the exact live Session object')
    }
    const projection = replayScience(session.events)
    if (session.header.agentPreset !== 'science' || projection === null) {
      throw new ScienceRuntimeError('ENVIRONMENT_NOT_READY', 'Science mode must be bound before Runtime operations')
    }
    return projection
  }

  /** Recheck exact liveness and caller-controlled pre-publication cancellation. */
  private assertPrepublication(session: BindScienceEnvironmentRequest['session'], control: OperationControl): void {
    if (this.ctx.sessions.get(session.id) !== session) {
      throw new ScienceRuntimeError('SESSION_NOT_LIVE', 'Science Session detached before publication')
    }
    if (!control.signal.aborted) return
    throw this.prepublicationError(control, undefined)
  }

  /** Translate a pre-publication cause without turning a capability failure into an event. */
  private prepublicationError(control: OperationControl, error: unknown): Error {
    if (error instanceof ScienceRuntimeError) return error
    switch (control.cause) {
      case 'timeout':
        return new ScienceRuntimeError('OPERATION_TIMED_OUT', 'Science Runtime operation timed out', { cause: error })
      case 'cancelled':
      case 'service-disposed':
      case 'session-detached':
        return new ScienceRuntimeError('OPERATION_CANCELLED', 'Science Runtime operation was cancelled', { cause: error })
      default:
        return new ScienceRuntimeError('INFRASTRUCTURE_FAILURE', 'Science Runtime operation failed before publication', { cause: error })
    }
  }

  /** Require each re-observed interpreter to retain its accepted binding fingerprint. */
  private matchesEnvironment(
    environment: ScienceEnvironmentBinding,
    python: ScienceInterpreterBinding | undefined,
    r: ScienceInterpreterBinding | undefined,
  ): boolean {
    return sameObservation(environment.python, python) && sameObservation(environment.r, r)
  }

  /** Append a whole invalid or drifted environment revision before refusing a changed run. */
  private reobservedEnvironment(
    environment: ScienceEnvironmentBinding,
    python: ScienceInterpreterBinding | undefined,
    r: ScienceInterpreterBinding | undefined,
  ): ScienceEnvironmentBinding {
    const bindings = [python, r].filter(binding => binding !== undefined)
    const invalid = bindings.some(binding => binding.capability !== 'available')
    const now = Date.now()
    return {
      revision: environment.revision + 1,
      profileId: environment.profileId,
      configuredAt: now,
      validatedAt: now,
      status: invalid ? 'invalid' : 'drifted',
      ...(python === undefined ? {} : { python }),
      ...(r === undefined ? {} : { r }),
      failureReason: invalid ? 'configured environment is no longer usable' : 'configured environment changed during run preflight',
    }
  }

  /** Settle a published run while retaining the exact lease through terminal commit or cleanup. */
  private async settlePublishedRun(
    lease: ReturnType<LeaseRegistry['reserve']>,
    session: StartScienceRunRequest['session'],
    sessionScratch: Awaited<ReturnType<typeof ensureSessionScratch>>,
    plan: ReturnType<typeof planRun>,
    runScratch: Awaited<ReturnType<typeof createRunScratch>>,
    confined: ReturnType<typeof confineRun>,
    started: ReturnType<typeof startCandidate>,
  ): Promise<ScienceRunResult> {
    let releaseAfterEventualQuiescence = false
    try {
      let settled: Awaited<ReturnType<typeof settleRun>>
      try {
        settled = await settleRun({
          subprocess: this.ctx.subprocess,
          sandbox: this.ctx.sandbox,
          session,
          sessionScratch,
          control: lease.control,
        }, started, plan, runScratch, confined)
      } catch (error) {
        if (this.ctx.sessions.get(session.id) !== session) {
          throw new ScienceRuntimeError('SESSION_NOT_LIVE', 'Science Session detached before terminal publication', { cause: error })
        }
        throw new ScienceRuntimeError('TERMINAL_COMMIT_FAILED', 'Science terminal value could not be prepared after quiescence', { cause: error })
      }
      if (!settled.quiescent) {
        const eventual = settled.eventualQuiescence
        if (eventual === undefined) {
          throw new ScienceRuntimeError('QUIESCENCE_UNPROVEN', 'Science subprocess tree did not reach quiescence after termination')
        }
        releaseAfterEventualQuiescence = true
        void eventual.then(
          (quiescent) => {
            if (quiescent) this.leases.release(lease)
          },
          () => {},
        )
        throw new ScienceRuntimeError('QUIESCENCE_UNPROVEN', 'Science subprocess tree did not reach quiescence after termination')
      }
      if (settled.result === undefined) {
        throw new ScienceRuntimeError('QUIESCENCE_UNPROVEN', 'Science subprocess tree did not produce a terminal result after quiescence')
      }
      if (this.ctx.sessions.get(session.id) !== session) {
        throw new ScienceRuntimeError('SESSION_NOT_LIVE', 'Science Session detached before terminal publication')
      }
      try {
        session.append('science/run-finished', { version: 1, run: settled.result.terminal })
      } catch (error) {
        if (this.ctx.sessions.get(session.id) !== session) {
          throw new ScienceRuntimeError('SESSION_NOT_LIVE', 'Science Session detached before terminal publication', { cause: error })
        }
        throw new ScienceRuntimeError('TERMINAL_COMMIT_FAILED', 'Science terminal fact could not be committed', { cause: error })
      }
      return settled.result
    } finally {
      if (!releaseAfterEventualQuiescence) this.leases.release(lease)
    }
  }
}

export default ScienceRuntime
