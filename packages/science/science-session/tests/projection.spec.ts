import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { CallId } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as ScienceSessionDomain from '../src/index.ts'
import {
  applyScienceProjection,
  applyScienceProjectionState,
  emptyScienceProjectionState,
  scienceProjectionSchema,
  scienceProjectionStateSchema,
  ScienceChartId,
  ScienceEnvironmentProfileId,
  ScienceRunId,
  ScienceScratchKey,
} from '../src/index.ts'
import type {
  ScienceChartVersion,
  ScienceEnvironmentBinding,
  ScienceOutcomePublication,
  ScienceProjection,
  ScienceProjectionState,
  ScienceRunStarted,
  ScienceRunTerminal,
} from '../src/index.ts'

const FINGERPRINT = 'b'.repeat(64)
const RUN_ID = ScienceRunId('run-1')
const CHART_ID = ScienceChartId('chart-1')
const RUN_CALL_ID = CallId('call-run')
const CHART_CALL_ID = CallId('call-chart')
const OUTCOME_CALL_ID = CallId('call-outcome')
const SECOND_CHART_CALL_ID = CallId('call-chart-2')

function event(type: string, seq: number, time: number, data: unknown): SessionEvent {
  return { type, seq, time, data } as unknown as SessionEvent
}

function projectionEvents(): SessionEvent[] {
  const identity = {
    runId: RUN_ID,
    language: 'python' as const,
    toolCallId: RUN_CALL_ID,
    requestHeaderSeq: 2,
    environmentRevision: 1,
    environmentFingerprint: FINGERPRINT,
    startedAt: 139,
    codeSha256: 'c'.repeat(64),
    scratchKey: ScienceScratchKey('d'.repeat(64)),
    runDirectoryRef: 'runs/run-1/',
  }
  return [
    event('science/mode-bound', 0, 100, {
      version: 1,
      mode: { modeId: 'science', presetId: 'science', modeRevision: 'r3' },
    }),
    event('science/environment-bound', 1, 110, {
      version: 1,
      environment: {
        revision: 1,
        profileId: ScienceEnvironmentProfileId('profile-1'),
        configuredAt: 101,
        validatedAt: 109,
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
    }),
    event('science/run-started', 4, 140, { version: 1, run: { ...identity, status: 'running' } }),
    event('science/run-finished', 5, 150, {
      version: 1,
      run: {
        ...identity,
        status: 'success',
        finishedAt: 149,
        exitCode: 0,
        stdoutBytes: 12,
        stderrBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
      },
    }),
    event('science/chart-saved', 7, 170, {
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
        toolCallId: CHART_CALL_ID,
        requestHeaderSeq: 2,
        environmentRevision: 1,
        environmentFingerprint: FINGERPRINT,
        createdAt: 169,
      },
    }),
    event('science/outcome-published', 9, 180, {
      version: 1,
      outcome: {
        revision: 1,
        title: 'Result',
        summaryMarkdown: 'The trend is stable.',
        evidence: [{ kind: 'chart', chartId: CHART_ID, version: 1 }],
        publishedAt: 179,
        toolCallId: OUTCOME_CALL_ID,
        requestHeaderSeq: 2,
        environmentRevisions: [1],
      },
    }),
  ]
}

function environmentEvent(
  overrides: Partial<ScienceEnvironmentBinding> = {},
  seq = 1,
  time = 110,
): SessionEvent {
  const data = projectionEvents()[1]!.data as unknown as { environment: ScienceEnvironmentBinding }
  return event('science/environment-bound', seq, time, {
    version: 1,
    environment: { ...data.environment, ...overrides },
  })
}

function startedEvent(
  overrides: Partial<ScienceRunStarted> = {},
  seq = 4,
  time = 140,
): SessionEvent {
  const data = projectionEvents()[2]!.data as unknown as { run: ScienceRunStarted }
  return event('science/run-started', seq, time, {
    version: 1,
    run: { ...data.run, ...overrides },
  })
}

function finishedEvent(
  overrides: Partial<ScienceRunTerminal> = {},
  seq = 5,
  time = 150,
): SessionEvent {
  const data = projectionEvents()[3]!.data as unknown as { run: ScienceRunTerminal }
  return event('science/run-finished', seq, time, {
    version: 1,
    run: { ...data.run, ...overrides },
  })
}

function chartEvent(
  overrides: Partial<ScienceChartVersion> = {},
  seq = 7,
  time = 170,
): SessionEvent {
  const data = projectionEvents()[4]!.data as unknown as { chart: ScienceChartVersion }
  return event('science/chart-saved', seq, time, {
    version: 1,
    chart: { ...data.chart, ...overrides },
  })
}

function outcomeEvent(
  overrides: Partial<ScienceOutcomePublication> = {},
  seq = 9,
  time = 180,
): SessionEvent {
  const data = projectionEvents()[5]!.data as unknown as { outcome: ScienceOutcomePublication }
  return event('science/outcome-published', seq, time, {
    version: 1,
    outcome: { ...data.outcome, ...overrides },
  })
}

function project(events: readonly SessionEvent[]): ScienceProjection | null {
  return events.reduce<ScienceProjection | null>(applyScienceProjection, null)
}

function projectState(events: readonly SessionEvent[]): ScienceProjectionState {
  return events.reduce<ScienceProjectionState>(
    applyScienceProjectionState,
    emptyScienceProjectionState(),
  )
}

const scienceValue = (ctx: Context, session: Session): ScienceProjection | null | undefined =>
  ctx.sessionProjections.snapshot(session).values.science

