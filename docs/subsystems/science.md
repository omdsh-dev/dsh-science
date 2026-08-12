# Science session domain

English | [中文](science.zh.md)

The Science Session Domain owns compact, required-on-read facts and their deterministic projection. The [Science MVP Decision Record](../../.agents/notes/proposed/feature/2026-08-12-science-mode-core-mvp.md) owns the staged product decisions; this page records the durable vocabulary implemented by [`@deepseek-ai/dsh-science-session`](../../packages/science/science-session/README.md).

## Identity and applicability

`ScienceRunId`, `ScienceEnvironmentProfileId`, `ScienceChartId`, and `ScienceScratchKey` are [branded identifiers](core.md#branded-ids). A Session may contain Science events only when `SessionHeader.agentPreset` is `science`. The projection is `null` before the one mode binding; an absent `science` key means the package was not composed.

The mode event records only stable mode facts and must precede the first step, request header, or tool call. Run, chart, and Outcome records refer backward to the latest post-mode `request/header` that owns prompt and model provenance, plus one unique still-pending tool call that anchors the model action.

```ts type-equiv
/** The preset-bound Science mode identity recorded once per session. */
interface ScienceModeRef {
  /** Stable mode discriminator. */
  readonly modeId: 'science'
  /** Preset identity required by the Science invariant. */
  readonly presetId: 'science'
  /** Deployment-owned revision of the Science mode contract. */
  readonly modeRevision: string
}
```

## Environment facts

Environment revisions are positive and consecutive. The first run requires the latest revision to be `applied`; a later `invalid` or `drifted` observation blocks new runs, while a new applied revision cannot replace an environment after the first run. Each optional interpreter binding retains canonical identity and fingerprint facts without storing a package inventory or credential.

```ts type-equiv
/** Whole-value environment binding recorded at one monotonic revision. */
interface ScienceEnvironmentBinding {
  /** Positive session-local environment revision. */
  readonly revision: number
  /** Stable profile selected for the revision. */
  readonly profileId: ScienceEnvironmentProfileId
  /** Epoch milliseconds when configuration was selected. */
  readonly configuredAt: number
  /** Epoch milliseconds when validation completed. */
  readonly validatedAt: number
  /** Result of applying and validating the revision. */
  readonly status: ScienceEnvironmentStatus
  /** Python binding facts when the profile declares Python. */
  readonly python?: ScienceInterpreterBinding
  /** R binding facts when the profile declares R. */
  readonly r?: ScienceInterpreterBinding
  /** Stable human-readable failure or drift reason. */
  readonly failureReason?: string
}
```

## Runs, charts, and Outcome

A run start is a complete immutable execution identity. A finish repeats those fields and adds one terminal state. `interrupted` is never a finish payload: replay derives it only when `session/end-seed` closes a still-running record. Chart versions cite a successful run and immutable PNG attachment. Outcome revisions cite prior runs, chart versions, or messages without reading or mutating Goal state. Each tool call authorizes exactly one Science fact, and payload timestamps cannot precede their supporting facts.

```ts type-equiv
/** Run state served by the Science projection. */
type ScienceRun = ScienceRunStarted | ScienceRunTerminal | ScienceRunInterrupted
```

```ts type-equiv
/** Backward reference carried by a published Science outcome. */
type ScienceEvidenceRef =
  | ScienceRunEvidenceRef
  | ScienceChartEvidenceRef
  | ScienceMessageEvidenceRef
```

## Projection and validation

The strict fold rejects malformed payloads, discontinuous events and revisions, illegal lifecycle transitions, and missing or forward references. The invariant stages that fold before `Session.append()` commits. The fail-soft projection reuses strict payload decoders, ignores an invalid event already rejected by the invariant, and returns the same reference for unrelated events. Live and cold folds consume the same complete Session log, including inherited evidence and `session/end-seed`.

```ts type-equiv
/** Client-safe replay projection for a Science-bound session. */
interface ScienceProjection {
  /** The session's one durable Science mode binding. */
  readonly mode: ScienceModeRef
  /** Latest environment revision, or `null` before the first binding. */
  readonly environment: ScienceEnvironmentBinding | null
  /** All durable and replay-derived run states in start order. */
  readonly runs: readonly ScienceRun[]
  /** Every immutable chart version in commit order. */
  readonly charts: readonly ScienceChartVersion[]
  /** Latest published outcome revision, or `null` before publication. */
  readonly outcome: ScienceOutcomePublication | null
  /** Derived counters; never written independently to the session log. */
  readonly metrics: ScienceProjectionMetrics
  /** Sequence of the latest event that changed Science projection state. */
  readonly lastScienceEventSeq: number
}
```

Phase 1 deliberately provides no public mutation service, interpreter probe, process execution, tool, prompt, or UI. Producers in later phases may append one of the six typed events only after the external fact it describes has reached its documented commit point.
