import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { CallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  applyScienceEvent,
  decodeScienceEnvironment,
  decodeScienceDomainEvent,
  decodeScienceOutcome,
  decodeScienceRunStarted,
  decodeScienceRunTerminal,
  emptyScienceFoldState,
  foldScience,
  isScienceDomainEventType,
  scienceEvidenceKey,
  ScienceChartId,
  ScienceEnvironmentProfileId,
  ScienceRunId,
  ScienceScratchKey,
} from '../src/index.ts'
import type {
  ScienceChartVersion,
  ScienceEnvironmentBinding,
  ScienceInterpreterBinding,
  ScienceModeRef,
  ScienceOutcomePublication,
  ScienceRunStarted,
  ScienceRunTerminal,
} from '../src/index.ts'

const HISTORY_SHA = 'a'.repeat(64)
const FINGERPRINT = 'b'.repeat(64)
const CODE_SHA = 'c'.repeat(64)
const SCRATCH_KEY = ScienceScratchKey('d'.repeat(64))
const RUN_ID = ScienceRunId('run-1')
const CHART_ID = ScienceChartId('chart-1')
const RUN_CALL_ID = CallId('call-run')
const CHART_CALL_ID = CallId('call-chart')
const OUTCOME_CALL_ID = CallId('call-outcome')

const interpreter = (
  overrides: Partial<ScienceInterpreterBinding> = {},
): ScienceInterpreterBinding => ({
  language: 'python',
  configuredPrefix: '/opt/science',
  canonicalPrefix: '/opt/science',
  executable: '/opt/science/bin/python',
  executableIdentity: 'dev:1-ino:2',
  languageVersion: '3.13.5',
  condaHistorySha256: HISTORY_SHA,
  bindingFingerprint: FINGERPRINT,
  capability: 'available',
  ...overrides,
})

const mode = (): ScienceModeRef => ({
  modeId: 'science',
  presetId: 'science',
  modeRevision: 'r3',
})

const environment = (
  overrides: Partial<ScienceEnvironmentBinding> = {},
): ScienceEnvironmentBinding => ({
  revision: 1,
  profileId: ScienceEnvironmentProfileId('profile-1'),
  configuredAt: 101,
  validatedAt: 109,
  status: 'applied',
  python: interpreter(),
  ...overrides,
})

const environmentWithoutPython = (
  overrides: Partial<Omit<ScienceEnvironmentBinding, 'python'>> = {},
): ScienceEnvironmentBinding => {
  const { python: _python, ...withoutPython } = environment()
  return { ...withoutPython, ...overrides }
}

const runStarted = (
  overrides: Partial<ScienceRunStarted> = {},
): ScienceRunStarted => ({
  runId: RUN_ID,
  language: 'python',
  toolCallId: RUN_CALL_ID,
  requestHeaderSeq: 2,
  environmentRevision: 1,
  environmentFingerprint: FINGERPRINT,
  startedAt: 139,
  codeSha256: CODE_SHA,
  scratchKey: SCRATCH_KEY,
  runDirectoryRef: 'runs/run-1/',
  status: 'running',
  ...overrides,
})

const runTerminal = (
  overrides: Partial<ScienceRunTerminal> = {},
): ScienceRunTerminal => ({
  ...runStarted(),
  status: 'success',
  finishedAt: 149,
  exitCode: 0,
  stdoutBytes: 12,
  stderrBytes: 0,
  stdoutTruncated: false,
  stderrTruncated: false,
  ...overrides,
})

const chart = (
  overrides: Partial<ScienceChartVersion> = {},
): ScienceChartVersion => ({
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
    name: 'trend.png',
  },
  runId: RUN_ID,
  toolCallId: CHART_CALL_ID,
  requestHeaderSeq: 2,
  environmentRevision: 1,
  environmentFingerprint: FINGERPRINT,
  createdAt: 169,
  ...overrides,
})

const outcome = (
  overrides: Partial<ScienceOutcomePublication> = {},
): ScienceOutcomePublication => ({
  revision: 1,
  title: 'Result',
  summaryMarkdown: 'The trend is stable.',
  evidence: [{ kind: 'chart', chartId: CHART_ID, version: 1 }],
  publishedAt: 179,
  toolCallId: OUTCOME_CALL_ID,
  requestHeaderSeq: 2,
  environmentRevisions: [1],
  ...overrides,
})

function event(type: string, seq: number, time: number, data: unknown): SessionEvent {
  return { type, seq, time, data } as unknown as SessionEvent
}

function toolResult(seq: number, time: number, callId: ReturnType<typeof CallId>): SessionEvent {
  return event('tool/result', seq, time, {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId,
      content: [{ type: 'text', text: 'done' }],
      isError: false,
    }),
  })
}

function toolCall(
  seq: number,
  time: number,
  callId: ReturnType<typeof CallId>,
  name: string,
): SessionEvent {
  return event('tool/call', seq, time, {
    turn: 1,
    step: 1,
    callId,
    name,
    arguments: '{}',
  })
}

function legalEvents(): SessionEvent[] {
  return [
    event('science/mode-bound', 0, 100, { version: 1, mode: mode() }),
    event('science/environment-bound', 1, 110, { version: 1, environment: environment() }),
    event('request/header', 2, 120, {
      header: { config: { provider: 'test', model: 'test-model' } },
      reason: 'initial',
    }),
    event('tool/call', 3, 130, {
      turn: 1,
      step: 1,
      callId: RUN_CALL_ID,
      name: 'run_python',
      arguments: '{}',
    }),
    event('science/run-started', 4, 140, { version: 1, run: runStarted() }),
    event('science/run-finished', 5, 150, { version: 1, run: runTerminal() }),
    event('tool/call', 6, 160, {
      turn: 1,
      step: 1,
      callId: CHART_CALL_ID,
      name: 'save_chart',
      arguments: '{}',
    }),
    event('science/chart-saved', 7, 170, { version: 1, chart: chart() }),
    event('tool/call', 8, 175, {
      turn: 1,
      step: 1,
      callId: OUTCOME_CALL_ID,
      name: 'publish_outcome',
      arguments: '{}',
    }),
    event('science/outcome-published', 9, 180, { version: 1, outcome: outcome() }),
  ]
}

