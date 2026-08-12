/** Fail-soft plain-JSON Science projection mathematics. */

import { isJsonValue } from '@deepseek-ai/dsh-session'
import type { JsonValue, SessionEvent } from '@deepseek-ai/dsh-session'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { ZodType } from 'zod'
import { applyScienceEvent, decodeScienceChart, decodeScienceDomainEvent, decodeScienceEnvironment, decodeScienceMode, decodeScienceOutcome, decodeScienceRunStarted, decodeScienceRunTerminal, emptyScienceFoldState } from './fold.ts'
import type {
  ScienceChartVersion,
  ScienceProjection,
  ScienceProjectionMetrics,
  ScienceProjectionState,
  ScienceProjectionWitnessEvent,
  ScienceRun,
  ScienceRunIdentity,
} from './types.ts'

/** Derive stable projection counters from whole-value collections. */
function metrics(runs: readonly ScienceRun[], charts: readonly ScienceChartVersion[], outcomeRevision: number): ScienceProjectionMetrics {
  return {
    runCount: runs.length,
    successfulRunCount: runs.filter(run => run.status === 'success').length,
    chartCount: new Set(charts.map(chart => chart.chartId)).size,
    chartVersionCount: charts.length,
    outcomeRevision,
  }
}

/** Rebuild one projection after changing domain collections. */
function replace(
  state: ScienceProjection,
  eventSeq: number,
  changes: Partial<Pick<ScienceProjection, 'environment' | 'runs' | 'charts' | 'outcome'>>,
): ScienceProjection {
  const runs = changes.runs ?? state.runs
  const charts = changes.charts ?? state.charts
  const outcome = changes.outcome === undefined ? state.outcome : changes.outcome
  return {
    mode: state.mode,
    environment: changes.environment === undefined ? state.environment : changes.environment,
    runs,
    charts,
    outcome,
    metrics: metrics(runs, charts, outcome?.revision ?? 0),
    lastScienceEventSeq: eventSeq,
  }
}

/** Build one JSON-safe canonical witness event. */
function projectionWitnessEvent(
  event: Pick<SessionEvent, 'seq' | 'time' | 'type'>,
  data: unknown,
): ScienceProjectionWitnessEvent {
  if (!Number.isSafeInteger(event.seq) || event.seq < 0
    || !Number.isSafeInteger(event.time) || event.time < 0
    || !isJsonValue(data)) {
    throw new Error('invalid projection witness event')
  }
  return { seq: event.seq, time: event.time, type: event.type, data: data as JsonValue }
}

