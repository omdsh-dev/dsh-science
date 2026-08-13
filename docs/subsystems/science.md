# Science session domain

English | [中文](science.zh.md)

The Science Session Domain owns compact, required-on-read facts and their deterministic projection. [`@deepseek-ai/dsh-science-runtime`](../../packages/science/science-runtime/README.md) owns the host-local operation that observes configured Conda prefixes and appends environment/run facts through that domain. The [Science Mode execution chain](../science-mode.md) maps their cross-subsystem responsibilities and extension points; the [Science MVP Decision Record](../../.agents/notes/proposed/feature/2026-08-12-science-mode-core-mvp.md) owns the staged product decisions.

## Identity and applicability

`ScienceRunId`, `ScienceEnvironmentProfileId`, `ScienceChartId`, and `ScienceScratchKey` are [branded identifiers](core.md#branded-ids). A pure applicability policy admits Science events only when `SessionHeader.agentPreset` is `science` and requires a Science-preset Session to bind mode before host activity. The invariant owns that Session-container boundary. The projection is `null` before the one mode binding; an absent `science` key means the package was not composed.

The mode event records only stable mode facts and must precede the first step, request header, or tool call. Run, chart, and Outcome records refer backward to the latest post-mode `request/header` that owns prompt and model provenance, plus one unique still-pending tool call that anchors the model action. A result or owning `step/end` settles a call; Python and R runs, charts, and Outcomes respectively require `run_python` or `run_r`, `save_chart`, and `publish_outcome`.

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

Environment revisions are positive and consecutive. The first run requires the latest revision to be `applied`; a later `invalid` or `drifted` observation blocks new runs, while a new applied revision cannot replace an environment after the first run. An `available` interpreter binding retains its complete canonical identity and fingerprint. Failed capability records require a reason and keep only facts actually observed before failure, so an absent executable never needs a fabricated sentinel. Absolute path fields accept POSIX, Windows drive, and Windows UNC syntax without claiming that Phase 1 executes any interpreter.

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

A run start is a complete immutable execution identity. A finish repeats those fields and adds one terminal state. `interrupted` is never a finish payload: replay derives it only when `session/end-seed` closes a still-running record. Chart versions cite a successful run and immutable PNG attachment. Outcome revisions cite prior successful runs, chart versions, or messages without reading or mutating Goal state. Each tool call authorizes exactly one Science fact, and payload timestamps stay between their supporting facts and the owning event envelope time. The public projection remains metadata-only.

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

The strict fold rejects malformed payloads, discontinuous events and revisions, illegal lifecycle transitions, and missing or forward references. It is the one authority for Science event-stream transitions and provenance. Session-header applicability is an orthogonal policy because header metadata is not part of the event stream. The invariant composes that policy with the fold before `Session.append()` commits. `replayScience(events)` assumes an already admitted stream. The fail-soft live projection advances an encoded copy of the same accumulator instead of maintaining an independent reducer or duplicate provenance rules. Every committed event advances its private watermark; unrelated or malformed events leave the fold and witness unchanged and do not notify public readers. For admitted logs, live and cold paths consume inherited evidence and `session/end-seed`, and derive the same public value.

Private projection state is plain JSON `{ observedSeq, fold, witness }`. The empty watermark is `-1`; every committed event advances it, while the sparse redacted witness retains only the supporting facts required for strict replay. The `stateVersion: 2` registration gives the generic registry a `checkpointStateSchema` that validates the watermark, strictly replays the witness, and accepts a persisted row only when it reproduces the encoded fold exactly. Its pure `checkpointStateSeq` extractor additionally requires the embedded watermark to equal the row's outer `seq`. Schema admission applies only to untrusted checkpoints; the extractor also verifies rows when they are emitted, so the same embedded/outer-seq relation holds on both sides of persistence. Private state can change without changing the public projection, so `viewChanged` suppresses duplicate notifications. The public schema validates its JSON fields and derived metrics, not historical provenance transitions.

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

The package root exposes the durable identifiers, event types, strict decoders, and replay result that consumers need. Mutable fold state, transitions, witness construction, checkpoint validation, and projection-state operations stay internal. Incremental application avoids full-witness replay on every live event, but immutable collection copying and witness retention still grow with history; the implementation makes no constant-time claim and defers paging or compaction until measurement warrants it.

The runtime is the only Phase 2 owner of `science/environment-bound`, `science/run-started`, and `science/run-finished`. It requires an exact live Session, direct argv, an empty child environment base, full sandbox enforcement, private Host scratch, and whole-tree quiescence before terminal publication. It does not add a tool, prompt, preset, UI, chart, or Outcome consumer; later Consumers call `ctx.scienceRuntime` rather than appending runtime facts themselves.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxscienceruntime--scienceruntime"></a>

### `ctx.scienceRuntime` — `ScienceRuntime`

Folded local Science Runtime provider with public types free of Host paths.

```ts cordis-catalog
/**
 * Observe one configured existing Conda profile and append its whole-value
 * environment revision. Static unusability becomes an honest `invalid`
 * revision; capability, cancellation, and I/O failures append nothing.
 * @param request - Exact live Session, profile identity, and caller signal.
 * @returns The accepted durable environment revision.
 */
async bindEnvironment(request: BindScienceEnvironmentRequest): Promise<ScienceEnvironmentBinding>

/**
 * Publish a direct-argv run start, then settle exactly one matching terminal
 * fact after the shared subprocess provider proves tree quiescence.
 * @param request - Exact live Session, source, authorization facts, and cancellation.
 * @returns A handle exposed only after `science/run-started` committed.
 */
async startRun(request: StartScienceRunRequest): Promise<ScienceRunHandle>
```

Source: [`packages/science/science-runtime/src/index.ts:65`](../../packages/science/science-runtime/src/index.ts)
<!-- END GENERATED cordis-surface -->
