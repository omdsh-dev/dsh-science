/** Strict decoders and deterministic replay fold for durable Science facts. */

import { Buffer } from 'node:buffer'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import {
  SCIENCE_EVENT_VERSION,
  ScienceChartId,
  ScienceEnvironmentProfileId,
  ScienceRunId,
  ScienceScratchKey,
} from './ids.ts'
import type {
  ScienceChartSavedEvent,
  ScienceDomainEventType,
  ScienceEnvironmentBoundEvent,
  ScienceModeBoundEvent,
  ScienceOutcomePublishedEvent,
  ScienceRunFinishedEvent,
  ScienceRunStartedEvent,
} from './domain.ts'
import type {
  ScienceChartVersion,
  ScienceEnvironmentBinding,
  ScienceEvidenceRef,
  ScienceModeRef,
  ScienceOutcomePublication,
  ScienceRun,
  ScienceRunIdentity,
  ScienceRunStarted,
  ScienceRunTerminal,
} from './types.ts'

const MAX_ID_LENGTH = 128
const MAX_PATH_LENGTH = 4096
const MAX_LABEL_LENGTH = 512
const MAX_REASON_LENGTH = 4096
const MAX_SUMMARY_BYTES = 32 * 1024
const SAFE_INTEGER = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const POSITIVE_INTEGER = SAFE_INTEGER.min(1)
const SHA256 = z.string().regex(/^[a-f0-9]{64}$/)
const SAFE_ID = z.string()
  .min(1)
  .max(MAX_ID_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)

/** Require normalized, bounded durable text. */
function text(maximum: number): z.ZodString {
  return z.string().min(1).max(maximum).refine(value => value === value.trim(), {
    message: 'must not have surrounding whitespace',
  })
}

/** Add one cross-field validation issue. */
function issue(ctx: z.RefinementCtx, message: string, path: PropertyKey[] = []): void {
  ctx.addIssue({ code: 'custom', message, path })
}

const scienceModeSchema = z.object({
  modeId: z.literal('science'),
  presetId: z.literal('science'),
  modeRevision: text(MAX_ID_LENGTH),
}).strict()

const interpreterSchema = z.object({
  language: z.enum(['python', 'r']),
  configuredPrefix: text(MAX_PATH_LENGTH).refine(value => value.startsWith('/'), {
    message: 'configuredPrefix must be absolute',
  }),
  canonicalPrefix: text(MAX_PATH_LENGTH).refine(value => value.startsWith('/'), {
    message: 'canonicalPrefix must be absolute',
  }),
  executable: text(MAX_PATH_LENGTH).refine(value => value.startsWith('/'), {
    message: 'executable must be absolute',
  }),
  executableIdentity: text(MAX_LABEL_LENGTH),
  languageVersion: text(MAX_LABEL_LENGTH),
  condaHistorySha256: SHA256,
  bindingFingerprint: SHA256,
  capability: z.enum(['available', 'unavailable', 'invalid', 'drifted']),
  reason: text(MAX_REASON_LENGTH).optional(),
}).strict().superRefine((binding, ctx) => {
  if (binding.capability === 'available' && binding.reason !== undefined) {
    issue(ctx, 'an available interpreter cannot carry a failure reason', ['reason'])
  }
  if (binding.capability !== 'available' && binding.reason === undefined) {
    issue(ctx, 'an unavailable interpreter requires a reason', ['reason'])
  }
})

const environmentSchema = z.object({
  revision: POSITIVE_INTEGER,
  profileId: SAFE_ID.transform(value => ScienceEnvironmentProfileId(value)),
  configuredAt: SAFE_INTEGER,
  validatedAt: SAFE_INTEGER,
  status: z.enum(['applied', 'invalid', 'drifted']),
  python: interpreterSchema.optional(),
  r: interpreterSchema.optional(),
  failureReason: text(MAX_REASON_LENGTH).optional(),
}).strict().superRefine((environment, ctx) => {
  if (environment.python === undefined && environment.r === undefined) {
    issue(ctx, 'an environment requires at least one interpreter binding')
  }
  if (environment.python !== undefined && environment.python.language !== 'python') {
    issue(ctx, 'the python slot must carry a Python binding', ['python', 'language'])
  }
  if (environment.r !== undefined && environment.r.language !== 'r') {
    issue(ctx, 'the r slot must carry an R binding', ['r', 'language'])
  }
  if (environment.validatedAt < environment.configuredAt) {
    issue(ctx, 'validatedAt cannot precede configuredAt', ['validatedAt'])
  }
  const bindings = [environment.python, environment.r].filter(binding => binding !== undefined)
  if (environment.status === 'applied') {
    if (bindings.some(binding => binding.capability !== 'available')) {
      issue(ctx, 'an applied environment may contain only available bindings')
    }
    if (environment.failureReason !== undefined) {
      issue(ctx, 'an applied environment cannot carry failureReason', ['failureReason'])
    }
  } else if (environment.failureReason === undefined) {
    issue(ctx, `${environment.status} environment requires failureReason`, ['failureReason'])
  }
})