/** Whether one Core turn or step coordinate can occur in a valid Session log. */
function validExecutionCoordinate(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

/** Whether one retained Core identity is usable by strict Science replay. */
function validCoreIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** Redact one Session event to the exact facts consumed by strict replay. */
function witnessEvent(event: SessionEvent): ScienceProjectionWitnessEvent | undefined {
  switch (event.type) {
    case 'science/mode-bound':
    case 'science/environment-bound':
    case 'science/run-started':
    case 'science/run-finished':
    case 'science/chart-saved':
    case 'science/outcome-published':
      if (event.ignorable === true) throw new Error('Science projection witness cannot omit required-event semantics')
      return projectionWitnessEvent(event, event.data)
    case 'step/start':
    case 'request/header':
    case 'user/message':
    case 'assistant/message':
    case 'session/end-seed':
      return projectionWitnessEvent(event, {})
    case 'step/end':
      if (!validExecutionCoordinate(event.data.turn)
        || !validExecutionCoordinate(event.data.step)) {
        throw new Error('invalid step/end projection witness')
      }
      return projectionWitnessEvent(event, { turn: event.data.turn, step: event.data.step })
    case 'tool/call': {
      if (!validExecutionCoordinate(event.data.turn)
        || !validExecutionCoordinate(event.data.step)
        || !validCoreIdentity(event.data.callId)
        || !validCoreIdentity(event.data.name)) {
        throw new Error('invalid tool/call projection witness')
      }
      return projectionWitnessEvent(event, {
        turn: event.data.turn,
        step: event.data.step,
        callId: event.data.callId,
        name: event.data.name,
      })
    }
    case 'tool/result': {
      if (!validCoreIdentity(event.data.message.source.callId)) {
        throw new Error('invalid tool/result projection witness')
      }
      return projectionWitnessEvent(event, {
        message: { source: { callId: event.data.message.source.callId } },
      })
    }
    default:
      return undefined
  }
}

/** Whether one pre-mode event permanently makes a later mode binding illegal. */
function preventsModeBinding(event: Pick<ScienceProjectionWitnessEvent, 'type'>): boolean {
  return event.type === 'step/start'
    || event.type === 'request/header'
    || event.type === 'tool/call'
}

/** Whether strict replay can need this event if mode has not yet been bound. */
function relevantBeforeMode(event: SessionEvent): boolean {
  return event.type.startsWith('science/')
    || preventsModeBinding(event)
    || event.type === 'user/message'
    || event.type === 'assistant/message'
    || event.type === 'tool/result'
}

/** Derive the public value from one accepted strict fold accumulator. */
function projectionFromFold(state: ReturnType<typeof emptyScienceFoldState>): ScienceProjection | null {
  if (state.mode === undefined || state.lastScienceEventSeq === undefined) return null
  const outcome = state.outcomes.at(-1) ?? null
  return {
    mode: state.mode,
    environment: state.environments.at(-1) ?? null,
    runs: state.runs,
    charts: state.charts,
    outcome,
    metrics: metrics(state.runs, state.charts, outcome?.revision ?? 0),
    lastScienceEventSeq: state.lastScienceEventSeq,
  }
}

/** Strictly replay a sparse witness; omitted seqs stand for irrelevant events. */
function replayWitness(witness: readonly ScienceProjectionWitnessEvent[]): ScienceProjection | null {
  const state = emptyScienceFoldState()
  let previousSeq = -1
  for (const candidate of witness) {
    if (candidate.seq <= previousSeq) throw new Error('projection witness seq must strictly increase')
    if (candidate.type === 'session/end-seed'
      && !state.runs.some(run => run.status === 'running')) {
      throw new Error('projection witness retains an irrelevant seed boundary')
    }
    previousSeq = candidate.seq
    state.nextSeq = candidate.seq
    applyScienceEvent(state, candidate as SessionEvent)
  }
  return projectionFromFold(state)
}

/** Compare start-owned fields repeated in a run terminal value. */
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

/** Apply one already-decoded domain event, failing on local discontinuities. */
function applyDomainProjection(
  state: ScienceProjection | null,
  event: NonNullable<ReturnType<typeof decodeScienceDomainEvent>>,
): ScienceProjection {
  switch (event.type) {
    case 'science/mode-bound':
      if (state !== null) throw new Error('duplicate Science mode binding')
      return {
        mode: event.data.mode,
        environment: null,
        runs: [],
        charts: [],
        outcome: null,
        metrics: metrics([], [], 0),
        lastScienceEventSeq: event.seq,
      }
    case 'science/environment-bound': {
      if (state === null) throw new Error('environment before mode')
      const expected = (state.environment?.revision ?? 0) + 1
      if (event.data.environment.revision !== expected) throw new Error('environment revision discontinuity')
      if (state.runs.length > 0 && event.data.environment.status === 'applied') {
        throw new Error('applied environment replacement after first run')
      }
      if (event.data.environment.validatedAt > event.time) throw new Error('environment time after event')
      return replace(state, event.seq, { environment: event.data.environment })
    }
    case 'science/run-started': {
      if (state === null || state.environment === null) throw new Error('run before environment')
      const run = event.data.run
      const binding = run.language === 'python' ? state.environment.python : state.environment.r
      const previousRun = state.runs.at(-1)
      if (state.environment.status !== 'applied'
        || run.environmentRevision !== state.environment.revision
        || binding === undefined
        || binding.capability !== 'available'
        || binding.bindingFingerprint !== run.environmentFingerprint
        || run.startedAt < state.environment.validatedAt
        || (previousRun !== undefined
          && previousRun.status !== 'running'
          && run.startedAt < previousRun.finishedAt)
        || run.startedAt > event.time
        || state.runs.some(candidate => candidate.runId === run.runId
          || candidate.status === 'running'
          || candidate.toolCallId === run.toolCallId)
        || state.charts.some(candidate => candidate.toolCallId === run.toolCallId)
        || state.outcome?.toolCallId === run.toolCallId) {
        throw new Error('invalid run start transition')
      }
      return replace(state, event.seq, { runs: [...state.runs, run] })
    }
    case 'science/run-finished': {
      if (state === null) throw new Error('run finish before mode')
      const index = state.runs.findIndex(candidate => candidate.runId === event.data.run.runId)
      const current = state.runs[index]
      if (current === undefined || current.status !== 'running' || !sameRunIdentity(current, event.data.run)) {
        throw new Error('invalid run finish transition')
      }
      if (event.data.run.finishedAt > event.time) throw new Error('run finish time after event')
      const runs = [...state.runs]
      runs[index] = event.data.run
      return replace(state, event.seq, { runs })
    }
    case 'science/chart-saved': {
      if (state === null) throw new Error('chart before mode')
      const chart = event.data.chart
      const run = state.runs.find(candidate => candidate.runId === chart.runId)
      if (run === undefined || run.status !== 'success') throw new Error('chart without successful run')
      if (state.runs.some(candidate => candidate.toolCallId === chart.toolCallId)
        || state.charts.some(candidate => candidate.toolCallId === chart.toolCallId)
        || state.outcome?.toolCallId === chart.toolCallId) {
        throw new Error('chart reuses a consumed tool call')
      }
      if (chart.environmentRevision !== run.environmentRevision
        || chart.environmentFingerprint !== run.environmentFingerprint
        || chart.createdAt < run.finishedAt
        || chart.createdAt > event.time) {
        throw new Error('invalid chart provenance')
      }
      const logical = state.charts.filter(candidate => candidate.logicalName === chart.logicalName)
      if (logical.length === 0) {
        if (chart.version !== 1 || state.charts.some(candidate => candidate.chartId === chart.chartId)) {
          throw new Error('invalid first chart version')
        }
      } else {
        const latest = logical.at(-1)
        /* v8 ignore next -- the branch is entered only when logical is non-empty */
        if (latest === undefined) throw new Error('logical chart history disappeared during synchronous replay')
        if (chart.chartId !== latest.chartId
          || chart.version !== latest.version + 1
          || chart.createdAt < latest.createdAt) {
          throw new Error('chart version discontinuity')
        }
      }
      return replace(state, event.seq, { charts: [...state.charts, chart] })
    }
    case 'science/outcome-published': {
      if (state === null || event.data.outcome.revision !== (state.outcome?.revision ?? 0) + 1) {
        throw new Error('outcome revision discontinuity')
      }
      if (event.data.outcome.publishedAt > event.time
        || (state.outcome !== null && event.data.outcome.publishedAt < state.outcome.publishedAt)) {
        throw new Error('outcome time discontinuity')
      }
      if (state.runs.some(candidate => candidate.toolCallId === event.data.outcome.toolCallId)
        || state.charts.some(candidate => candidate.toolCallId === event.data.outcome.toolCallId)
        || state.outcome?.toolCallId === event.data.outcome.toolCallId) {
        throw new Error('outcome reuses a consumed tool call')
      }
      const citedEnvironmentRevisions = new Set<number>()
      for (const evidence of event.data.outcome.evidence) {
        if (evidence.kind === 'run') {
          const run = state.runs.find(candidate => candidate.runId === evidence.runId)
          if (run === undefined
            || run.status !== 'success'
            || event.data.outcome.publishedAt < run.finishedAt) {
            throw new Error('outcome references an unavailable run')
          }
          citedEnvironmentRevisions.add(run.environmentRevision)
        }
        if (evidence.kind === 'chart') {
          const chart = state.charts.find(candidate => candidate.chartId === evidence.chartId
            && candidate.version === evidence.version)
          if (chart === undefined || event.data.outcome.publishedAt < chart.createdAt) {
            throw new Error('outcome references an unavailable chart')
          }
          citedEnvironmentRevisions.add(chart.environmentRevision)
        }
      }
      if (citedEnvironmentRevisions.size !== event.data.outcome.environmentRevisions.length
        || event.data.outcome.environmentRevisions.some(revision => !citedEnvironmentRevisions.has(revision))) {
        throw new Error('outcome environment provenance is not the exact cited set')
      }
      return replace(state, event.seq, { outcome: event.data.outcome })
    }
  }
}

/** Apply the replay-derived interrupted state at a seed boundary. */
function applyEndSeed(state: ScienceProjection | null, event: SessionEvent<'session/end-seed'>): ScienceProjection | null {
  if (state === null || !state.runs.some(run => run.status === 'running')) return state
  if (!Number.isSafeInteger(event.time) || event.time < 0
    || state.runs.some(run => run.status === 'running' && run.startedAt > event.time)) return state
  const runs = state.runs.map((run): ScienceRun => run.status === 'running'
    ? { ...run, status: 'interrupted', finishedAt: event.time, interruptedAtSeq: event.seq }
    : run)
  return replace(state, event.seq, { runs })
}

/**
 * Fold one event into the Science projection. Malformed Science events are
 * ignored here so read-side availability cannot corrupt the host; the strict
 * fold and package invariant remain the fail-loud correctness authorities.
 * @param state - projection after all prior events.
 * @param event - next committed session event.
 * @returns updated projection or the same reference when state did not change.
 */
export function applyScienceProjection(
  state: ScienceProjection | null,
  event: SessionEvent,
): ScienceProjection | null {
  if (!Number.isSafeInteger(event.seq) || event.seq < 0
    || !Number.isSafeInteger(event.time) || event.time < 0
    || (state !== null && event.seq <= state.lastScienceEventSeq)) return state
  if (event.type === 'session/end-seed') return applyEndSeed(state, event)
  if (!event.type.startsWith('science/')) return state
  try {
    const decoded = decodeScienceDomainEvent(event)
    return decoded === undefined ? state : applyDomainProjection(state, decoded)
  } catch {
    return state
  }
}

/**
 * Fold one event into the persisted Science projection cache state.
 * The private redacted witness keeps checkpoint provenance verifiable while
 * the public value remains metadata-only and client-safe.
 * @param state - internal projection cache after all prior events.
 * @param event - next committed Session event.
 * @returns updated cache state or the same reference when Science is unchanged.
 */
export function applyScienceProjectionState(
  state: ScienceProjectionState,
  event: SessionEvent,
): ScienceProjectionState {
  try {
    if (state.value === null) {
      if (state.witness.some(preventsModeBinding) || !relevantBeforeMode(event)) return state
    }
    const hadRunningRun = state.value?.runs.some(run => run.status === 'running') === true
    if (event.type === 'session/end-seed' && !hadRunningRun) return state
    const redacted = witnessEvent(event)
    if (redacted === undefined) return state
    const witness = [...state.witness, redacted]
    return { value: replayWitness(witness), witness }
  } catch {
    return state
  }
}

/**
 * Build the empty internal Science projection cache state.
 * @returns a cache state before any Session event has been observed.
 */
export function emptyScienceProjectionState(): ScienceProjectionState {
  return { value: null, witness: [] }
}

/** Whether a candidate is a plain JSON record. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Require an exact key set. */
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}

