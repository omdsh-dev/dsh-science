import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { CallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as ScienceSessionDomain from '../src/index.ts'
import {
  foldScience,
  ScienceChartId,
  ScienceEnvironmentProfileId,
  ScienceRunId,
  ScienceScratchKey,
} from '../src/index.ts'
import type { ScienceProjection, ScienceRunStarted } from '../src/index.ts'

const FINGERPRINT = 'b'.repeat(64)
const RUN_ID = ScienceRunId('run-1')
const CHART_ID = ScienceChartId('chart-1')
const OUTCOME_CALL_ID = CallId('call-outcome')

async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(ScienceSessionDomain)
  return ctx
}

function appendModeAndEnvironment(session: Session): void {
  const mode = session.append('science/mode-bound', {
    version: 1,
    mode: { modeId: 'science', presetId: 'science', modeRevision: 'r3' },
  })
  session.append('science/environment-bound', {
    version: 1,
    environment: {
      revision: 1,
      profileId: ScienceEnvironmentProfileId('profile-1'),
      configuredAt: mode.time,
      validatedAt: mode.time,
      status: 'applied',
      python: {
        language: 'python',
        configuredPrefix: '/opt/science',
        canonicalPrefix: '/opt/science',
        executable: '/opt/science/bin/python',
        executableIdentity: 'dev:1-ino:2',
        languageVersion: '3.13.5',
        condaHistorySha256: 'a'.repeat(64),
        bindingFingerprint: FINGERPRINT,
        capability: 'available',
      },
    },
  })
}

function appendRunStart(session: Session): { run: ScienceRunStarted; eventTime: number } {
  const request = session.append('request/header', {
    header: { config: { provider: 'test', model: 'test-model' } },
    reason: 'initial',
  })
  const callId = CallId('call-run')
  const call = session.append('tool/call', {
    turn: 1,
    step: 1,
    callId,
    name: 'run_python',
    arguments: '{}',
  })
  const run: ScienceRunStarted = {
    runId: RUN_ID,
    language: 'python',
    toolCallId: callId,
    requestHeaderSeq: request.seq,
    environmentRevision: 1,
    environmentFingerprint: FINGERPRINT,
    startedAt: call.time,
    codeSha256: 'c'.repeat(64),
    scratchKey: ScienceScratchKey('d'.repeat(64)),
    runDirectoryRef: 'runs/run-1/',
    status: 'running',
  }
  const started = session.append('science/run-started', { version: 1, run })
  return { run, eventTime: started.time }
}

function appendCompleteChain(session: Session): void {
  appendModeAndEnvironment(session)
  const { run, eventTime: runStartedEventTime } = appendRunStart(session)
  const runFinish = session.append('science/run-finished', {
    version: 1,
    run: {
      ...run,
      status: 'success',
      finishedAt: runStartedEventTime,
      exitCode: 0,
      stdoutBytes: 12,
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
    },
  })
  const chartCallId = CallId('call-chart')
  const chartCall = session.append('tool/call', {
    turn: 1,
    step: 1,
    callId: chartCallId,
    name: 'save_chart',
    arguments: '{}',
  })
  const chartSaved = session.append('science/chart-saved', {
    version: 1,
    chart: {
      chartId: CHART_ID,
      logicalName: 'trend',
      version: 1,
      title: 'Trend',
      attachment: {
        attachmentId: AttachmentId('attachment-1'),
        mediaType: 'image/png',
        bytes: 128,
        width: 16,
        height: 9,
      },
      runId: RUN_ID,
      toolCallId: chartCallId,
      requestHeaderSeq: run.requestHeaderSeq,
      environmentRevision: 1,
      environmentFingerprint: FINGERPRINT,
      createdAt: Math.max(runFinish.time, chartCall.time),
    },
  })
  const outcomeCall = session.append('tool/call', {
    turn: 1,
    step: 1,
    callId: OUTCOME_CALL_ID,
    name: 'publish_outcome',
    arguments: '{}',
  })
  session.append('science/outcome-published', {
    version: 1,
    outcome: {
      revision: 1,
      title: 'Result',
      summaryMarkdown: 'The trend is stable.',
      evidence: [{ kind: 'chart', chartId: CHART_ID, version: 1 }],
      publishedAt: Math.max(chartSaved.time, outcomeCall.time),
      toolCallId: OUTCOME_CALL_ID,
      requestHeaderSeq: run.requestHeaderSeq,
      environmentRevisions: [1],
    },
  })
}