const runIdentityShape = {
  runId: SAFE_ID.transform(value => ScienceRunId(value)),
  language: z.enum(['python', 'r']),
  toolCallId: text(MAX_ID_LENGTH).transform(value => CallId(value)),
  requestHeaderSeq: SAFE_INTEGER,
  environmentRevision: POSITIVE_INTEGER,
  environmentFingerprint: SHA256,
  startedAt: SAFE_INTEGER,
  codeSha256: SHA256,
  scratchKey: SHA256.transform(value => ScienceScratchKey(value)),
  runDirectoryRef: text(MAX_PATH_LENGTH),
} as const

const runStartedSchema = z.object({
  ...runIdentityShape,
  status: z.literal('running'),
}).strict().superRefine((run, ctx) => {
  if (run.runDirectoryRef !== `runs/${run.runId}/`) {
    issue(ctx, 'runDirectoryRef must be the canonical session-relative run path', ['runDirectoryRef'])
  }
})

const runTerminalSchema = z.object({
  ...runIdentityShape,
  status: z.enum(['success', 'failed', 'timed-out', 'cancelled']),
  finishedAt: SAFE_INTEGER,
  exitCode: z.number().int().min(-2147483648).max(2147483647).optional(),
  signal: text(MAX_LABEL_LENGTH).optional(),
  stdoutBytes: SAFE_INTEGER,
  stderrBytes: SAFE_INTEGER,
  stdoutTruncated: z.boolean(),
  stderrTruncated: z.boolean(),
  failureCode: z.string().regex(/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/).max(MAX_ID_LENGTH).optional(),
  failureMessage: text(MAX_REASON_LENGTH).optional(),
}).strict().superRefine((run, ctx) => {
  if (run.runDirectoryRef !== `runs/${run.runId}/`) {
    issue(ctx, 'runDirectoryRef must be the canonical session-relative run path', ['runDirectoryRef'])
  }
  if (run.finishedAt < run.startedAt) {
    issue(ctx, 'finishedAt cannot precede startedAt', ['finishedAt'])
  }
  if (run.status === 'success') {
    if (run.exitCode !== 0) issue(ctx, 'a successful run requires exitCode 0', ['exitCode'])
    if (run.signal !== undefined || run.failureCode !== undefined || run.failureMessage !== undefined) {
      issue(ctx, 'a successful run cannot carry failure facts')
    }
  } else if (run.failureCode === undefined) {
    issue(ctx, 'a non-success run requires failureCode', ['failureCode'])
  }
})

const attachmentSchema = z.object({
  attachmentId: text(MAX_ID_LENGTH).transform(value => AttachmentId(value)),
  mediaType: z.literal('image/png'),
  bytes: POSITIVE_INTEGER,
  width: POSITIVE_INTEGER,
  height: POSITIVE_INTEGER,
  name: text(MAX_LABEL_LENGTH).refine(value => !/[\\/]/.test(value), {
    message: 'attachment name must not contain a path separator',
  }).optional(),
}).strict()

const chartSchema = z.object({
  chartId: SAFE_ID.transform(value => ScienceChartId(value)),
  logicalName: SAFE_ID,
  version: POSITIVE_INTEGER,
  title: text(MAX_LABEL_LENGTH),
  caption: text(MAX_REASON_LENGTH).optional(),
  attachment: attachmentSchema,
  runId: SAFE_ID.transform(value => ScienceRunId(value)),
  toolCallId: text(MAX_ID_LENGTH).transform(value => CallId(value)),
  requestHeaderSeq: SAFE_INTEGER,
  environmentRevision: POSITIVE_INTEGER,
  environmentFingerprint: SHA256,
  createdAt: SAFE_INTEGER,
}).strict()

const runEvidenceSchema = z.object({
  kind: z.literal('run'),
  runId: SAFE_ID.transform(value => ScienceRunId(value)),
}).strict()
const chartEvidenceSchema = z.object({
  kind: z.literal('chart'),
  chartId: SAFE_ID.transform(value => ScienceChartId(value)),
  version: POSITIVE_INTEGER,
}).strict()
const messageEvidenceSchema = z.object({
  kind: z.literal('message'),
  seq: SAFE_INTEGER,
}).strict()
const evidenceSchema = z.discriminatedUnion('kind', [
  runEvidenceSchema,
  chartEvidenceSchema,
  messageEvidenceSchema,
])