/** Validate one replay-derived interrupted run. */
function validInterruptedRun(value: unknown): boolean {
  const candidate = record(value)
  if (candidate === undefined || candidate['status'] !== 'interrupted') return false
  const { status: _status, finishedAt, interruptedAtSeq, ...identity } = candidate
  try {
    const start = decodeScienceRunStarted({ ...identity, status: 'running' })
    return typeof finishedAt === 'number'
      && Number.isSafeInteger(finishedAt)
      && finishedAt >= start.startedAt
      && typeof interruptedAtSeq === 'number'
      && Number.isSafeInteger(interruptedAtSeq)
      && interruptedAtSeq >= 0
  } catch {
    return false
  }
}

/** Validate one run union member served by the projection. */
function validRun(value: unknown): boolean {
  const candidate = record(value)
  if (candidate === undefined) return false
  try {
    if (candidate['status'] === 'running') decodeScienceRunStarted(value)
    else if (candidate['status'] === 'interrupted') return validInterruptedRun(value)
    else decodeScienceRunTerminal(value)
    return true
  } catch {
    return false
  }
}

/** Validate relationships that remain expressible in the compact projection. */
function validProjectionRelations(
  environment: ScienceProjection['environment'],
  runs: readonly ScienceRun[],
  charts: readonly ScienceChartVersion[],
  outcome: ScienceProjection['outcome'],
  lastScienceEventSeq: number,
): boolean {
  if (environment === null) {
    if (runs.length > 0 || charts.length > 0
      || (outcome !== null && outcome.environmentRevisions.length > 0)) return false
  } else if (runs.some(run => run.environmentRevision > environment.revision)) {
    return false
  }
  const runEnvironmentRevision = runs[0]?.environmentRevision
  if (runEnvironmentRevision !== undefined
    && runs.some(run => run.environmentRevision !== runEnvironmentRevision)) return false
  if (environment !== null && runEnvironmentRevision !== undefined) {
    if (runEnvironmentRevision === environment.revision) {
      if (environment.status !== 'applied') return false
      for (const run of runs) {
        const binding = run.language === 'python' ? environment.python : environment.r
        if (binding === undefined
          || binding.capability !== 'available'
          || binding.bindingFingerprint !== run.environmentFingerprint
          || run.startedAt < environment.validatedAt) return false
      }
    } else if (environment.status === 'applied') {
      return false
    }
  }
  if (new Set(runs.map(run => run.runId)).size !== runs.length) return false
  if (runs.some(run => run.requestHeaderSeq >= lastScienceEventSeq
    || (run.status === 'interrupted'
      && (run.interruptedAtSeq <= run.requestHeaderSeq
        || run.interruptedAtSeq > lastScienceEventSeq)))) return false
  const runningIndex = runs.findIndex(run => run.status === 'running')
  if (runningIndex >= 0 && runningIndex !== runs.length - 1) return false
  let previousRun: ScienceRun | undefined
  for (const current of runs) {
    if (previousRun !== undefined
      && (previousRun.status === 'running' || current.startedAt < previousRun.finishedAt)) return false
    previousRun = current
  }

  const chartHeads = new Map<string, ScienceChartVersion>()
  for (const chart of charts) {
    const run = runs.find(candidate => candidate.runId === chart.runId)
    if (chart.requestHeaderSeq >= lastScienceEventSeq
      || run === undefined || run.status !== 'success'
      || run.environmentRevision !== chart.environmentRevision
      || run.environmentFingerprint !== chart.environmentFingerprint
      || chart.createdAt < run.finishedAt) return false
    const head = chartHeads.get(chart.logicalName)
    if (head === undefined) {
      if (chart.version !== 1
        || [...chartHeads.values()].some(candidate => candidate.chartId === chart.chartId)) return false
    } else if (chart.chartId !== head.chartId
      || chart.version !== head.version + 1
      || chart.createdAt < head.createdAt) {
      return false
    }
    chartHeads.set(chart.logicalName, chart)
  }

  if (outcome === null) return true
  if (outcome.requestHeaderSeq >= lastScienceEventSeq) return false
  const citedRevisions = new Set<number>()
  for (const evidence of outcome.evidence) {
    if (evidence.kind === 'run') {
      const run = runs.find(candidate => candidate.runId === evidence.runId)
      if (run === undefined || run.status !== 'success') return false
      if (outcome.publishedAt < run.finishedAt) return false
      citedRevisions.add(run.environmentRevision)
    } else if (evidence.kind === 'chart') {
      const chart = charts.find(candidate => candidate.chartId === evidence.chartId
        && candidate.version === evidence.version)
      if (chart === undefined) return false
      if (outcome.publishedAt < chart.createdAt) return false
      citedRevisions.add(chart.environmentRevision)
    } else if (evidence.seq >= lastScienceEventSeq) {
      return false
    }
  }
  return citedRevisions.size === outcome.environmentRevisions.length
    && outcome.environmentRevisions.every(revision => citedRevisions.has(revision))
}