describe('strict Science fold', () => {
  it('folds one legal chain containing all six Science event types', () => {
    const state = foldScience(legalEvents())

    expect(state.mode).toEqual(mode())
    expect(state.modeBoundSeq).toBe(0)
    expect(state.environments).toEqual([environment()])
    expect(state.runs).toEqual([runTerminal()])
    expect(state.charts).toEqual([chart()])
    expect(state.outcomes).toEqual([outcome()])
    expect(state.nextSeq).toBe(10)
    expect(state.lastScienceEventSeq).toBe(9)
    expect(state.lastScienceTime).toBe(180)
    expect(state.requestHeaders).toEqual([{ seq: 2, time: 120 }])
    expect(state.toolCalls).toEqual([
      { seq: 3, time: 130, callId: RUN_CALL_ID, turn: 1, step: 1, name: 'run_python' },
      { seq: 6, time: 160, callId: CHART_CALL_ID, turn: 1, step: 1, name: 'save_chart' },
      { seq: 8, time: 175, callId: OUTCOME_CALL_ID, turn: 1, step: 1, name: 'publish_outcome' },
    ])
    expect(state.toolResults).toEqual([])
    expect(state.settledToolCallSeqs).toEqual([])
    expect(state.messageFacts).toEqual([])
    expect(state.consumedToolCallSeqs).toEqual([3, 6, 8])
  })

  it('uses strict payload schemas for every Science event', () => {
    const scienceEvents = legalEvents().filter(candidate => candidate.type.startsWith('science/'))
    for (const candidate of scienceEvents) {
      const data = candidate.data as unknown as Record<string, unknown>
      expect(
        () => decodeScienceDomainEvent({
          ...candidate,
          data: { ...data, unexpected: true },
        } as SessionEvent),
        candidate.type,
      ).toThrow()
    }

    expect(() => decodeScienceDomainEvent(event('science/mode-bound', 0, 100, {
      version: 1,
      mode: { ...mode(), unexpected: true },
    }))).toThrow()
    expect(() => decodeScienceDomainEvent({
      ...legalEvents()[0]!,
      ignorable: true,
    })).toThrow(/required, not ignorable/)
    expect(() => decodeScienceDomainEvent(event('science/mode-bound', 0, 100, {
      version: 2,
      mode: mode(),
    }))).toThrow()

    expect(() => decodeScienceDomainEvent(event('science/future-required', 0, 100, {})))
      .toThrow(/unsupported required Science event type/)
    expect(decodeScienceDomainEvent({
      ...event('science/future-ignorable', 0, 100, {}),
      ignorable: true,
    })).toBeUndefined()
    expect(decodeScienceDomainEvent(event('turn/start', 0, 100, {}))).toBeUndefined()
  })

  it('enforces every environment and run cross-field schema rule', () => {
    const invalidEnvironments: unknown[] = [
      environment({ python: interpreter({ reason: 'unexpected' }) }),
      environment({
        status: 'invalid',
        failureReason: 'invalid binding',
        python: interpreter({ capability: 'invalid' }),
      }),
      environmentWithoutPython(),
      environment({ python: interpreter({ language: 'r' }) }),
      environmentWithoutPython({ r: interpreter() }),
      environment({ configuredAt: 110, validatedAt: 109 }),
      environment({
        python: interpreter({ capability: 'invalid', reason: 'invalid binding' }),
      }),
      environment({ failureReason: 'unexpected' }),
      environment({
        status: 'invalid',
        python: interpreter({ capability: 'invalid', reason: 'invalid binding' }),
      }),
      environment({
        status: 'drifted',
        python: interpreter({ capability: 'drifted', reason: 'drifted binding' }),
      }),
    ]
    for (const candidate of invalidEnvironments) {
      expect(() => decodeScienceEnvironment(candidate)).toThrow()
    }

    const invalidStarts: unknown[] = [
      runStarted({ runDirectoryRef: 'runs/not-the-run/' }),
    ]
    for (const candidate of invalidStarts) {
      expect(() => decodeScienceRunStarted(candidate)).toThrow()
    }

    const invalidTerminals: unknown[] = [
      runTerminal({ runDirectoryRef: 'runs/not-the-run/' }),
      runTerminal({ finishedAt: 138 }),
      runTerminal({ exitCode: 1 }),
      runTerminal({ signal: 'TERM' }),
      runTerminal({ failureCode: 'FAILED' }),
      runTerminal({ failureMessage: 'unexpected' }),
      runTerminal({ status: 'failed', exitCode: 1 }),
    ]
    for (const candidate of invalidTerminals) {
      expect(() => decodeScienceRunTerminal(candidate)).toThrow()
    }
    expect(() => decodeScienceRunTerminal(runTerminal({
      status: 'failed',
      exitCode: 1,
      failureCode: 'RUN_FAILED',
      failureMessage: 'expected failure',
    }))).not.toThrow()
  })

  it('enforces outcome normalization and exposes stable vocabulary helpers', () => {
    expect(() => decodeScienceOutcome(outcome({
      evidence: [
        { kind: 'run', runId: RUN_ID },
        { kind: 'chart', chartId: CHART_ID, version: 1 },
        { kind: 'message', seq: 2 },
      ],
    }))).not.toThrow()
    expect(() => decodeScienceOutcome(outcome({
      evidence: [{ kind: 'message', seq: 2 }],
      environmentRevisions: [],
    }))).not.toThrow()

    const invalidOutcomes: unknown[] = [
      outcome({ evidence: [
        { kind: 'run', runId: RUN_ID },
        { kind: 'run', runId: RUN_ID },
      ] }),
      outcome({ environmentRevisions: [1, 1] }),
      outcome({ environmentRevisions: [2, 1] }),
      outcome({ summaryMarkdown: '界'.repeat(12_000) }),
    ]
    for (const candidate of invalidOutcomes) {
      expect(() => decodeScienceOutcome(candidate)).toThrow()
    }

    expect([
      'science/mode-bound',
      'science/environment-bound',
      'science/run-started',
      'science/run-finished',
      'science/chart-saved',
      'science/outcome-published',
    ].every(isScienceDomainEventType)).toBe(true)
    expect(isScienceDomainEventType('science/future-event')).toBe(false)
    expect(scienceEvidenceKey({ kind: 'run', runId: RUN_ID })).toBe(`run:${RUN_ID}`)
    expect(scienceEvidenceKey({ kind: 'chart', chartId: CHART_ID, version: 2 }))
      .toBe(`chart:${CHART_ID}:2`)
    expect(scienceEvidenceKey({ kind: 'message', seq: 7 })).toBe('message:7')
  })

  it('rejects discontinuous revisions, duplicate identities, and backward Science time', () => {
    const badEnvironment = legalEvents()
    badEnvironment[1] = event('science/environment-bound', 1, 110, {
      version: 1,
      environment: environment({ revision: 2 }),
    })
    expect(() => foldScience(badEnvironment)).toThrow(/environment revision must be 1/)

    const badChart = legalEvents()
    badChart[7] = event('science/chart-saved', 7, 170, {
      version: 1,
      chart: chart({ version: 2 }),
    })
    expect(() => foldScience(badChart)).toThrow(/first logical chart version must be 1/)

    const badOutcome = legalEvents()
    badOutcome[9] = event('science/outcome-published', 9, 180, {
      version: 1,
      outcome: outcome({ revision: 2 }),
    })
    expect(() => foldScience(badOutcome)).toThrow(/outcome revision must be 1/)

    const duplicateRun = legalEvents().slice(0, 6)
    duplicateRun.push(event('tool/call', 6, 160, {
      turn: 1,
      step: 2,
      callId: CallId('call-run-again'),
      name: 'run_python',
      arguments: '{}',
    }))
    duplicateRun.push(event('science/run-started', 7, 170, {
      version: 1,
      run: runStarted({ toolCallId: CallId('call-run-again'), startedAt: 169 }),
    }))
    expect(() => foldScience(duplicateRun)).toThrow(/duplicate Science runId/)

    const backward = legalEvents()
    backward[1] = event('science/environment-bound', 1, 99, {
      version: 1,
      environment: environment({ configuredAt: 90, validatedAt: 98 }),
    })
    expect(() => foldScience(backward)).toThrow(/moves time backwards/)
  })

  it('rejects missing or forward references and terminal whole-value rewrites', () => {
    const missingHeader = legalEvents()
    missingHeader[4] = event('science/run-started', 4, 140, {
      version: 1,
      run: runStarted({ requestHeaderSeq: 99 }),
    })
    expect(() => foldScience(missingHeader)).toThrow(/not the latest post-mode request\/header/)

    const missingRun = legalEvents()
    missingRun[7] = event('science/chart-saved', 7, 170, {
      version: 1,
      chart: chart({ runId: ScienceRunId('missing-run') }),
    })
    expect(() => foldScience(missingRun)).toThrow(/successful prior run/)

    const futureEvidence = legalEvents()
    futureEvidence[9] = event('science/outcome-published', 9, 180, {
      version: 1,
      outcome: outcome({ evidence: [{ kind: 'message', seq: 99 }] }),
    })
    expect(() => foldScience(futureEvidence)).toThrow(/message evidence seq 99 is missing/)

    const rewrittenTerminal = legalEvents()
    rewrittenTerminal[5] = event('science/run-finished', 5, 150, {
      version: 1,
      run: runTerminal({ codeSha256: 'e'.repeat(64) }),
    })
    expect(() => foldScience(rewrittenTerminal)).toThrow(/rewrites start-owned fields/)

    const terminal = runTerminal()
    const { stdoutBytes: _stdoutBytes, ...partialTerminal } = terminal
    expect(() => decodeScienceDomainEvent(event('science/run-finished', 5, 150, {
      version: 1,
      run: partialTerminal,
    }))).toThrow()
  })

  it('requires every supporting authorization reference to follow mode binding', () => {
    const runAfterMode = runStarted({ requestHeaderSeq: 3 })
    const terminalAfterMode = runTerminal({ requestHeaderSeq: 3 })
    const validRunPrefix = [
      event('science/mode-bound', 1, 100, { version: 1, mode: mode() }),
      event('science/environment-bound', 2, 110, { version: 1, environment: environment() }),
      event('request/header', 3, 120, {}),
      toolCall(4, 130, RUN_CALL_ID, 'run_python'),
      event('science/run-started', 5, 140, { version: 1, run: runAfterMode }),
      event('science/run-finished', 6, 150, { version: 1, run: terminalAfterMode }),
    ]
    const cases: Array<readonly [string, SessionEvent[], RegExp]> = [
      ['run request header', [
        event('request/header', 0, 90, {}),
        event('science/mode-bound', 1, 100, { version: 1, mode: mode() }),
        event('science/environment-bound', 2, 110, { version: 1, environment: environment() }),
        toolCall(3, 130, RUN_CALL_ID, 'run_python'),
        event('science/run-started', 4, 140, {
          version: 1,
          run: runStarted({ requestHeaderSeq: 0 }),
        }),
      ], /cannot follow pre-mode/],
      ['run tool call', [
        toolCall(0, 90, RUN_CALL_ID, 'run_python'),
        event('science/mode-bound', 1, 100, { version: 1, mode: mode() }),
        event('science/environment-bound', 2, 110, { version: 1, environment: environment() }),
        event('request/header', 3, 120, {}),
        event('science/run-started', 4, 140, {
          version: 1,
          run: runStarted({ requestHeaderSeq: 3 }),
        }),
      ], /cannot follow pre-mode/],
      ['chart request header', [
        event('request/header', 0, 90, {}),
        ...validRunPrefix,
        toolCall(7, 160, CHART_CALL_ID, 'save_chart'),
        event('science/chart-saved', 8, 170, {
          version: 1,
          chart: chart({ requestHeaderSeq: 0 }),
        }),
      ], /cannot follow pre-mode/],
      ['chart tool call', [
        toolCall(0, 90, CHART_CALL_ID, 'save_chart'),
        ...validRunPrefix,
        event('science/chart-saved', 7, 170, {
          version: 1,
          chart: chart({ requestHeaderSeq: 3 }),
        }),
      ], /cannot follow pre-mode/],
      ['outcome request header', [
        event('request/header', 0, 90, {}),
        event('science/mode-bound', 1, 100, { version: 1, mode: mode() }),
        event('science/environment-bound', 2, 110, { version: 1, environment: environment() }),
        event('assistant/message', 3, 120, {}),
        event('science/outcome-published', 4, 130, {
          version: 1,
          outcome: outcome({
            evidence: [{ kind: 'message', seq: 3 }],
            publishedAt: 129,
            requestHeaderSeq: 0,
          }),
        }),
      ], /cannot follow pre-mode/],
    ]

    for (const [name, events, pattern] of cases) {
      expect(() => foldScience(events), name).toThrow(pattern)
    }
  })

  it('requires the latest request header and a later matching tool call', () => {
    const staleHeader = [
      ...legalEvents().slice(0, 3),
      event('request/header', 3, 125, {}),
      toolCall(4, 130, RUN_CALL_ID, 'run_python'),
      event('science/run-started', 5, 140, {
        version: 1,
        run: runStarted({ requestHeaderSeq: 2 }),
      }),
    ]
    expect(() => foldScience(staleHeader)).toThrow(/not the latest post-mode request\/header/)

    const callBeforeHeader = [
      ...legalEvents().slice(0, 2),
      toolCall(2, 115, RUN_CALL_ID, 'run_python'),
      event('request/header', 3, 120, {}),
      event('science/run-started', 4, 140, {
        version: 1,
        run: runStarted({ requestHeaderSeq: 3 }),
      }),
    ]
    expect(() => foldScience(callBeforeHeader)).toThrow(/does not identify one call after its cited request\/header/)
  })

  it('consumes each authorizing tool call once and rejects already settled calls', () => {
    const secondRun = runStarted({
      runId: ScienceRunId('run-2'),
      startedAt: 159,
      runDirectoryRef: 'runs/run-2/',
    })
    const reuseCases: Array<readonly [string, SessionEvent[]]> = [
      ['second run', [
        ...legalEvents().slice(0, 6),
        event('science/run-started', 6, 160, { version: 1, run: secondRun }),
      ]],
      ['chart', [
        ...legalEvents().slice(0, 8),
        event('science/chart-saved', 8, 180, {
          version: 1,
          chart: chart({ version: 2, createdAt: 179 }),
        }),
      ]],
      ['outcome', [
        ...legalEvents(),
        event('science/outcome-published', 10, 190, {
          version: 1,
          outcome: outcome({ revision: 2, publishedAt: 189 }),
        }),
      ]],
    ]
    for (const [name, events] of reuseCases) {
      expect(() => foldScience(events), name).toThrow(/already consumed by a Science fact/)
    }

    const settledCases: Array<readonly [string, SessionEvent[]]> = [
      ['run', [
        ...legalEvents().slice(0, 4),
        toolResult(4, 135, RUN_CALL_ID),
        event('science/run-started', 5, 140, { version: 1, run: runStarted() }),
      ]],
      ['chart', [
        ...legalEvents().slice(0, 7),
        toolResult(7, 165, CHART_CALL_ID),
        event('science/chart-saved', 8, 170, { version: 1, chart: chart() }),
      ]],
      ['outcome', [
        ...legalEvents().slice(0, 9),
        toolResult(9, 177, OUTCOME_CALL_ID),
        event('science/outcome-published', 10, 180, { version: 1, outcome: outcome() }),
      ]],
    ]
    for (const [name, events] of settledCases) {
      expect(() => foldScience(events), name).toThrow(/already settled before its Science fact/)
    }

    expect(() => foldScience([
      ...legalEvents().slice(0, 8),
      event('science/outcome-published', 8, 180, { version: 1, outcome: outcome() }),
    ])).toThrow(/does not identify one call after its cited request\/header/)
  })

  it('rejects a Science fact after its authorizing tool call step has ended', () => {
    const cases: Array<readonly [string, SessionEvent[]]> = [
      ['run', [
        ...legalEvents().slice(0, 4),
        event('step/end', 4, 135, { turn: 1, step: 1 }),
        event('science/run-started', 5, 140, { version: 1, run: runStarted() }),
      ]],
      ['chart', [
        ...legalEvents().slice(0, 7),
        event('step/end', 7, 165, { turn: 1, step: 1 }),
        event('science/chart-saved', 8, 170, { version: 1, chart: chart() }),
      ]],
      ['outcome', [
        ...legalEvents().slice(0, 9),
        event('step/end', 9, 177, { turn: 1, step: 1 }),
        event('science/outcome-published', 10, 180, { version: 1, outcome: outcome() }),
      ]],
    ]

    for (const [name, events] of cases) {
      expect(() => foldScience(events), name).toThrow()
    }

    expect(foldScience([
      ...legalEvents().slice(0, 4),
      event('step/end', 4, 135, { turn: 2, step: 1 }),
      event('science/run-started', 5, 140, { version: 1, run: runStarted() }),
    ]).runs).toEqual([runStarted()])
  })

  it('requires the operation-specific tool name and accepts the R runner name', () => {
    const wrongNames: Array<readonly [string, SessionEvent[], RegExp]> = [
      ['run', legalEvents().slice(0, 5).map((candidate, index) => index === 3
        ? toolCall(3, 130, RUN_CALL_ID, 'bash')
        : candidate), /expected run_python/],
      ['chart', legalEvents().slice(0, 8).map((candidate, index) => index === 6
        ? toolCall(6, 160, CHART_CALL_ID, 'bash')
        : candidate), /expected save_chart/],
      ['outcome', legalEvents().map((candidate, index) => index === 8
        ? toolCall(8, 175, OUTCOME_CALL_ID, 'bash')
        : candidate), /expected publish_outcome/],
    ]
    for (const [name, events, pattern] of wrongNames) {
      expect(() => foldScience(events), name).toThrow(pattern)
    }

    const rRun = runStarted({ language: 'r' })
    const rEvents = [
      legalEvents()[0]!,
      event('science/environment-bound', 1, 110, {
        version: 1,
        environment: environmentWithoutPython({
          r: interpreter({ language: 'r' }),
        }),
      }),
      legalEvents()[2]!,
      toolCall(3, 130, RUN_CALL_ID, 'run_r'),
      event('science/run-started', 4, 140, { version: 1, run: rRun }),
    ]
    expect(foldScience(rEvents).runs).toEqual([rRun])
  })

  it('requires payload times to follow every authorizing and cited event', () => {
    const runCases: Array<readonly [string, SessionEvent[]]> = [
      ['request header', legalEvents().slice(0, 5).map((candidate, index) => index === 4
        ? event('science/run-started', 4, 140, {
          version: 1,
          run: runStarted({ startedAt: 119 }),
        })
        : candidate)],
      ['tool call', legalEvents().slice(0, 5).map((candidate, index) => index === 4
        ? event('science/run-started', 4, 140, {
          version: 1,
          run: runStarted({ startedAt: 129 }),
        })
        : candidate)],
    ]
    for (const [name, events] of runCases) {
      expect(() => foldScience(events), name).toThrow(/supporting-fact event interval/)
    }

    expect(() => foldScience([
      ...legalEvents().slice(0, 5),
      event('science/run-finished', 5, 150, {
        version: 1,
        run: runTerminal({ finishedAt: 139 }),
      }),
    ])).toThrow(/durable start-to-finish event interval/)

    const chartTimeCases: Array<readonly [string, SessionEvent[]]> = [
      ['request header', [
        ...legalEvents().slice(0, 6),
        event('request/header', 6, 165, {}),
        toolCall(7, 160, CHART_CALL_ID, 'save_chart'),
        event('science/chart-saved', 8, 170, {
          version: 1,
          chart: chart({ requestHeaderSeq: 6, createdAt: 164 }),
        }),
      ]],
      ['tool call', legalEvents().slice(0, 8).map((candidate, index) => index === 7
        ? event('science/chart-saved', 7, 170, {
          version: 1,
          chart: chart({ createdAt: 159 }),
        })
        : candidate)],
      ['source terminal event', [
        ...legalEvents().slice(0, 5),
        event('science/run-finished', 5, 165, { version: 1, run: runTerminal() }),
        toolCall(6, 150, CHART_CALL_ID, 'save_chart'),
        event('science/chart-saved', 7, 170, {
          version: 1,
          chart: chart({ createdAt: 164 }),
        }),
      ]],
    ]
    for (const [name, events] of chartTimeCases) {
      expect(() => foldScience(events), name).toThrow(/supporting-fact event interval/)
    }

    const outcomeTimeCases: Array<readonly [string, SessionEvent[], RegExp]> = [
      ['request header', [
        ...legalEvents().slice(0, 8),
        event('request/header', 8, 178, {}),
        toolCall(9, 175, OUTCOME_CALL_ID, 'publish_outcome'),
        event('science/outcome-published', 10, 180, {
          version: 1,
          outcome: outcome({ requestHeaderSeq: 8, publishedAt: 177 }),
        }),
      ], /authorizing facts/],
      ['tool call', [
        ...legalEvents().slice(0, 9),
        event('science/outcome-published', 9, 180, {
          version: 1,
          outcome: outcome({ publishedAt: 174 }),
        }),
      ], /authorizing facts/],
      ['run evidence', [
        ...legalEvents().slice(0, 6),
        toolCall(6, 145, OUTCOME_CALL_ID, 'publish_outcome'),
        event('science/outcome-published', 7, 160, {
          version: 1,
          outcome: outcome({
            evidence: [{ kind: 'run', runId: RUN_ID }],
            publishedAt: 149,
          }),
        }),
      ], /precedes cited run evidence/],
      ['chart evidence', [
        ...legalEvents().slice(0, 8),
        toolCall(8, 165, OUTCOME_CALL_ID, 'publish_outcome'),
        event('science/outcome-published', 9, 180, {
          version: 1,
          outcome: outcome({ publishedAt: 169 }),
        }),
      ], /precedes cited chart evidence/],
      ['message evidence', [
        legalEvents()[0]!,
        event('request/header', 1, 110, {}),
        event('assistant/message', 2, 130, {}),
        toolCall(3, 120, OUTCOME_CALL_ID, 'publish_outcome'),
        event('science/outcome-published', 4, 140, {
          version: 1,
          outcome: outcome({
            evidence: [{ kind: 'message', seq: 2 }],
            publishedAt: 129,
            requestHeaderSeq: 1,
            environmentRevisions: [],
          }),
        }),
      ], /precedes cited message evidence/],
    ]
    for (const [name, events, pattern] of outcomeTimeCases) {
      expect(() => foldScience(events), name).toThrow(pattern)
    }
  })

  it('accepts a message-only outcome without environment provenance', () => {
    const events = [
      legalEvents()[0]!,
      event('request/header', 1, 110, {}),
      event('assistant/message', 2, 120, {}),
      toolCall(3, 125, OUTCOME_CALL_ID, 'publish_outcome'),
      event('science/outcome-published', 4, 130, {
        version: 1,
        outcome: outcome({
          evidence: [{ kind: 'message', seq: 2 }],
          publishedAt: 129,
          requestHeaderSeq: 1,
          environmentRevisions: [],
        }),
      }),
    ]

    expect(foldScience(events).outcomes).toEqual([
      outcome({
        evidence: [{ kind: 'message', seq: 2 }],
        publishedAt: 129,
        requestHeaderSeq: 1,
        environmentRevisions: [],
      }),
    ])
  })

  it('rejects every strict transition discontinuity without mutating the contract', () => {
    const secondCall = CallId('call-second')
    const secondRunId = ScienceRunId('run-2')
    const invalidEnvironment = environment({
      revision: 2,
      profileId: ScienceEnvironmentProfileId('profile-2'),
      configuredAt: 111,
      validatedAt: 119,
      status: 'invalid',
      python: interpreter({ capability: 'invalid', reason: 'invalid binding' }),
      failureReason: 'invalid binding',
    })
    const latestInvalid = [
      ...legalEvents().slice(0, 2),
      event('science/environment-bound', 2, 120, { version: 1, environment: invalidEnvironment }),
      event('request/header', 3, 130, {}),
      toolCall(4, 140, RUN_CALL_ID, 'run_python'),
      event('science/run-started', 5, 150, {
        version: 1,
        run: runStarted({ requestHeaderSeq: 3, startedAt: 149 }),
      }),
    ]
    const secondChart = (overrides: Partial<ScienceChartVersion>): SessionEvent[] => [
      ...legalEvents().slice(0, 8),
      toolCall(8, 180, secondCall, 'save_chart'),
      event('science/chart-saved', 9, 190, {
        version: 1,
        chart: chart({
          toolCallId: secondCall,
          createdAt: 189,
          ...overrides,
        }),
      }),
    ]

    const cases: Array<readonly [string, SessionEvent[], RegExp]> = [
      ['duplicate mode', [
        legalEvents()[0]!,
        event('science/mode-bound', 1, 110, { version: 1, mode: mode() }),
      ], /bound only once/],
      ['mode after step start', [
        event('step/start', 0, 90, { turn: 1, step: 1 }),
        event('science/mode-bound', 1, 100, { version: 1, mode: mode() }),
      ], /cannot follow pre-mode step\/start/],
      ['environment before mode', [
        event('science/environment-bound', 0, 110, { version: 1, environment: environment() }),
      ], /prior mode binding/],
      ['applied environment after a run', [
        ...legalEvents().slice(0, 6),
        event('science/environment-bound', 6, 160, {
          version: 1,
          environment: environment({
            revision: 2,
            profileId: ScienceEnvironmentProfileId('profile-2'),
            configuredAt: 151,
            validatedAt: 159,
          }),
        }),
      ], /cannot be replaced/],
      ['environment validation after event', [
        legalEvents()[0]!,
        event('science/environment-bound', 1, 108, { version: 1, environment: environment() }),
      ], /validation time/],
      ['run before mode', [
        event('science/run-started', 0, 140, { version: 1, run: runStarted() }),
      ], /prior mode binding/],
      ['run without tool call', legalEvents().slice(0, 5).map((candidate, index) => index === 4
        ? event('science/run-started', 4, 140, {
          version: 1,
          run: runStarted({ toolCallId: CallId('missing-call') }),
        })
        : candidate), /does not identify one call after its cited request\/header/],
      ['run without environment', legalEvents().slice(0, 5).map((candidate, index) => index === 4
        ? event('science/run-started', 4, 140, {
          version: 1,
          run: runStarted({ environmentRevision: 2 }),
        })
        : candidate), /revision 2 does not exist/],
      ['run against old environment', latestInvalid, /latest applied environment/],
      ['run without R binding', legalEvents().slice(0, 5).map((candidate, index) => index === 4
        ? event('science/run-started', 4, 140, {
          version: 1,
          run: runStarted({ language: 'r' }),
        })
        : candidate), /available environment binding/],
      ['run fingerprint mismatch', legalEvents().slice(0, 5).map((candidate, index) => index === 4
        ? event('science/run-started', 4, 140, {
          version: 1,
          run: runStarted({ environmentFingerprint: 'e'.repeat(64) }),
        })
        : candidate), /available environment binding/],
      ['run before validation', legalEvents().slice(0, 5).map((candidate, index) => index === 4
        ? event('science/run-started', 4, 140, {
          version: 1,
          run: runStarted({ startedAt: 108 }),
        })
        : candidate), /start time/],
      ['run after event', legalEvents().slice(0, 5).map((candidate, index) => index === 4
        ? event('science/run-started', 4, 140, {
          version: 1,
          run: runStarted({ startedAt: 141 }),
        })
        : candidate), /start time/],
      ['concurrent run', [
        ...legalEvents().slice(0, 5),
        toolCall(5, 150, secondCall, 'run_python'),
        event('science/run-started', 6, 160, {
          version: 1,
          run: runStarted({
            runId: secondRunId,
            toolCallId: secondCall,
            startedAt: 159,
            runDirectoryRef: 'runs/run-2/',
          }),
        }),
      ], /only one Science run/],
      ['finish without start', [
        event('science/run-finished', 0, 150, { version: 1, run: runTerminal() }),
      ], /no matching start/],
      ['finish after terminal', [
        ...legalEvents().slice(0, 6),
        event('science/run-finished', 6, 160, { version: 1, run: runTerminal() }),
      ], /already terminal/],
      ['finish after event', [
        ...legalEvents().slice(0, 5),
        event('science/run-finished', 5, 148, { version: 1, run: runTerminal() }),
      ], /finish time/],
      ['chart before mode', [
        event('science/chart-saved', 0, 170, { version: 1, chart: chart() }),
      ], /prior mode binding/],
      ['chart from running run', [
        ...legalEvents().slice(0, 5),
        toolCall(5, 150, CHART_CALL_ID, 'save_chart'),
        event('science/chart-saved', 6, 160, {
          version: 1,
          chart: chart({ createdAt: 159 }),
        }),
      ], /successful prior run/],
      ['chart without tool call', legalEvents().slice(0, 8).map((candidate, index) => index === 7
        ? event('science/chart-saved', 7, 170, {
          version: 1,
          chart: chart({ toolCallId: CallId('missing-call') }),
        })
        : candidate), /does not identify one call after its cited request\/header/],
      ['chart environment revision mismatch', legalEvents().slice(0, 8).map((candidate, index) => index === 7
        ? event('science/chart-saved', 7, 170, {
          version: 1,
          chart: chart({ environmentRevision: 2 }),
        })
        : candidate), /environment provenance/],
      ['chart fingerprint mismatch', legalEvents().slice(0, 8).map((candidate, index) => index === 7
        ? event('science/chart-saved', 7, 170, {
          version: 1,
          chart: chart({ environmentFingerprint: 'e'.repeat(64) }),
        })
        : candidate), /environment provenance/],
      ['chart before run finish', legalEvents().slice(0, 8).map((candidate, index) => index === 7
        ? event('science/chart-saved', 7, 170, { version: 1, chart: chart({ createdAt: 148 }) })
        : candidate), /creation time/],
      ['chart after event', legalEvents().slice(0, 8).map((candidate, index) => index === 7
        ? event('science/chart-saved', 7, 170, { version: 1, chart: chart({ createdAt: 171 }) })
        : candidate), /creation time/],
      ['chartId reused for another logical chart', secondChart({ logicalName: 'other' }), /two logical charts/],
      ['chart version changes identity', secondChart({ chartId: ScienceChartId('chart-2'), version: 2 }), /advance contiguously/],
      ['chart version skips', secondChart({ version: 3 }), /advance contiguously/],
      ['chart version moves creation time backwards', [
        ...legalEvents().slice(0, 8),
        toolCall(8, 168, secondCall, 'save_chart'),
        event('science/chart-saved', 9, 190, {
          version: 1,
          chart: chart({
            version: 2,
            toolCallId: secondCall,
            createdAt: 168,
          }),
        }),
      ], /advance contiguously/],
      ['outcome before mode', [
        event('science/outcome-published', 0, 180, { version: 1, outcome: outcome() }),
      ], /prior mode binding/],
      ['outcome after event', legalEvents().map((candidate, index) => index === 9
        ? event('science/outcome-published', 9, 180, {
          version: 1,
          outcome: outcome({ publishedAt: 181 }),
        })
        : candidate), /publication time/],
      ['outcome time regresses', [
        ...legalEvents(),
        toolCall(10, 185, CallId('call-outcome-2'), 'publish_outcome'),
        event('science/outcome-published', 11, 190, {
          version: 1,
          outcome: outcome({
            revision: 2,
            publishedAt: 178,
            toolCallId: CallId('call-outcome-2'),
          }),
        }),
      ], /publication time/],
      ['outcome environment missing', legalEvents().map((candidate, index) => index === 9
        ? event('science/outcome-published', 9, 180, {
          version: 1,
          outcome: outcome({ environmentRevisions: [2] }),
        })
        : candidate), /revision 2 does not exist/],
      ['outcome environment not applied', [
        legalEvents()[0]!,
        event('science/environment-bound', 1, 110, {
          version: 1,
          environment: environment({
            status: 'invalid',
            python: interpreter({ capability: 'invalid', reason: 'invalid binding' }),
            failureReason: 'invalid binding',
          }),
        }),
        event('request/header', 2, 120, {}),
        event('assistant/message', 3, 130, {}),
        toolCall(4, 135, OUTCOME_CALL_ID, 'publish_outcome'),
        event('science/outcome-published', 5, 140, {
          version: 1,
          outcome: outcome({
            evidence: [{ kind: 'message', seq: 3 }],
            publishedAt: 139,
          }),
        }),
      ], /environment revision 1 was not applied/],
      ['outcome run evidence missing', legalEvents().map((candidate, index) => index === 9
        ? event('science/outcome-published', 9, 180, {
          version: 1,
          outcome: outcome({ evidence: [{ kind: 'run', runId: ScienceRunId('missing-run') }] }),
        })
        : candidate), /not a successful prior run/],
      ['outcome run evidence not terminal', [
        ...legalEvents().slice(0, 5),
        toolCall(5, 145, OUTCOME_CALL_ID, 'publish_outcome'),
        event('science/outcome-published', 6, 150, {
          version: 1,
          outcome: outcome({
            evidence: [{ kind: 'run', runId: RUN_ID }],
            publishedAt: 149,
          }),
        }),
      ], /not a successful prior run/],
      ['outcome chart evidence missing', legalEvents().map((candidate, index) => index === 9
        ? event('science/outcome-published', 9, 180, {
          version: 1,
          outcome: outcome({ evidence: [{ kind: 'chart', chartId: CHART_ID, version: 2 }] }),
        })
        : candidate), /chart evidence/],
      ['outcome message evidence missing', legalEvents().map((candidate, index) => index === 9
        ? event('science/outcome-published', 9, 180, {
          version: 1,
          outcome: outcome({ evidence: [{ kind: 'message', seq: 99 }] }),
        })
        : candidate), /message evidence/],
    ]

    for (const [name, events, pattern] of cases) {
      expect(() => foldScience(events), name).toThrow(pattern)
    }
  })

  it('indexes supporting events and accepts each evidence kind', () => {
    const supportingState = emptyScienceFoldState()
    const supportingEvents = [
      event('user/message', 0, 1, {}),
      event('assistant/message', 1, 2, {}),
      event('tool/result', 2, 3, {
        message: createToolResultMessage({
          callId: RUN_CALL_ID,
          content: [{ type: 'text', text: 'done' }],
          isError: false,
        }),
      }),
      event('request/header', 3, 4, {}),
      toolCall(4, 5, RUN_CALL_ID, 'run_python'),
      event('turn/start', 5, 6, {}),
    ]
    for (const supportingEvent of supportingEvents) applyScienceEvent(supportingState, supportingEvent)
    expect(supportingState.messageFacts).toEqual([
      { seq: 0, time: 1 },
      { seq: 1, time: 2 },
      { seq: 2, time: 3 },
    ])
    expect(supportingState.requestHeaders).toEqual([{ seq: 3, time: 4 }])
    expect(supportingState.toolCalls).toEqual([{
      seq: 4,
      time: 5,
      callId: RUN_CALL_ID,
      turn: 1,
      step: 1,
      name: 'run_python',
    }])
    expect(supportingState.toolResults).toEqual([{ seq: 2, time: 3, callId: RUN_CALL_ID }])
    expect(supportingState.settledToolCallSeqs).toEqual([])
    expect(supportingState.consumedToolCallSeqs).toEqual([])

    const postModeStep = emptyScienceFoldState()
    applyScienceEvent(postModeStep, legalEvents()[0]!)
    applyScienceEvent(postModeStep, event('step/start', 1, 101, { turn: 1, step: 1 }))
    expect(postModeStep.preModeStepStarted).toBe(false)

    const withMessageEvidence = [
      ...legalEvents().slice(0, 8),
      event('assistant/message', 8, 175, {}),
      toolCall(9, 176, OUTCOME_CALL_ID, 'publish_outcome'),
      event('science/outcome-published', 10, 180, {
        version: 1,
        outcome: outcome({ evidence: [
          { kind: 'run', runId: RUN_ID },
          { kind: 'chart', chartId: CHART_ID, version: 1 },
          { kind: 'message', seq: 8 },
        ] }),
      }),
    ]
    expect(() => foldScience(withMessageEvidence)).not.toThrow()

    const secondEnvironment = environment({
      revision: 2,
      profileId: ScienceEnvironmentProfileId('profile-2'),
      configuredAt: 111,
      validatedAt: 119,
    })
    const runOnSecondEnvironment = runStarted({
      requestHeaderSeq: 3,
      environmentRevision: 2,
      startedAt: 139,
    })
    const terminalOnSecondEnvironment = runTerminal({
      requestHeaderSeq: 3,
      environmentRevision: 2,
      startedAt: 139,
    })
    const outcomeOnSecondEnvironment = (environmentRevisions: readonly number[]): SessionEvent[] => [
      legalEvents()[0]!,
      legalEvents()[1]!,
      event('science/environment-bound', 2, 120, {
        version: 1,
        environment: secondEnvironment,
      }),
      event('request/header', 3, 130, {}),
      toolCall(4, 135, RUN_CALL_ID, 'run_python'),
      event('science/run-started', 5, 140, { version: 1, run: runOnSecondEnvironment }),
      event('science/run-finished', 6, 150, { version: 1, run: terminalOnSecondEnvironment }),
      toolCall(7, 155, OUTCOME_CALL_ID, 'publish_outcome'),
      event('science/outcome-published', 8, 160, {
        version: 1,
        outcome: outcome({
          evidence: [{ kind: 'run', runId: RUN_ID }],
          publishedAt: 159,
          requestHeaderSeq: 3,
          environmentRevisions,
        }),
      }),
    ]
    expect(() => foldScience(outcomeOnSecondEnvironment([1])))
      .toThrow(/environmentRevisions must exactly match cited run and chart evidence/)
    expect(() => foldScience(outcomeOnSecondEnvironment([1, 2])))
      .toThrow(/environmentRevisions must exactly match cited run and chart evidence/)

    const chartVersionTwo = [
      ...legalEvents().slice(0, 8),
      toolCall(8, 180, CallId('call-chart-2'), 'save_chart'),
      event('science/chart-saved', 9, 190, {
        version: 1,
        chart: chart({
          version: 2,
          toolCallId: CallId('call-chart-2'),
          createdAt: 189,
        }),
      }),
    ]
    expect(foldScience(chartVersionTwo).charts.map(candidate => candidate.version)).toEqual([1, 2])
  })

  it('rejects invalid event positions and timestamps', () => {
    const cases: SessionEvent[] = [
      event('turn/start', 1, 0, {}),
      event('turn/start', 0.5, 0, {}),
      event('turn/start', 0, -1, {}),
      event('turn/start', 0, 0.5, {}),
    ]
    for (const candidate of cases) {
      expect(() => { applyScienceEvent(emptyScienceFoldState(), candidate) }).toThrow()
    }
  })

  it('derives interruption only for an unmatched run at session/end-seed', () => {
    const openRun = legalEvents().slice(0, 5)
    openRun.push(event('session/end-seed', 5, 150, {}))
    const interrupted = foldScience(openRun)
    expect(interrupted.runs).toEqual([{
      ...runStarted(),
      status: 'interrupted',
      finishedAt: 150,
      interruptedAtSeq: 5,
    }])
    expect(interrupted.lastScienceEventSeq).toBe(5)

    const settledRun = legalEvents().slice(0, 6)
    settledRun.push(event('session/end-seed', 6, 160, {}))
    const settled = foldScience(settledRun)
    expect(settled.runs).toEqual([runTerminal()])
    expect(settled.lastScienceEventSeq).toBe(5)

    const twoRuns = [
      ...legalEvents().slice(0, 6),
      toolCall(6, 160, CallId('call-run-2'), 'run_python'),
      event('science/run-started', 7, 170, {
        version: 1,
        run: runStarted({
          runId: ScienceRunId('run-2'),
          toolCallId: CallId('call-run-2'),
          startedAt: 169,
          runDirectoryRef: 'runs/run-2/',
        }),
      }),
      event('session/end-seed', 8, 180, {}),
    ]
    const mixed = foldScience(twoRuns)
    expect(mixed.runs[0]).toEqual(runTerminal())
    expect(mixed.runs[1]).toMatchObject({ status: 'interrupted', interruptedAtSeq: 8 })

    const backwardsBoundary = [...openRun.slice(0, 5), event('session/end-seed', 5, 139, {})]
    expect(() => foldScience(backwardsBoundary)).toThrow(/moves time backwards/)
  })
})