const outcomeSchema = z.object({
  revision: POSITIVE_INTEGER,
  title: text(MAX_LABEL_LENGTH),
  summaryMarkdown: text(MAX_SUMMARY_BYTES).refine(
    value => Buffer.byteLength(value, 'utf8') <= MAX_SUMMARY_BYTES,
    { message: `summaryMarkdown must be at most ${String(MAX_SUMMARY_BYTES)} UTF-8 bytes` },
  ),
  evidence: z.array(evidenceSchema).min(1).max(256),
  publishedAt: SAFE_INTEGER,
  toolCallId: text(MAX_ID_LENGTH).transform(value => CallId(value)),
  requestHeaderSeq: SAFE_INTEGER,
  environmentRevisions: z.array(POSITIVE_INTEGER).max(256),
}).strict().superRefine((outcome, ctx) => {
  const evidenceKeys = outcome.evidence.map((ref) => {
    switch (ref.kind) {
      case 'run': return `run:${ref.runId}`
      case 'chart': return `chart:${ref.chartId}:${String(ref.version)}`
      case 'message': return `message:${String(ref.seq)}`
    }
  })
  if (new Set(evidenceKeys).size !== evidenceKeys.length) {
    issue(ctx, 'evidence references must be unique', ['evidence'])
  }
  if (new Set(outcome.environmentRevisions).size !== outcome.environmentRevisions.length
    || outcome.environmentRevisions.some((revision, index) => {
      const previous = outcome.environmentRevisions[index - 1]
      return previous !== undefined && revision <= previous
    })) {
    issue(ctx, 'environmentRevisions must be unique and strictly increasing', ['environmentRevisions'])
  }
})

const modeEventSchema = z.object({
  version: z.literal(SCIENCE_EVENT_VERSION),
  mode: scienceModeSchema,
}).strict()
const environmentEventSchema = z.object({
  version: z.literal(SCIENCE_EVENT_VERSION),
  environment: environmentSchema,
}).strict()
const runStartedEventSchema = z.object({
  version: z.literal(SCIENCE_EVENT_VERSION),
  run: runStartedSchema,
}).strict()
const runFinishedEventSchema = z.object({
  version: z.literal(SCIENCE_EVENT_VERSION),
  run: runTerminalSchema,
}).strict()
const chartSavedEventSchema = z.object({
  version: z.literal(SCIENCE_EVENT_VERSION),
  chart: chartSchema,
}).strict()
const outcomePublishedEventSchema = z.object({
  version: z.literal(SCIENCE_EVENT_VERSION),
  outcome: outcomeSchema,
}).strict()

/**
 * Decode one mode binding value and reject unknown or malformed fields.
 * @param value - candidate durable value.
 * @returns a detached, validated mode reference.
 */
export function decodeScienceMode(value: unknown): ScienceModeRef {
  return scienceModeSchema.parse(value)
}

/**
 * Decode one environment binding value and reject unknown or malformed fields.
 * @param value - candidate durable value.
 * @returns a detached, validated environment binding.
 */
export function decodeScienceEnvironment(value: unknown): ScienceEnvironmentBinding {
  return environmentSchema.parse(value) as ScienceEnvironmentBinding
}

/**
 * Decode one run-start value and reject unknown or malformed fields.
 * @param value - candidate durable value.
 * @returns a detached, validated run-start record.
 */
export function decodeScienceRunStarted(value: unknown): ScienceRunStarted {
  return runStartedSchema.parse(value)
}

/**
 * Decode one run-finished value and reject unknown or malformed fields.
 * @param value - candidate durable value.
 * @returns a detached, validated terminal run record.
 */
export function decodeScienceRunTerminal(value: unknown): ScienceRunTerminal {
  return runTerminalSchema.parse(value) as ScienceRunTerminal
}

/**
 * Decode one chart version and reject unknown or malformed fields.
 * @param value - candidate durable value.
 * @returns a detached, validated chart version.
 */
export function decodeScienceChart(value: unknown): ScienceChartVersion {
  return chartSchema.parse(value) as ScienceChartVersion
}

/**
 * Decode one outcome publication and reject unknown or malformed fields.
 * @param value - candidate durable value.
 * @returns a detached, validated outcome publication.
 */
export function decodeScienceOutcome(value: unknown): ScienceOutcomePublication {
  return outcomeSchema.parse(value)
}