/** Ensure each projected model authorization belongs to exactly one Science fact. */
function validToolCallOwnership(
  runs: readonly ScienceRun[],
  charts: readonly ScienceChartVersion[],
  outcome: ScienceProjection['outcome'],
): boolean {
  const callIds = [
    ...runs.map(run => run.toolCallId),
    ...charts.map(chart => chart.toolCallId),
    ...(outcome === null ? [] : [outcome.toolCallId]),
  ]
  return new Set(callIds).size === callIds.length
}

/** Validate the complete projection value, including its derived counters. */
function validProjection(value: unknown): value is ScienceProjection | null {
  if (value === null) return true
  if (!isJsonValue(value)) return false
  const candidate = record(value)
  if (candidate === undefined || !exactKeys(candidate, [
    'mode',
    'environment',
    'runs',
    'charts',
    'outcome',
    'metrics',
    'lastScienceEventSeq',
  ])) return false
  try {
    decodeScienceMode(candidate['mode'])
    const environment = candidate['environment'] === null
      ? null
      : decodeScienceEnvironment(candidate['environment'])
    if (!Array.isArray(candidate['runs']) || !candidate['runs'].every(validRun)) return false
    if (!Array.isArray(candidate['charts'])) return false
    const charts = candidate['charts'].map(value => decodeScienceChart(value))
    const outcome = candidate['outcome'] === null
      ? null
      : decodeScienceOutcome(candidate['outcome'])
    const lastScienceEventSeq = candidate['lastScienceEventSeq'] as number
    if (!Number.isSafeInteger(lastScienceEventSeq) || lastScienceEventSeq < 0) return false
    const storedMetrics = record(candidate['metrics'])
    if (storedMetrics === undefined || !exactKeys(storedMetrics, [
      'runCount',
      'successfulRunCount',
      'chartCount',
      'chartVersionCount',
      'outcomeRevision',
    ])) return false
    const runs = candidate['runs'] as unknown as ScienceRun[]
    if (!validProjectionRelations(environment, runs, charts, outcome, lastScienceEventSeq)
      || !validToolCallOwnership(runs, charts, outcome)) return false
    const minimumScienceEventCount = 1
      + (environment?.revision ?? 0)
      + runs.length
      + runs.filter(run => run.status !== 'running').length
      + charts.length
      + (outcome?.revision ?? 0)
    const authorizationCount = runs.length + charts.length + (outcome?.revision ?? 0)
    const currentMessageEvidenceCount = outcome?.evidence
      .filter(evidence => evidence.kind === 'message').length ?? 0
    const minimumSessionEventCount = minimumScienceEventCount
      + authorizationCount
      + (authorizationCount === 0 ? 0 : 1)
      + currentMessageEvidenceCount
    if (lastScienceEventSeq < minimumSessionEventCount - 1) return false
    const expectedMetrics = metrics(runs, charts, outcome?.revision ?? 0)
    return Object.entries(expectedMetrics)
      .every(([key, expected]) => storedMetrics[key] === expected)
  } catch {
    return false
  }
}