describe('Science projection', () => {
  it('projects all six event types and derives stable metrics', () => {
    const state = project(projectionEvents())
    expect(state).toMatchObject({
      mode: { modeId: 'science', presetId: 'science', modeRevision: 'r3' },
      environment: { revision: 1, status: 'applied' },
      runs: [{ runId: RUN_ID, status: 'success' }],
      charts: [{ chartId: CHART_ID, version: 1 }],
      outcome: { revision: 1 },
      metrics: {
        runCount: 1,
        successfulRunCount: 1,
        chartCount: 1,
        chartVersionCount: 1,
        outcomeRevision: 1,
      },
      lastScienceEventSeq: 9,
    })
    expect(scienceProjectionSchema.safeParse(state).success).toBe(true)
  })

  it('retains only pre-mode facts that can constrain later Science replay', () => {
    const unrelated = event('turn/start', 0, 90, { turn: 1 })
    const empty = emptyScienceProjectionState()
    expect(applyScienceProjectionState(empty, unrelated)).toBe(empty)

    for (const type of ['step/start', 'request/header', 'tool/call'] as const) {
      const data = type === 'tool/call'
        ? { turn: 1, step: 1, callId: CallId('pre-mode-call'), name: 'run_python', arguments: '{}' }
        : {}
      const blocked = projectState([event(type, 0, 90, data)])
      expect(blocked.witness).toHaveLength(1)
      expect(applyScienceProjectionState(blocked, projectionEvents()[0]!)).toBe(blocked)
    }

    for (const type of ['user/message', 'assistant/message', 'tool/result'] as const) {
      const data = type === 'tool/result'
        ? { turn: 1, step: 1, message: { source: { callId: CallId('pre-mode-result') } } }
        : {}
      const retained = projectState([event(type, 0, 90, data)])
      expect(retained.witness).toHaveLength(1)
      expect(retained.value).toBeNull()
    }
  })

  it('returns the identical reference for unrelated, unknown, and malformed events', () => {
    const state = project(projectionEvents())
    expect(state).not.toBeNull()
    expect(applyScienceProjection(state, event('turn/start', 10, 190, { turn: 1 }))).toBe(state)
    expect(applyScienceProjection(state, event('science/future-event', 10, 190, {}))).toBe(state)
    expect(applyScienceProjection(state, {
      ...event('science/future-event', 10, 190, {}),
      ignorable: true,
    })).toBe(state)
    expect(applyScienceProjection(state, event('science/environment-bound', 10, 190, {
      version: 1,
      environment: { revision: 2, unexpected: true },
    }))).toBe(state)
    expect(applyScienceProjection(null, event('session/end-seed', 0, 100, {}))).toBeNull()
  })

  it('fails soft for every locally invalid projection transition', () => {
    const events = projectionEvents()
    const modeState = project(events.slice(0, 1))!
    const environmentState = project(events.slice(0, 2))!
    const runningState = project(events.slice(0, 3))!
    const finishedState = project(events.slice(0, 4))!
    const chartedState = project(events.slice(0, 5))!
    const completeState = project(events)!
    const environment = (events[1]!.data as unknown as { environment: ScienceEnvironmentBinding }).environment
    const python = environment.python!
    const invalidEnvironmentState = project([
      events[0]!,
      environmentEvent({
        status: 'invalid',
        python: { ...python, capability: 'invalid', reason: 'invalid binding' },
        failureReason: 'invalid binding',
      }),
    ])!
    const failedState = project([
      ...events.slice(0, 3),
      finishedEvent({ status: 'failed', exitCode: 1, failureCode: 'RUN_FAILED' }),
    ])!
    const secondRunId = ScienceRunId('run-2')
    const secondChartId = ScienceChartId('chart-2')

    const cases: Array<readonly [string, ScienceProjection | null, SessionEvent]> = [
      ['duplicate mode', modeState, event('science/mode-bound', 1, 101, {
        version: 1,
        mode: modeState.mode,
      })],
      ['environment before mode', null, events[1]!],
      ['environment revision gap', modeState, environmentEvent({ revision: 2 })],
      ['applied environment replacement after run', runningState, environmentEvent({ revision: 2 }, 5, 160)],
      ['environment validation after event', modeState, environmentEvent({}, 1, 108)],
      ['run before mode', null, events[2]!],
      ['run before environment', modeState, events[2]!],
      ['run against invalid environment', invalidEnvironmentState, events[2]!],
      ['run environment revision mismatch', environmentState, startedEvent({ environmentRevision: 2 })],
      ['run without language binding', environmentState, startedEvent({ language: 'r' })],
      ['run binding fingerprint mismatch', environmentState, startedEvent({ environmentFingerprint: 'e'.repeat(64) })],
      ['run before environment validation', environmentState, startedEvent({ startedAt: 108 })],
      ['run after event time', environmentState, startedEvent({ startedAt: 141 })],
      ['duplicate run identity', finishedState, startedEvent()],
      ['concurrent run', runningState, startedEvent({
        runId: secondRunId,
        toolCallId: CallId('call-run-2'),
        startedAt: 159,
        runDirectoryRef: 'runs/run-2/',
      }, 5, 160)],
      ['finish before mode', null, events[3]!],
      ['finish without run', environmentState, events[3]!],
      ['finish after terminal', finishedState, events[3]!],
      ['finish identity rewrite', runningState, finishedEvent({ codeSha256: 'e'.repeat(64) })],
      ['finish after event time', runningState, finishedEvent({}, 5, 148)],
      ['chart before mode', null, events[4]!],
      ['chart without successful run', runningState, events[4]!],
      ['chart from failed run', failedState, events[4]!],
      ['chart environment revision mismatch', finishedState, chartEvent({ environmentRevision: 2 })],
      ['chart fingerprint mismatch', finishedState, chartEvent({ environmentFingerprint: 'e'.repeat(64) })],
      ['chart before run finish', finishedState, chartEvent({ createdAt: 148 })],
      ['chart after event time', finishedState, chartEvent({ createdAt: 171 })],
      ['first chart starts at version two', finishedState, chartEvent({ version: 2 })],
      ['chartId reused across logical names', chartedState, chartEvent({
        logicalName: 'other',
        toolCallId: SECOND_CHART_CALL_ID,
        createdAt: 179,
      }, 9, 180)],
      ['chart version changes identity', chartedState, chartEvent({
        chartId: secondChartId,
        version: 2,
        toolCallId: SECOND_CHART_CALL_ID,
        createdAt: 179,
      }, 9, 180)],
      ['chart version skips', chartedState, chartEvent({
        version: 3,
        toolCallId: SECOND_CHART_CALL_ID,
        createdAt: 179,
      }, 9, 180)],
      ['chart version moves creation time backwards', chartedState, chartEvent({
        version: 2,
        toolCallId: SECOND_CHART_CALL_ID,
        createdAt: 168,
      }, 9, 180)],
      ['outcome before mode', null, events[5]!],
      ['outcome revision gap', chartedState, outcomeEvent({ revision: 2 })],
      ['outcome after event time', chartedState, outcomeEvent({ publishedAt: 181 })],
      ['outcome time regression', completeState, outcomeEvent({
        revision: 2,
        publishedAt: 178,
        toolCallId: CallId('call-outcome-2'),
      }, 11, 190)],
      ['outcome missing run', chartedState, outcomeEvent({
        evidence: [{ kind: 'run', runId: ScienceRunId('missing-run') }],
      })],
      ['outcome missing chart', chartedState, outcomeEvent({
        evidence: [{ kind: 'chart', chartId: CHART_ID, version: 2 }],
      })],
      ['outcome omits cited environment', chartedState, outcomeEvent({
        environmentRevisions: [],
      })],
      ['outcome adds uncited environment', chartedState, outcomeEvent({
        environmentRevisions: [1, 2],
      })],
      ['run reuses a consumed tool call', finishedState, startedEvent({
        runId: secondRunId,
        startedAt: 159,
        runDirectoryRef: 'runs/run-2/',
      }, 7, 160)],
      ['chart reuses a consumed tool call', finishedState, chartEvent({
        toolCallId: RUN_CALL_ID,
      })],
      ['outcome reuses a consumed tool call', chartedState, outcomeEvent({
        toolCallId: CHART_CALL_ID,
      })],
    ]

    for (const [name, state, candidate] of cases) {
      expect(applyScienceProjection(state, candidate), name).toBe(state)
    }

    for (const candidate of [
      event('science/mode-bound', -1, 100, { version: 1, mode: modeState.mode }),
      event('science/mode-bound', 0.5, 100, { version: 1, mode: modeState.mode }),
      event('science/mode-bound', 0, -1, { version: 1, mode: modeState.mode }),
      event('science/mode-bound', 0, 0.5, { version: 1, mode: modeState.mode }),
    ]) {
      expect(applyScienceProjection(null, candidate)).toBeNull()
    }
    expect(applyScienceProjection(modeState, environmentEvent({}, 0))).toBe(modeState)

    const invalidAfterRun = environmentEvent({
      revision: 2,
      status: 'invalid',
      python: { ...python, capability: 'invalid', reason: 'invalid binding' },
      failureReason: 'invalid binding',
    }, 5, 160)
    expect(applyScienceProjection(runningState, invalidAfterRun)).not.toBe(runningState)

    const environmentData = projectionEvents()[1]!.data as unknown as {
      environment: ScienceEnvironmentBinding
    }
    const { python: _python, ...withoutPython } = environmentData.environment
    const rEnvironment = event('science/environment-bound', 1, 110, {
      version: 1,
      environment: { ...withoutPython, r: { ...python, language: 'r' } },
    })
    const rState = project([events[0]!, rEnvironment])!
    expect(applyScienceProjection(rState, startedEvent({ language: 'r' }))).not.toBe(rState)

    const messageOutcome = outcomeEvent({
      evidence: [{ kind: 'message', seq: 8 }],
      environmentRevisions: [],
    }, 10)
    expect(applyScienceProjection(chartedState, messageOutcome)).not.toBe(chartedState)
    const runOutcome = outcomeEvent({ evidence: [{ kind: 'run', runId: RUN_ID }] })
    expect(applyScienceProjection(chartedState, runOutcome)).not.toBe(chartedState)

    const chartVersionTwo = chartEvent({
      version: 2,
      toolCallId: SECOND_CHART_CALL_ID,
      createdAt: 179,
    }, 9, 180)
    expect(applyScienceProjection(chartedState, chartVersionTwo)?.charts.map(chart => chart.version))
      .toEqual([1, 2])

    const messageOnlyOutcome = outcomeEvent({
      evidence: [{ kind: 'message', seq: 2 }],
      requestHeaderSeq: 1,
      environmentRevisions: [],
      publishedAt: 129,
    }, 4, 130)
    const messageOnlyState = applyScienceProjection(modeState, messageOnlyOutcome)
    expect(messageOnlyState).not.toBe(modeState)
    expect(messageOnlyState).toMatchObject({
      environment: null,
      outcome: { environmentRevisions: [] },
      lastScienceEventSeq: 4,
    })
    expect(scienceProjectionSchema.safeParse(messageOnlyState).success).toBe(true)
  })

  it('derives seed interruption only for valid open-run boundaries', () => {
    const events = projectionEvents()
    const runningState = project(events.slice(0, 3))!
    for (const time of [-1, 0.5, 100]) {
      expect(applyScienceProjection(
        runningState,
        event('session/end-seed', 5, time, {}),
      )).toBe(runningState)
    }

    const interrupted = applyScienceProjection(
      runningState,
      event('session/end-seed', 5, 150, {}),
    )!
    expect(interrupted.runs).toEqual([expect.objectContaining({
      status: 'interrupted',
      finishedAt: 150,
      interruptedAtSeq: 5,
    })])

    const secondRunId = ScienceRunId('run-2')
    const mixedState = project([
      ...events.slice(0, 4),
      startedEvent({
        runId: secondRunId,
        toolCallId: CallId('call-run-2'),
        startedAt: 159,
        runDirectoryRef: 'runs/run-2/',
      }, 7, 160),
    ])!
    const mixed = applyScienceProjection(mixedState, event('session/end-seed', 8, 170, {}))!
    expect(mixed.runs.map(run => run.status)).toEqual(['success', 'interrupted'])
  })

  it('rejects checkpoint witnesses that cannot replay to the public value', () => {
    const events = projectionEvents()
    const call = (
      seq: number,
      time: number,
      callId: ReturnType<typeof CallId>,
      name: string,
      turn = 1,
      step = 1,
    ): SessionEvent => event('tool/call', seq, time, {
      turn,
      step,
      callId,
      name,
      arguments: '{}',
    })
    const result = (
      seq: number,
      time: number,
      callId: ReturnType<typeof CallId>,
    ): SessionEvent => event('tool/result', seq, time, {
      turn: 1,
      step: 1,
      message: { source: { callId } },
    })

    const terminalEvents = [
      events[0]!,
      events[1]!,
      event('request/header', 2, 120, {}),
      call(3, 130, RUN_CALL_ID, 'run_python'),
      events[2]!,
      events[3]!,
    ]
    const emptyState = emptyScienceProjectionState()
    const headerOnlyState = projectState([event('request/header', 0, 90, {})])
    const modeState = projectState(events.slice(0, 1))
    const environmentState = projectState(events.slice(0, 2))
    const runningState = projectState(terminalEvents.slice(0, 5))
    const terminalState = projectState(terminalEvents)
    const interruptedState = projectState([
      ...terminalEvents.slice(0, 5),
      event('session/end-seed', 5, 150, {}),
    ])
    const chartedState = projectState([
      ...terminalEvents,
      call(6, 160, CHART_CALL_ID, 'save_chart'),
      events[4]!,
    ])
    const completeState = projectState([
      ...terminalEvents,
      call(6, 160, CHART_CALL_ID, 'save_chart'),
      events[4]!,
      call(8, 175, OUTCOME_CALL_ID, 'publish_outcome'),
      events[5]!,
    ])
    const messageOnlyState = projectState([
      events[0]!,
      event('request/header', 1, 110, {}),
      event('assistant/message', 2, 120, {}),
      call(3, 125, OUTCOME_CALL_ID, 'publish_outcome'),
      outcomeEvent({
        evidence: [{ kind: 'message', seq: 2 }],
        requestHeaderSeq: 1,
        environmentRevisions: [],
        publishedAt: 129,
      }, 4, 130),
    ])
    const resultCallId = CallId('call-result')
    const toolMessageState = projectState([
      events[0]!,
      event('request/header', 1, 110, {}),
      call(2, 115, resultCallId, 'bash'),
      result(3, 120, resultCallId),
      call(4, 125, OUTCOME_CALL_ID, 'publish_outcome'),
      outcomeEvent({
        evidence: [{ kind: 'message', seq: 3 }],
        requestHeaderSeq: 1,
        environmentRevisions: [],
        publishedAt: 129,
      }, 5, 130),
    ])
    const supportState = projectState([
      events[0]!,
      event('step/start', 1, 105, { turn: 2, step: 1 }),
      event('user/message', 2, 110, {}),
      event('assistant/message', 3, 115, {}),
      event('request/header', 4, 120, {}),
      call(5, 125, resultCallId, 'bash', 2, 1),
      event('step/end', 6, 130, { turn: 2, step: 1 }),
      result(7, 135, resultCallId),
    ])
    const stepGuardState = projectState([
      events[0]!,
      event('request/header', 1, 110, {}),
      event('assistant/message', 2, 120, {}),
      call(3, 125, OUTCOME_CALL_ID, 'publish_outcome'),
      event('step/end', 4, 127, { turn: 2, step: 1 }),
      outcomeEvent({
        evidence: [{ kind: 'message', seq: 2 }],
        requestHeaderSeq: 1,
        environmentRevisions: [],
        publishedAt: 129,
      }, 5, 130),
    ])
    const gappedTerminalState = projectState([
      ...terminalEvents.slice(0, 4),
      event('turn/start', 4, 135, { turn: 1 }),
      startedEvent({}, 5, 140),
      finishedEvent({}, 6, 150),
    ])

    for (const [name, state] of [
      ['empty', emptyState],
      ['header only', headerOnlyState],
      ['mode', modeState],
      ['environment', environmentState],
      ['running', runningState],
      ['terminal', terminalState],
      ['interrupted', interruptedState],
      ['charted', chartedState],
      ['complete', completeState],
      ['message only', messageOnlyState],
      ['tool-result message', toolMessageState],
      ['support facts', supportState],
      ['unrelated step end', stepGuardState],
      ['gapped terminal', gappedTerminalState],
    ] satisfies Array<readonly [string, ScienceProjectionState]>) {
      expect(scienceProjectionStateSchema.safeParse(state).success, name).toBe(true)
    }

    expect(applyScienceProjectionState(
      completeState,
      event('session/end-seed', 10, 190, {}),
    )).toBe(completeState)
    expect(applyScienceProjectionState(
      completeState,
      event('turn/start', 10, 190, { turn: 2 }),
    )).toBe(completeState)
    expect(applyScienceProjectionState(
      completeState,
      event('science/mode-bound', 10, 190, events[0]!.data),
    )).toBe(completeState)
    expect(applyScienceProjectionState(completeState, {
      ...event('science/mode-bound', 10, 190, events[0]!.data),
      ignorable: true,
    })).toBe(completeState)

    const headerTampered: ScienceProjectionState = {
      ...terminalState,
      value: {
        ...terminalState.value!,
        runs: [{ ...terminalState.value!.runs[0]!, requestHeaderSeq: 3 }],
      },
    }
    expect(scienceProjectionSchema.safeParse(headerTampered.value).success).toBe(true)
    expect(scienceProjectionStateSchema.safeParse(headerTampered).success).toBe(false)

    const replaceWitness = (
      state: ScienceProjectionState,
      type: string,
      change: (candidate: ScienceProjectionState['witness'][number]) =>
      ScienceProjectionState['witness'][number],
    ): ScienceProjectionState => ({
      ...state,
      witness: state.witness.map(candidate => candidate.type === type ? change(candidate) : candidate),
    })
    const callData = (
      candidate: ScienceProjectionState['witness'][number],
    ): { turn: number; step: number; callId: ReturnType<typeof CallId>; name: string } =>
      candidate.data as {
        turn: number
        step: number
        callId: ReturnType<typeof CallId>
        name: string
      }

    const invalidStates: Array<readonly [string, unknown]> = [
      ['undefined state', undefined],
      ['missing state keys', {}],
      ['extra state key', { ...completeState, unexpected: true }],
      ['invalid public value', { ...completeState, value: undefined }],
      ['well-formed but invalid public value', {
        ...completeState,
        value: { ...completeState.value!, lastScienceEventSeq: 1 },
      }],
      ['non-array witness', { ...completeState, witness: null }],
      ['malformed witness event', { ...completeState, witness: [null] }],
      ['missing witness event key', {
        ...completeState,
        witness: [{ seq: 0, time: 100, type: 'science/mode-bound' }],
      }],
      ['extra witness event key', {
        ...completeState,
        witness: completeState.witness.map((candidate, index) => index === 0
          ? { ...candidate, unexpected: true }
          : candidate),
      }],
      ['non-string witness type', {
        ...completeState,
        witness: completeState.witness.map((candidate, index) => index === 0
          ? { ...candidate, type: 1 }
          : candidate),
      }],
      ['required Science witness marked ignorable', {
        ...completeState,
        witness: completeState.witness.map((candidate, index) => index === 0
          ? { ...candidate, ignorable: true }
          : candidate),
      }],
      ['negative witness seq', {
        ...completeState,
        witness: completeState.witness.map((candidate, index) => index === 0
          ? { ...candidate, seq: -1 }
          : candidate),
      }],
      ['unsafe witness seq', {
        ...completeState,
        witness: completeState.witness.map((candidate, index) => index === 0
          ? { ...candidate, seq: Number.MAX_SAFE_INTEGER + 1 }
          : candidate),
      }],
      ['unsafe witness time', {
        ...completeState,
        witness: completeState.witness.map((candidate, index) => index === 0
          ? { ...candidate, time: Number.MAX_SAFE_INTEGER + 1 }
          : candidate),
      }],
      ['unknown witness type', {
        ...completeState,
        witness: completeState.witness.map((candidate, index) => index === 0
          ? { ...candidate, type: 'turn/start' }
          : candidate),
      }],
      ['non-canonical request data', replaceWitness(
        terminalState,
        'request/header',
        candidate => ({ ...candidate, data: { provider: 'secret' } }),
      )],
      ['non-canonical call data', replaceWitness(
        terminalState,
        'tool/call',
        candidate => ({ ...candidate, data: { ...callData(candidate), arguments: '{}' } }),
      )],
      ['non-canonical step-end data', replaceWitness(
        supportState,
        'step/end',
        candidate => ({ ...candidate, data: { turn: 2, step: 1, reason: 'done' } }),
      )],
      ['non-canonical tool-result data', replaceWitness(
        toolMessageState,
        'tool/result',
        candidate => ({
          ...candidate,
          data: { message: { source: { callId: resultCallId }, content: [] } },
        }),
      )],
      ['malformed step-end data', replaceWitness(
        supportState,
        'step/end',
        candidate => ({ ...candidate, data: { turn: '2', step: 1 } }),
      )],
      ['malformed tool-call data', replaceWitness(
        supportState,
        'tool/call',
        candidate => ({ ...candidate, data: { ...callData(candidate), name: 1 } }),
      )],
      ['malformed tool-result data', replaceWitness(
        supportState,
        'tool/result',
        candidate => ({ ...candidate, data: { message: { source: { callId: 1 } } } }),
      )],
      ['deleted authorizing call', {
        ...terminalState,
        witness: terminalState.witness.filter(candidate => candidate.type !== 'tool/call'),
      }],
      ['authorizing call id changed', replaceWitness(
        terminalState,
        'tool/call',
        candidate => ({
          ...candidate,
          data: { ...callData(candidate), callId: CallId('call-other') },
        }),
      )],
      ['authorizing call name changed', replaceWitness(
        terminalState,
        'tool/call',
        candidate => ({ ...candidate, data: { ...callData(candidate), name: 'bash' } }),
      )],
      ['authorizing call time changed', replaceWitness(
        terminalState,
        'tool/call',
        candidate => ({ ...candidate, time: 140 }),
      )],
      ['authorizing step ended', {
        ...gappedTerminalState,
        witness: [
          ...gappedTerminalState.witness.slice(0, 4),
          {
            seq: 4,
            time: 135,
            type: 'step/end',
            data: { turn: 1, step: 1 },
          },
          ...gappedTerminalState.witness.slice(4),
        ],
      }],
      ['step-end identity changed', replaceWitness(
        stepGuardState,
        'step/end',
        candidate => ({ ...candidate, data: { turn: 1, step: 1 } }),
      )],
      ['message event type changed', replaceWitness(
        messageOnlyState,
        'assistant/message',
        candidate => ({ ...candidate, type: 'request/header' }),
      )],
      ['message event time changed', replaceWitness(
        messageOnlyState,
        'assistant/message',
        candidate => ({ ...candidate, time: 130 }),
      )],
      ['witness order changed', {
        ...terminalState,
        witness: [
          terminalState.witness[1]!,
          terminalState.witness[0]!,
          ...terminalState.witness.slice(2),
        ],
      }],
      ['witness seq duplicated', {
        ...terminalState,
        witness: terminalState.witness.map((candidate, index) => index === 1
          ? { ...candidate, seq: terminalState.witness[0]!.seq }
          : candidate),
      }],
      ['irrelevant seed boundary retained', {
        ...modeState,
        witness: [
          ...modeState.witness,
          { seq: 1, time: 110, type: 'session/end-seed', data: {} },
        ],
      }],
      ['public value differs from replay', {
        ...completeState,
        value: {
          ...completeState.value!,
          outcome: {
            ...completeState.value!.outcome!,
            requestHeaderSeq: completeState.value!.outcome!.requestHeaderSeq + 1,
          },
        },
      }],
    ]
    for (const [name, state] of invalidStates) {
      expect(scienceProjectionStateSchema.safeParse(state).success, name).toBe(false)
    }
  })
  it('rejects corrupted projection values at the wire schema', () => {
    const events = projectionEvents()
    const modeState = project(events.slice(0, 1))!
    const environmentState = project(events.slice(0, 2))!
    const runningState = project(events.slice(0, 3))!
    const state = project(events)!
    const interruptedState = applyScienceProjection(
      runningState,
      event('session/end-seed', 5, 150, {}),
    )!
    const interruptedRun = interruptedState.runs[0]!
    const { metrics: _metrics, ...withoutMetrics } = state
    let statusReads = 0
    const unstableInterruptedRun = { ...interruptedRun }
    Object.defineProperty(unstableInterruptedRun, 'status', {
      enumerable: true,
      get: () => {
        statusReads += 1
        return statusReads <= 3 ? 'interrupted' : 'running'
      },
    })

    const secondChart = {
      ...state.charts[0]!,
      version: 2,
      toolCallId: SECOND_CHART_CALL_ID,
      createdAt: 179,
    }
    const validRelations: unknown[] = [
      {
        ...state,
        charts: [state.charts[0], secondChart],
        metrics: { ...state.metrics, chartVersionCount: 2 },
        lastScienceEventSeq: 11,
      },
      {
        ...state,
        outcome: { ...state.outcome, evidence: [{ kind: 'run', runId: RUN_ID }] },
      },
      {
        ...state,
        outcome: {
          ...state.outcome,
          evidence: [{ kind: 'message', seq: 8 }],
          environmentRevisions: [],
        },
        lastScienceEventSeq: 10,
      },
      {
        ...state,
        metrics: {
          outcomeRevision: state.metrics.outcomeRevision,
          chartVersionCount: state.metrics.chartVersionCount,
          chartCount: state.metrics.chartCount,
          successfulRunCount: state.metrics.successfulRunCount,
          runCount: state.metrics.runCount,
        },
      },
    ]

    const currentEnvironment = state.environment!
    const currentPython = currentEnvironment.python!
    const successfulRun = state.runs[0]! as ScienceRunTerminal
    const { python: _currentPython, ...currentEnvironmentWithoutPython } = currentEnvironment
    const rRunningState = {
      ...runningState,
      environment: {
        ...currentEnvironmentWithoutPython,
        r: { ...currentPython, language: 'r' },
      },
      runs: [{ ...runningState.runs[0], language: 'r' }],
    }
    const secondRun = {
      ...successfulRun,
      runId: ScienceRunId('run-2'),
      toolCallId: CallId('call-run-2'),
      environmentRevision: 2,
      runDirectoryRef: 'runs/run-2/',
    }
    const mixedEnvironmentRuns = {
      ...state,
      environment: {
        ...currentEnvironment,
        revision: 2,
        profileId: ScienceEnvironmentProfileId('profile-2'),
      },
      runs: [successfulRun, secondRun],
      charts: [],
      outcome: null,
      metrics: {
        runCount: 2,
        successfulRunCount: 2,
        chartCount: 0,
        chartVersionCount: 0,
        outcomeRevision: 0,
      },
    }
    const oldRunUnderNewAppliedEnvironment = {
      ...state,
      environment: {
        ...currentEnvironment,
        revision: 2,
        profileId: ScienceEnvironmentProfileId('profile-2'),
      },
      charts: [],
      outcome: null,
      metrics: {
        runCount: 1,
        successfulRunCount: 1,
        chartCount: 0,
        chartVersionCount: 0,
        outcomeRevision: 0,
      },
    }
    const oldRunUnderNewInvalidEnvironment = {
      ...oldRunUnderNewAppliedEnvironment,
      environment: {
        ...oldRunUnderNewAppliedEnvironment.environment,
        status: 'invalid',
        python: { ...currentPython, capability: 'invalid', reason: 'binding drift' },
        failureReason: 'binding drift',
      },
    }
    const sequentialTerminalRuns = {
      ...state,
      runs: [
        state.runs[0],
        {
          ...state.runs[0],
          runId: ScienceRunId('run-2'),
          toolCallId: CallId('call-run-2'),
          runDirectoryRef: 'runs/run-2/',
          startedAt: (state.runs[0] as ScienceRunTerminal).finishedAt + 1,
          finishedAt: (state.runs[0] as ScienceRunTerminal).finishedAt + 2,
        },
      ],
      charts: [],
      outcome: null,
      metrics: {
        runCount: 2,
        successfulRunCount: 2,
        chartCount: 0,
        chartVersionCount: 0,
        outcomeRevision: 0,
      },
      lastScienceEventSeq: 9,
    }

    for (const [index, valid] of [
      null,
      modeState,
      environmentState,
      runningState,
      rRunningState,
      interruptedState,
      state,
      ...validRelations,
      oldRunUnderNewInvalidEnvironment,
      sequentialTerminalRuns,
    ].entries()) {
      expect(scienceProjectionSchema.safeParse(valid).success, `valid projection ${String(index)}`)
        .toBe(true)
    }

    const invalidValues: unknown[] = [
      undefined,
      1,
      [],
      {},
      withoutMetrics,
      { ...state, unexpected: true },
      { ...state, mode: { ...state.mode, modeId: 'other' } },
      { ...state, environment: { ...state.environment, status: 'invalid' } },
      { ...state, environment: null },
      { ...runningState, environment: null },
      {
        ...runningState,
        environment: {
          ...currentEnvironment,
          status: 'invalid',
          python: { ...currentPython, capability: 'invalid', reason: 'invalid binding' },
          failureReason: 'invalid binding',
        },
      },
      {
        ...runningState,
        runs: [{ ...runningState.runs[0], environmentFingerprint: 'e'.repeat(64) }],
      },
      {
        ...runningState,
        runs: [{ ...runningState.runs[0], environmentRevision: 2 }],
      },
      {
        ...runningState,
        runs: [{ ...runningState.runs[0], startedAt: currentEnvironment.validatedAt - 1 }],
      },
      oldRunUnderNewAppliedEnvironment,
      mixedEnvironmentRuns,
      { ...state, runs: {} },
      { ...state, runs: [null] },
      { ...state, runs: [{}] },
      { ...state, runs: [{ ...runningState.runs[0], unexpected: true }] },
      { ...state, runs: [{ ...state.runs[0], status: 'unknown' }] },
      { ...state, runs: [{ status: 'interrupted' }] },
      { ...state, runs: [{ ...interruptedRun, finishedAt: '150' }] },
      { ...state, runs: [{ ...interruptedRun, finishedAt: Number.NaN }] },
      { ...state, runs: [{ ...interruptedRun, finishedAt: 138 }] },
      { ...state, runs: [{ ...interruptedRun, interruptedAtSeq: '3' }] },
      { ...state, runs: [{ ...interruptedRun, interruptedAtSeq: Number.NaN }] },
      { ...state, runs: [{ ...interruptedRun, interruptedAtSeq: -1 }] },
      { ...state, charts: {} },
      { ...state, charts: [{ ...state.charts[0], attachment: { mediaType: 'text/plain' } }] },
      { ...state, outcome: { ...state.outcome, evidence: [] } },
      { ...state, lastScienceEventSeq: 1.5 },
      { ...state, lastScienceEventSeq: -1 },
      { ...state, lastScienceEventSeq: 8 },
      { ...state, metrics: null },
      { ...state, metrics: { runCount: 1 } },
      { ...state, metrics: { ...state.metrics, unexpected: 1 } },
      { ...state, metrics: { ...state.metrics, runCount: 99 } },
      { ...state, runs: [state.runs[0], state.runs[0]] },
      {
        ...state,
        runs: [
          runningState.runs[0],
          {
            ...state.runs[0],
            runId: ScienceRunId('run-2'),
            toolCallId: CallId('call-run-2'),
            runDirectoryRef: 'runs/run-2/',
          },
        ],
        charts: [],
        outcome: null,
      },
      {
        ...state,
        runs: [
          runningState.runs[0],
          {
            ...state.runs[0],
            runId: ScienceRunId('run-2'),
            toolCallId: CallId('call-run-2'),
            runDirectoryRef: 'runs/run-2/',
            startedAt: 151,
          },
        ],
        charts: [],
        outcome: null,
        metrics: {
          runCount: 2,
          successfulRunCount: 1,
          chartCount: 0,
          chartVersionCount: 0,
          outcomeRevision: 0,
        },
        lastScienceEventSeq: 9,
      },
      {
        ...state,
        runs: [
          state.runs[0],
          {
            ...state.runs[0],
            runId: ScienceRunId('run-2'),
            toolCallId: CallId('call-run-2'),
            runDirectoryRef: 'runs/run-2/',
            startedAt: (state.runs[0] as ScienceRunTerminal).finishedAt - 1,
          },
        ],
        charts: [],
        outcome: null,
        metrics: {
          runCount: 2,
          successfulRunCount: 2,
          chartCount: 0,
          chartVersionCount: 0,
          outcomeRevision: 0,
        },
        lastScienceEventSeq: 9,
      },
      {
        ...state,
        charts: [{ ...state.charts[0], runId: ScienceRunId('missing-run') }],
      },
      {
        ...state,
        charts: [{ ...state.charts[0], environmentFingerprint: 'e'.repeat(64) }],
      },
      {
        ...state,
        charts: [{ ...state.charts[0], createdAt: successfulRun.finishedAt - 1 }],
      },
      {
        ...state,
        charts: [{ ...state.charts[0], version: 2 }],
      },
      {
        ...state,
        charts: [state.charts[0], {
          ...state.charts[0],
          logicalName: 'other',
          version: 1,
        }],
      },
      {
        ...state,
        charts: [state.charts[0], { ...secondChart, chartId: ScienceChartId('chart-2') }],
        lastScienceEventSeq: 11,
      },
      {
        ...state,
        charts: [state.charts[0], { ...secondChart, version: 3 }],
        lastScienceEventSeq: 11,
      },
      {
        ...state,
        charts: [state.charts[0], { ...secondChart, createdAt: 168 }],
        metrics: { ...state.metrics, chartVersionCount: 2 },
        lastScienceEventSeq: 11,
      },
      {
        ...state,
        outcome: {
          ...state.outcome,
          evidence: [{ kind: 'run', runId: ScienceRunId('missing-run') }],
        },
      },
      {
        ...runningState,
        outcome: {
          ...state.outcome,
          evidence: [{ kind: 'run', runId: RUN_ID }],
        },
        metrics: { ...runningState.metrics, outcomeRevision: 1 },
      },
      {
        ...state,
        outcome: {
          ...state.outcome,
          evidence: [{ kind: 'chart', chartId: CHART_ID, version: 2 }],
        },
      },
      {
        ...state,
        outcome: {
          ...state.outcome,
          evidence: [{ kind: 'run', runId: RUN_ID }],
          publishedAt: successfulRun.finishedAt - 1,
        },
      },
      {
        ...state,
        outcome: {
          ...state.outcome,
          publishedAt: state.charts[0]!.createdAt - 1,
        },
      },
      {
        ...state,
        outcome: { ...state.outcome, environmentRevisions: [] },
      },
      {
        ...state,
        outcome: { ...state.outcome, environmentRevisions: [1, 2] },
      },
      {
        ...state,
        outcome: { ...state.outcome, toolCallId: RUN_CALL_ID },
      },
      {
        ...state,
        charts: [{ ...state.charts[0], toolCallId: RUN_CALL_ID }],
      },
      {
        ...state,
        runs: [{ ...state.runs[0], requestHeaderSeq: state.lastScienceEventSeq }],
      },
      {
        ...state,
        charts: [{ ...state.charts[0], requestHeaderSeq: state.lastScienceEventSeq }],
      },
      {
        ...state,
        outcome: { ...state.outcome, requestHeaderSeq: state.lastScienceEventSeq },
      },
      {
        ...state,
        outcome: {
          ...state.outcome,
          evidence: [{ kind: 'message', seq: state.lastScienceEventSeq }],
          environmentRevisions: [],
        },
      },
      {
        ...interruptedState,
        runs: [{ ...interruptedRun, interruptedAtSeq: interruptedState.lastScienceEventSeq + 1 }],
      },
      { ...state, runs: [unstableInterruptedRun] },
    ]
    for (const [index, value] of invalidValues.entries()) {
      expect(scienceProjectionSchema.safeParse(value).success, `invalid projection ${String(index)}`)
        .toBe(false)
    }
  })

  it('distinguishes an absent key from a registered null value and unregisters on HMR disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const session = ctx.sessions.create()

    expect(ctx.sessionProjections.snapshot(session).values).not.toHaveProperty('science')
    const first = await ctx.plugin(ScienceSessionDomain)
    expect(scienceValue(ctx, session)).toBeNull()

    await first.dispose()
    expect(ctx.sessionProjections.snapshot(session).values).not.toHaveProperty('science')

    const second = await ctx.plugin(ScienceSessionDomain)
    expect(scienceValue(ctx, session)).toBeNull()
    await second.dispose()
  })

  it('waits for an optional projection registry and registers when it appears', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const scienceFiber = await ctx.plugin(ScienceSessionDomain)
    await ctx.plugin(SessionProjectionRegistry)
    const session = ctx.sessions.create()
    expect(scienceValue(ctx, session)).toBeNull()
    await scienceFiber.dispose()
    expect(ctx.sessionProjections.snapshot(session).values).not.toHaveProperty('science')
  })
})
