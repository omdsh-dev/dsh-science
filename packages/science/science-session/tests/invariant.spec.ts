import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import InvariantService, { InvariantError } from '@deepseek-ai/dsh-invariants'
import { CallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import * as ScienceInvariant from '../src/invariant.ts'
import {
  ScienceChartId,
  ScienceEnvironmentProfileId,
  ScienceRunId,
  ScienceScratchKey,
} from '../src/index.ts'
import type { ScienceRunStarted } from '../src/index.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-science-session'
const FINGERPRINT = 'b'.repeat(64)
const RUN_ID = ScienceRunId('run-1')
const CHART_ID = ScienceChartId('chart-1')
const OUTCOME_CALL_ID = CallId('call-outcome')

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantService, { enabled: true })
  await ctx.plugin(ScienceInvariant)
  return ctx
}

function appendMode(session: Session): number {
  return session.append('science/mode-bound', {
    version: 1,
    mode: { modeId: 'science', presetId: 'science', modeRevision: 'r3' },
  }).time
}

function appendLegalChain(session: Session): void {
  const modeTime = appendMode(session)
  session.append('science/environment-bound', {
    version: 1,
    environment: {
      revision: 1,
      profileId: ScienceEnvironmentProfileId('profile-1'),
      configuredAt: modeTime,
      validatedAt: modeTime,
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
  const request = session.append('request/header', {
    header: { config: { provider: 'test', model: 'test-model' } },
    reason: 'initial',
  })
  const runCallId = CallId('call-run')
  const runCall = session.append('tool/call', {
    turn: 1,
    step: 1,
    callId: runCallId,
    name: 'run_python',
    arguments: '{}',
  })
  const run: ScienceRunStarted = {
    runId: RUN_ID,
    language: 'python',
    toolCallId: runCallId,
    requestHeaderSeq: request.seq,
    environmentRevision: 1,
    environmentFingerprint: FINGERPRINT,
    startedAt: runCall.time,
    codeSha256: 'c'.repeat(64),
    scratchKey: ScienceScratchKey('d'.repeat(64)),
    runDirectoryRef: 'runs/run-1/',
    status: 'running',
  }
  const runStart = session.append('science/run-started', { version: 1, run })
  const runFinish = session.append('science/run-finished', {
    version: 1,
    run: {
      ...run,
      status: 'success',
      finishedAt: runStart.time,
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
      requestHeaderSeq: request.seq,
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
      requestHeaderSeq: request.seq,
      environmentRevisions: [1],
    },
  })
}

describe('Science stream invariant', () => {
  it('rejects step, request, and tool activity before mode binding without committing it', async () => {
    const ctx = await setup()
    const cases: Array<readonly [string, (session: Session) => void]> = [
      ['step', (session) => {
        session.append('step/start', { turn: 1, step: 1 })
      }],
      ['request', (session) => {
        session.append('request/header', {
          header: { config: { provider: 'test', model: 'test-model' } },
          reason: 'initial',
        })
      }],
      ['tool', (session) => {
        session.append('tool/call', {
          turn: 1,
          step: 1,
          callId: CallId('call-before-mode'),
          name: 'run_python',
          arguments: '{}',
        })
      }],
    ]

    for (const [name, append] of cases) {
      const session = ctx.sessions.create(SessionId(`science-invariant-${name}-before-mode`), {
        meta: { agentPreset: 'science' },
      })
      expect(() => { append(session) }, name).toThrow(expect.objectContaining<Partial<InvariantError>>({
        code: 'INVARIANT',
        packageName: PACKAGE_NAME,
      }))
      expect(session.events, name).toEqual([])

      appendMode(session)
      expect(session.events.map(event => event.type), name).toEqual(['science/mode-bound'])
    }

    const accepted = ctx.sessions.create(SessionId('science-invariant-header-after-mode'), {
      meta: { agentPreset: 'science' },
    })
    appendMode(accepted)
    expect(() => accepted.append('request/header', {
      header: { config: { provider: 'test', model: 'test-model' } },
      reason: 'initial',
    })).not.toThrow()
  })

  it('seeds sessions that predate invariant installation', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('science-invariant-late-seed'), {
      meta: { agentPreset: 'science' },
    })
    appendLegalChain(session)
    const before = session.seq

    await ctx.plugin(InvariantService, { enabled: true })
    await ctx.plugin(ScienceInvariant)

    expect(() => { appendMode(session) }).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: PACKAGE_NAME,
    }))
    expect(session.seq).toBe(before)
  })

  it('rejects a Science event in a standard session before commit', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('science-invariant-standard'))

    expect(() => {
      appendMode(session)
    }).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: PACKAGE_NAME,
    }))
    expect(session.seq).toBe(0)
    expect(session.events).toEqual([])
  })

  it('accepts a fully typed six-event Science chain', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('science-invariant-valid'), {
      meta: { agentPreset: 'science' },
    })

    expect(() => {
      appendLegalChain(session)
    }).not.toThrow()
    expect(session.events.filter(event => event.type.startsWith('science/')).map(event => event.type)).toEqual([
      'science/mode-bound',
      'science/environment-bound',
      'science/run-started',
      'science/run-finished',
      'science/chart-saved',
      'science/outcome-published',
    ])
  })

  it('does not advance staged fold state after a rejected append', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('science-invariant-transactional'), {
      meta: { agentPreset: 'science' },
    })
    const modeTime = appendMode(session)
    const before = session.seq

    expect(() => session.append('science/environment-bound', {
      version: 1,
      environment: {
        revision: 2,
        profileId: ScienceEnvironmentProfileId('profile-2'),
        configuredAt: modeTime,
        validatedAt: modeTime,
        status: 'invalid',
        python: {
          language: 'python',
          configuredPrefix: '/missing',
          canonicalPrefix: '/missing',
          executable: '/missing/bin/python',
          executableIdentity: 'missing',
          languageVersion: 'unknown',
          condaHistorySha256: 'a'.repeat(64),
          bindingFingerprint: FINGERPRINT,
          capability: 'invalid',
          reason: 'missing interpreter',
        },
        failureReason: 'missing interpreter',
      },
    })).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: PACKAGE_NAME,
    }))
    expect(session.seq).toBe(before)

    expect(() => session.append('science/environment-bound', {
      version: 1,
      environment: {
        revision: 1,
        profileId: ScienceEnvironmentProfileId('profile-1'),
        configuredAt: modeTime,
        validatedAt: modeTime,
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
    })).not.toThrow()
    expect(session.seq).toBe(before + 1)
  })
})