/** Wire validator for the Science projection registration. */
export const scienceProjectionSchema: ZodType<ScienceProjection | null> = z.custom<ScienceProjection | null>(
  validProjection,
  { message: 'invalid Science projection value' },
)

/** Validate internal checkpoint state before its public value is served. */
function validProjectionState(value: unknown): value is ScienceProjectionState {
  try {
    if (!isJsonValue(value)) return false
    const candidate = record(value)
    if (candidate === undefined || !exactKeys(candidate, ['value', 'witness'])) return false
    if (!validProjection(candidate['value'])) return false
    if (!Array.isArray(candidate['witness'])) return false
    const witness = candidate['witness'].map((raw): ScienceProjectionWitnessEvent => {
      const event = record(raw)
      if (event === undefined || !exactKeys(event, ['seq', 'time', 'type', 'data'])
        || typeof event['type'] !== 'string') throw new Error('malformed projection witness event')
      const normalized = witnessEvent(event as unknown as SessionEvent)
      if (normalized === undefined || !isDeepStrictEqual(normalized, event)) {
        throw new Error('non-canonical projection witness event')
      }
      return normalized
    })
    return isDeepStrictEqual(replayWitness(witness), candidate['value'])
  } catch {
    return false
  }
}

/** Wire validator for persisted internal Science projection checkpoints. */
export const scienceProjectionStateSchema: ZodType<ScienceProjectionState> = z.custom<ScienceProjectionState>(
  validProjectionState,
  { message: 'invalid Science projection checkpoint state' },
)