/** A Science event whose payload has passed the package's strict decoder. */
export type DecodedScienceDomainEvent =
  | {
    readonly type: 'science/mode-bound'
    readonly seq: number
    readonly time: number
    readonly data: ScienceModeBoundEvent
  }
  | {
    readonly type: 'science/environment-bound'
    readonly seq: number
    readonly time: number
    readonly data: ScienceEnvironmentBoundEvent
  }
  | {
    readonly type: 'science/run-started'
    readonly seq: number
    readonly time: number
    readonly data: ScienceRunStartedEvent
  }
  | {
    readonly type: 'science/run-finished'
    readonly seq: number
    readonly time: number
    readonly data: ScienceRunFinishedEvent
  }
  | {
    readonly type: 'science/chart-saved'
    readonly seq: number
    readonly time: number
    readonly data: ScienceChartSavedEvent
  }
  | {
    readonly type: 'science/outcome-published'
    readonly seq: number
    readonly time: number
    readonly data: ScienceOutcomePublishedEvent
  }

/**
 * Decode a Science event. Unrelated event types return `undefined`; a
 * malformed Science event fails loudly.
 * @param event - candidate session event.
 * @returns the validated Science event or `undefined` for another event type.
 */
export function decodeScienceDomainEvent(event: SessionEvent): DecodedScienceDomainEvent | undefined {
  if (event.ignorable === true && isScienceDomainEventType(event.type)) {
    throw new Error('Science domain events must be required, not ignorable')
  }
  switch (event.type) {
    case 'science/mode-bound':
      return { type: event.type, seq: event.seq, time: event.time, data: modeEventSchema.parse(event.data) }
    case 'science/environment-bound': {
      const data = environmentEventSchema.parse(event.data) as ScienceEnvironmentBoundEvent
      return { type: event.type, seq: event.seq, time: event.time, data }
    }
    case 'science/run-started':
      return { type: event.type, seq: event.seq, time: event.time, data: runStartedEventSchema.parse(event.data) }
    case 'science/run-finished': {
      const data = runFinishedEventSchema.parse(event.data) as ScienceRunFinishedEvent
      return { type: event.type, seq: event.seq, time: event.time, data }
    }
    case 'science/chart-saved': {
      const data = chartSavedEventSchema.parse(event.data) as ScienceChartSavedEvent
      return { type: event.type, seq: event.seq, time: event.time, data }
    }
    case 'science/outcome-published':
      return { type: event.type, seq: event.seq, time: event.time, data: outcomePublishedEventSchema.parse(event.data) }
    default:
      if (event.type.startsWith('science/') && event.ignorable !== true) {
        throw new Error(`unsupported required Science event type ${JSON.stringify(event.type)}`)
      }
      return undefined
  }
}

/** Internal index entry for an observed tool call. */
interface IndexedToolCall {
  readonly seq: number
  readonly time: number
  readonly callId: string
}

/** Internal index entry for a supporting Session fact. */
interface IndexedSessionFact {
  readonly seq: number
  readonly time: number
}

/** Internal index entry for a tool result that settles one call. */
interface IndexedToolResult extends IndexedSessionFact {
  readonly callId: string
}

/** Internal event-envelope facts for one Science run. */
interface IndexedRunFact {
  readonly runId: string
  readonly startedSeq: number
  readonly startedEventTime: number
  readonly terminalSeq?: number
  readonly terminalEventTime?: number
}

/** Internal event-envelope facts for one immutable chart version. */
interface IndexedChartFact extends IndexedSessionFact {
  readonly chartId: string
  readonly version: number
}

/** Mutable, deterministic replay accumulator used by fold and invariant. */
export interface ScienceFoldState {
  nextSeq: number
  mode: ScienceModeRef | undefined
  modeBoundSeq: number | undefined
  preModeStepStarted: boolean
  environments: ScienceEnvironmentBinding[]
  runs: ScienceRun[]
  charts: ScienceChartVersion[]
  outcomes: ScienceOutcomePublication[]
  requestHeaders: IndexedSessionFact[]
  toolCalls: IndexedToolCall[]
  toolResults: IndexedToolResult[]
  consumedToolCallSeqs: number[]
  messageFacts: IndexedSessionFact[]
  runFacts: IndexedRunFact[]
  chartFacts: IndexedChartFact[]
  lastScienceTime: number | undefined
  lastScienceEventSeq: number | undefined
}

/**
 * Build an empty strict Science replay accumulator.
 * @returns mutable state positioned before session event zero.
 */
export function emptyScienceFoldState(): ScienceFoldState {
  return {
    nextSeq: 0,
    mode: undefined,
    modeBoundSeq: undefined,
    preModeStepStarted: false,
    environments: [],
    runs: [],
    charts: [],
    outcomes: [],
    requestHeaders: [],
    toolCalls: [],
    toolResults: [],
    consumedToolCallSeqs: [],
    messageFacts: [],
    runFacts: [],
    chartFacts: [],
    lastScienceTime: undefined,
    lastScienceEventSeq: undefined,
  }
}