function strictProjection(events: readonly SessionEvent[]): ScienceProjection | null {
  const state = foldScience(events)
  if (state.mode === undefined || state.lastScienceEventSeq === undefined) return null
  const outcome = state.outcomes.at(-1) ?? null
  return {
    mode: state.mode,
    environment: state.environments.at(-1) ?? null,
    runs: state.runs,
    charts: state.charts,
    outcome,
    metrics: {
      runCount: state.runs.length,
      successfulRunCount: state.runs.filter(run => run.status === 'success').length,
      chartCount: new Set(state.charts.map(chart => chart.chartId)).size,
      chartVersionCount: state.charts.length,
      outcomeRevision: outcome?.revision ?? 0,
    },
    lastScienceEventSeq: state.lastScienceEventSeq,
  }
}

describe('Science cold replay', () => {
  it('rebuilds the same value from a cold JSON seed as the live projection', async () => {
    const liveCtx = await harness()
    const liveSession = liveCtx.sessions.create(SessionId('science-live'), {
      meta: { agentPreset: 'science' },
    })
    appendCompleteChain(liveSession)
    const live = liveCtx.sessionProjections.snapshot(liveSession).values.science
    expect(live).toEqual(strictProjection(liveSession.events))
    const seed = JSON.parse(JSON.stringify(liveSession.events)) as SessionEvent[]

    const coldCtx = await harness()
    const coldSession = coldCtx.sessions.create(SessionId('science-cold'), {
      seed,
      meta: { agentPreset: 'science' },
    })
    const cold = coldCtx.sessionProjections.snapshot(coldSession).values.science
    expect(cold).toEqual(live)
    expect(cold).toEqual(strictProjection(coldSession.events))
  })

  it('round-trips a projection checkpoint and preserves the cold value', async () => {
    const ctx = await harness()
    const session = ctx.sessions.create(SessionId('science-checkpoint'), {
      meta: { agentPreset: 'science' },
    })
    appendCompleteChain(session)
    const live = ctx.sessionProjections.snapshot(session).values.science
    const checkpoint = JSON.parse(JSON.stringify(
      ctx.sessionProjections.checkpoint(session),
    )) as ReturnType<typeof ctx.sessionProjections.checkpoint>

    expect(ctx.sessionProjections.viewCheckpoint(checkpoint).science).toEqual(live)
  })

  it('discards a version-mismatched checkpoint and refolds the complete log', async () => {
    const ctx = await harness()
    const session = ctx.sessions.create(SessionId('science-checkpoint-version'), {
      meta: { agentPreset: 'science' },
    })
    appendCompleteChain(session)
    const live = ctx.sessionProjections.snapshot(session).values.science
    const checkpoint = ctx.sessionProjections.checkpoint(session)
    const science = checkpoint.science!
    const mismatched = {
      ...checkpoint,
      science: { ...science, ver: science.ver + 1 },
    }

    expect(ctx.sessionProjections.viewCheckpoint(mismatched)).not.toHaveProperty('science')
    expect(ctx.sessionProjections.restoreFloor(mismatched)).toBe(0)
    const restored = ctx.sessionProjections.restore(mismatched, session.events, 0)
    expect(restored.snapshot.values.science).toEqual(live)
    expect(restored.checkpoint.science?.ver).toBe(1)

    const empty = ctx.sessionProjections.restore(mismatched, [], 0)
    expect(empty.snapshot.values.science).toBeNull()
  })

  it('derives interrupted only when cold construction closes an unmatched seed run', async () => {
    const sourceCtx = await harness()
    const source = sourceCtx.sessions.create(SessionId('science-open-source'), {
      meta: { agentPreset: 'science' },
    })
    appendModeAndEnvironment(source)
    appendRunStart(source)
    expect(sourceCtx.sessionProjections.snapshot(source).values.science?.runs[0]?.status).toBe('running')

    const seed = JSON.parse(JSON.stringify(source.events)) as SessionEvent[]
    const resumedCtx = await harness()
    const resumed = resumedCtx.sessions.create(SessionId('science-open-resumed'), {
      seed,
      meta: { agentPreset: 'science' },
    })
    const run = resumedCtx.sessionProjections.snapshot(resumed).values.science?.runs[0]
    expect(run).toMatchObject({
      runId: RUN_ID,
      status: 'interrupted',
      interruptedAtSeq: seed.length,
    })
    expect(resumedCtx.sessionProjections.snapshot(resumed).values.science)
      .toEqual(strictProjection(resumed.events))
  })
})