/**
 * Clone one strict replay accumulator before pre-commit validation.
 * @param state - accepted state covering all prior events.
 * @returns an independently mutable copy.
 */
export function cloneScienceFoldState(state: ScienceFoldState): ScienceFoldState {
  return {
    nextSeq: state.nextSeq,
    mode: state.mode,
    modeBoundSeq: state.modeBoundSeq,
    preModeStepStarted: state.preModeStepStarted,
    environments: [...state.environments],
    runs: [...state.runs],
    charts: [...state.charts],
    outcomes: [...state.outcomes],
    requestHeaders: [...state.requestHeaders],
    toolCalls: [...state.toolCalls],
    toolResults: [...state.toolResults],
    consumedToolCallSeqs: [...state.consumedToolCallSeqs],
    messageFacts: [...state.messageFacts],
    runFacts: [...state.runFacts],
    chartFacts: [...state.chartFacts],
    lastScienceTime: state.lastScienceTime,
    lastScienceEventSeq: state.lastScienceEventSeq,
  }
}

/** Require a prior request header reference. */
function requireRequestHeader(state: ScienceFoldState, seq: number): IndexedSessionFact {
  const latest = state.requestHeaders.at(-1)
  if (state.modeBoundSeq === undefined
    || seq <= state.modeBoundSeq
    || latest?.seq !== seq) {
    throw new Error(`requestHeaderSeq ${String(seq)} is not the latest post-mode request/header`)
  }
  return latest
}

/** Require a prior tool call reference. */
function requireToolCall(
  state: ScienceFoldState,
  seq: number,
  callId: string,
  requestHeaderSeq: number,
): IndexedToolCall {
  const allMatches = state.toolCalls.filter(call => call.callId === callId)
  const matches = allMatches.filter(call => call.seq > (state.modeBoundSeq ?? Number.MAX_SAFE_INTEGER)
    && call.seq > requestHeaderSeq
    && call.seq < seq)
  const call = allMatches.length === 1 && matches.length === 1 ? matches[0] : undefined
  if (call === undefined) {
    throw new Error(`toolCallId ${JSON.stringify(callId)} does not identify one call after its cited request/header`)
  }
  if (state.consumedToolCallSeqs.includes(call.seq)) {
    throw new Error(`toolCallId ${JSON.stringify(callId)} was already consumed by a Science fact`)
  }
  if (state.toolResults.some(result => result.callId === callId
    && result.seq > call.seq
    && result.seq < seq)) {
    throw new Error(`toolCallId ${JSON.stringify(callId)} was already settled before its Science fact`)
  }
  return call
}

/** Require and return an environment revision. */
function requireEnvironment(state: ScienceFoldState, revision: number): ScienceEnvironmentBinding {
  const environment = state.environments.find(candidate => candidate.revision === revision)
  if (environment === undefined) {
    throw new Error(`environment revision ${String(revision)} does not exist`)
  }
  return environment
}

/** Require that one event does not move the Science clock backwards. */
function requireScienceTime(state: ScienceFoldState, event: Pick<SessionEvent, 'seq' | 'time'>): void {
  if (state.lastScienceTime !== undefined && event.time < state.lastScienceTime) {
    throw new Error(`Science event ${String(event.seq)} moves time backwards`)
  }
}

/** Commit the Science clock after a transition is fully validated. */
function commitScienceTime(state: ScienceFoldState, event: Pick<SessionEvent, 'seq' | 'time'>): void {
  state.lastScienceTime = event.time
  state.lastScienceEventSeq = event.seq
}

/** Compare every start-owned field repeated by a terminal run value. */
function sameRunIdentity(started: ScienceRunIdentity, terminal: ScienceRunIdentity): boolean {
  return started.runId === terminal.runId
    && started.language === terminal.language
    && started.toolCallId === terminal.toolCallId
    && started.requestHeaderSeq === terminal.requestHeaderSeq
    && started.environmentRevision === terminal.environmentRevision
    && started.environmentFingerprint === terminal.environmentFingerprint
    && started.startedAt === terminal.startedAt
    && started.codeSha256 === terminal.codeSha256
    && started.scratchKey === terminal.scratchKey
    && started.runDirectoryRef === terminal.runDirectoryRef
}

/** Validate and apply one decoded Science domain event. */
function applyDomainEvent(state: ScienceFoldState, event: DecodedScienceDomainEvent): void {
  requireScienceTime(state, event)
  switch (event.type) {
    case 'science/mode-bound': {
      if (state.mode !== undefined) throw new Error('Science mode may be bound only once')
      if (state.preModeStepStarted || state.requestHeaders.length > 0 || state.toolCalls.length > 0) {
        throw new Error('Science mode cannot follow pre-mode step/start, request/header, or tool/call facts')
      }
      state.mode = event.data.mode
      state.modeBoundSeq = event.seq
      break
    }
    case 'science/environment-bound': {
      if (state.mode === undefined) throw new Error('Science environment requires a prior mode binding')
      const environment = event.data.environment
      if (environment.revision !== state.environments.length + 1) {
        throw new Error(`environment revision must be ${String(state.environments.length + 1)}`)
      }
      if (state.runs.length > 0 && environment.status === 'applied') {
        throw new Error('an applied Science environment cannot be replaced after the first run')
      }
      if (environment.validatedAt > event.time) {
        throw new Error('environment validation time cannot follow its event time')
      }
      state.environments.push(environment)
      break
    }
    case 'science/run-started': {
      if (state.mode === undefined) throw new Error('Science run requires a prior mode binding')
      const run = event.data.run
      if (state.runs.some(candidate => candidate.runId === run.runId)) {
        throw new Error(`duplicate Science runId ${JSON.stringify(run.runId)}`)
      }
      if (state.runs.some(candidate => candidate.status === 'running')) {
        throw new Error('only one Science run may be running in a session')
      }
      const environment = requireEnvironment(state, run.environmentRevision)
      if (environment !== state.environments.at(-1) || environment.status !== 'applied') {
        throw new Error('Science run must use the latest applied environment revision')
      }
      const binding = run.language === 'python' ? environment.python : environment.r
      if (binding === undefined || binding.capability !== 'available'
        || binding.bindingFingerprint !== run.environmentFingerprint) {
        throw new Error('Science run does not match an available environment binding')
      }
      const requestHeader = requireRequestHeader(state, run.requestHeaderSeq)
      const toolCall = requireToolCall(state, event.seq, run.toolCallId, run.requestHeaderSeq)
      const priorRunFact = state.runFacts.at(-1)
      if (run.startedAt < environment.validatedAt
        || run.startedAt < requestHeader.time
        || run.startedAt < toolCall.time
        || (priorRunFact?.terminalEventTime !== undefined
          && run.startedAt < priorRunFact.terminalEventTime)
        || run.startedAt > event.time) {
        throw new Error('Science run start time is outside its supporting-fact event interval')
      }
      state.runs.push(run)
      state.runFacts.push({
        runId: run.runId,
        startedSeq: event.seq,
        startedEventTime: event.time,
      })
      state.consumedToolCallSeqs.push(toolCall.seq)
      break
    }
    case 'science/run-finished': {
      const run = event.data.run
      const index = state.runs.findIndex(candidate => candidate.runId === run.runId)
      if (index < 0) throw new Error(`Science run ${JSON.stringify(run.runId)} has no matching start`)
      const current = state.runs[index]
      /* v8 ignore next -- findIndex returned this in-range index */
      if (current === undefined) throw new Error('Science run index disappeared during synchronous replay')
      if (current.status !== 'running') {
        throw new Error(`Science run ${JSON.stringify(run.runId)} is already terminal`)
      }
      if (!sameRunIdentity(current, run)) {
        throw new Error(`Science run ${JSON.stringify(run.runId)} terminal value rewrites start-owned fields`)
      }
      const factIndex = state.runFacts.findIndex(candidate => candidate.runId === run.runId)
      const fact = state.runFacts[factIndex]
      /* v8 ignore next -- every accepted run start appends the matching fact */
      if (fact === undefined) throw new Error('Science run event facts disappeared during synchronous replay')
      if (run.finishedAt < fact.startedEventTime || run.finishedAt > event.time) {
        throw new Error('Science run finish time is outside its durable start-to-finish event interval')
      }
      state.runs[index] = run
      state.runFacts[factIndex] = {
        ...fact,
        terminalSeq: event.seq,
        terminalEventTime: event.time,
      }
      break
    }
    case 'science/chart-saved': {
      if (state.mode === undefined) throw new Error('Science chart requires a prior mode binding')
      const chart = event.data.chart
      const source = state.runs.find(candidate => candidate.runId === chart.runId)
      if (source === undefined || source.status !== 'success') {
        throw new Error('Science chart must reference a successful prior run')
      }
      const requestHeader = requireRequestHeader(state, chart.requestHeaderSeq)
      const toolCall = requireToolCall(state, event.seq, chart.toolCallId, chart.requestHeaderSeq)
      if (chart.environmentRevision !== source.environmentRevision
        || chart.environmentFingerprint !== source.environmentFingerprint) {
        throw new Error('Science chart environment provenance must match its source run')
      }
      const sourceFact = state.runFacts.find(candidate => candidate.runId === chart.runId)
      /* v8 ignore next -- a successful run always has its terminal fact */
      if (sourceFact?.terminalEventTime === undefined) {
        throw new Error('Science chart source-run event facts are missing')
      }
      if (chart.createdAt < source.finishedAt
        || chart.createdAt < sourceFact.terminalEventTime
        || chart.createdAt < requestHeader.time
        || chart.createdAt < toolCall.time
        || chart.createdAt > event.time) {
        throw new Error('Science chart creation time is outside its supporting-fact event interval')
      }
      const logical = state.charts.filter(candidate => candidate.logicalName === chart.logicalName)
      const reusedId = state.charts.find(candidate => candidate.chartId === chart.chartId)
      if (logical.length === 0) {
        if (chart.version !== 1) throw new Error('the first logical chart version must be 1')
        if (reusedId !== undefined) throw new Error('a chartId cannot name two logical charts')
      } else {
        const latest = logical.at(-1)
        /* v8 ignore next -- the branch is entered only when logical is non-empty */
        if (latest === undefined) throw new Error('logical chart history disappeared during synchronous replay')
        if (chart.chartId !== latest.chartId
          || chart.version !== latest.version + 1
          || chart.createdAt < latest.createdAt) {
          throw new Error('chart versions must retain chartId and advance contiguously')
        }
      }
      state.charts.push(chart)
      state.chartFacts.push({
        chartId: chart.chartId,
        version: chart.version,
        seq: event.seq,
        time: event.time,
      })
      state.consumedToolCallSeqs.push(toolCall.seq)
      break
    }
    case 'science/outcome-published': {
      if (state.mode === undefined) throw new Error('Science outcome requires a prior mode binding')
      const outcome = event.data.outcome
      if (outcome.revision !== state.outcomes.length + 1) {
        throw new Error(`outcome revision must be ${String(state.outcomes.length + 1)}`)
      }
      const prior = state.outcomes.at(-1)
      if (outcome.publishedAt > event.time
        || (prior !== undefined && outcome.publishedAt < prior.publishedAt)) {
        throw new Error('Science outcome publication time is not monotonic')
      }
      const requestHeader = requireRequestHeader(state, outcome.requestHeaderSeq)
      const toolCall = requireToolCall(state, event.seq, outcome.toolCallId, outcome.requestHeaderSeq)
      if (outcome.publishedAt < requestHeader.time || outcome.publishedAt < toolCall.time) {
        throw new Error('Science outcome publication time precedes its authorizing facts')
      }
      for (const revision of outcome.environmentRevisions) {
        if (requireEnvironment(state, revision).status !== 'applied') {
          throw new Error(`outcome environment revision ${String(revision)} was not applied`)
        }
      }
      const citedEnvironmentRevisions = new Set<number>()
      for (const evidence of outcome.evidence) {
        switch (evidence.kind) {
          case 'run': {
            const run = state.runs.find(candidate => candidate.runId === evidence.runId)
            if (run === undefined || run.status !== 'success') {
              throw new Error(`outcome run evidence ${JSON.stringify(evidence.runId)} is not a successful prior run`)
            }
            const fact = state.runFacts.find(candidate => candidate.runId === evidence.runId)
            /* v8 ignore next -- a successful run always has its terminal fact */
            if (fact?.terminalEventTime === undefined) {
              throw new Error('Science outcome run event facts are missing')
            }
            if (outcome.publishedAt < fact.terminalEventTime) {
              throw new Error('Science outcome publication time precedes cited run evidence')
            }
            citedEnvironmentRevisions.add(run.environmentRevision)
            break
          }
          case 'chart': {
            const chart = state.charts.find(candidate => candidate.chartId === evidence.chartId
              && candidate.version === evidence.version)
            if (chart === undefined) {
              throw new Error(`outcome chart evidence ${JSON.stringify(evidence.chartId)}@${String(evidence.version)} is missing`)
            }
            const fact = state.chartFacts.find(candidate => candidate.chartId === evidence.chartId
              && candidate.version === evidence.version)
            /* v8 ignore next -- every accepted chart appends the matching fact */
            if (fact === undefined) throw new Error('Science outcome chart event facts are missing')
            if (outcome.publishedAt < fact.time) {
              throw new Error('Science outcome publication time precedes cited chart evidence')
            }
            citedEnvironmentRevisions.add(chart.environmentRevision)
            break
          }
          case 'message': {
            const fact = state.messageFacts.find(candidate => candidate.seq === evidence.seq)
            if (fact === undefined) {
              throw new Error(`outcome message evidence seq ${String(evidence.seq)} is missing`)
            }
            if (outcome.publishedAt < fact.time) {
              throw new Error('Science outcome publication time precedes cited message evidence')
            }
            break
          }
        }
      }
      if (citedEnvironmentRevisions.size !== outcome.environmentRevisions.length
        || outcome.environmentRevisions.some(revision => !citedEnvironmentRevisions.has(revision))) {
        throw new Error('outcome environmentRevisions must exactly match cited run and chart evidence')
      }
      state.outcomes.push(outcome)
      state.consumedToolCallSeqs.push(toolCall.seq)
      break
    }
  }
  commitScienceTime(state, event)
}

/** Derive interrupted runs at the constructor seed boundary. */
function applyEndSeed(state: ScienceFoldState, event: SessionEvent<'session/end-seed'>): void {
  if (!state.runs.some(run => run.status === 'running')) return
  requireScienceTime(state, event)
  const interruptedIds = new Set<string>(state.runs
    .filter(run => run.status === 'running')
    .map(run => run.runId))
  state.runs = state.runs.map((run): ScienceRun => run.status === 'running'
    ? { ...run, status: 'interrupted', finishedAt: event.time, interruptedAtSeq: event.seq }
    : run)
  state.runFacts = state.runFacts.map(fact => interruptedIds.has(fact.runId)
    ? { ...fact, terminalSeq: event.seq, terminalEventTime: event.time }
    : fact)
  commitScienceTime(state, event)
}

/**
 * Validate and apply one contiguous session event to a strict accumulator.
 * The caller may clone first when it needs transactional pre-commit behavior.
 * @param state - mutable strict replay accumulator.
 * @param event - next contiguous session event.
 */
export function applyScienceEvent(state: ScienceFoldState, event: SessionEvent): void {
  if (!Number.isSafeInteger(event.seq) || event.seq !== state.nextSeq) {
    throw new Error(`session event seq ${String(event.seq)} is discontinuous; expected ${String(state.nextSeq)}`)
  }
  if (!Number.isSafeInteger(event.time) || event.time < 0) {
    throw new Error(`session event ${String(event.seq)} has an invalid time`)
  }
  const domainEvent = decodeScienceDomainEvent(event)
  if (domainEvent !== undefined) {
    applyDomainEvent(state, domainEvent)
  } else {
    switch (event.type) {
      case 'step/start':
        if (state.mode === undefined) state.preModeStepStarted = true
        break
      case 'request/header':
        state.requestHeaders.push({ seq: event.seq, time: event.time })
        break
      case 'tool/call':
        state.toolCalls.push({ seq: event.seq, time: event.time, callId: event.data.callId })
        break
      case 'user/message':
      case 'assistant/message':
        state.messageFacts.push({ seq: event.seq, time: event.time })
        break
      case 'tool/result':
        state.messageFacts.push({ seq: event.seq, time: event.time })
        state.toolResults.push({
          seq: event.seq,
          time: event.time,
          callId: event.data.message.source.callId,
        })
        break
      case 'session/end-seed':
        applyEndSeed(state, event)
        break
      default:
        // SessionEventMap is merge-extensible; facts unrelated to Science do not change its strict state.
        break
    }
  }
  state.nextSeq += 1
}

/**
 * Strictly replay a complete contiguous event log into Science fold state.
 * @param events - complete event log or contiguous prefix starting at zero.
 * @returns the validated Science accumulator and supporting-reference indexes.
 */
export function foldScience(events: readonly SessionEvent[]): ScienceFoldState {
  const state = emptyScienceFoldState()
  for (const event of events) applyScienceEvent(state, event)
  return state
}

/**
 * Test whether one event type belongs to the durable Science vocabulary.
 * @param type - event type string to inspect.
 * @returns whether this package owns the type.
 */
export function isScienceDomainEventType(type: string): type is ScienceDomainEventType {
  return type === 'science/mode-bound'
    || type === 'science/environment-bound'
    || type === 'science/run-started'
    || type === 'science/run-finished'
    || type === 'science/chart-saved'
    || type === 'science/outcome-published'
}

/**
 * Return a stable key for one already-decoded evidence reference.
 * @param evidence - validated evidence reference.
 * @returns a deterministic kind-qualified identity.
 */
export function scienceEvidenceKey(evidence: ScienceEvidenceRef): string {
  switch (evidence.kind) {
    case 'run': return `run:${evidence.runId}`
    case 'chart': return `chart:${evidence.chartId}:${String(evidence.version)}`
    case 'message': return `message:${String(evidence.seq)}`
  }
}
