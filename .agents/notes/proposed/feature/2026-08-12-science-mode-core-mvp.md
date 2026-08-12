# Agent Note: DSH Science Mode core MVP

Status: proposed

English | [中文](2026-08-12-science-mode-core-mvp.zh.md)

## Problem

DSH can already persist Session events, project durable state, select per-session presets, confine processes, and store immutable image attachments. It does not own a Science-specific domain that answers which environment and prompt produced a run, which run produced a chart version, or which evidence supports a published research Outcome. Building only a Python or R tool would leave those facts in tool prose and make refresh, resume, fork, and audit disagree.

CSSwitch and repositories under the private `dsh-external` organization are not the owner of these semantics. They may provide implementation evidence for process ownership, but DSH Science Mode is a native DSH feature. Its durable facts must follow the Session log and the [Session projection design](../architecture/2026-07-27-session-projection-and-command-log.md).

The first release must also avoid implying parity with Claude Science. Persistent kernels, environment management, generic artifacts, scientific review, remote compute, and release acceptance each need contracts that this MVP does not provide.

## Proposal

Add Science Mode as four cooperating layers: a Science preset and model-facing tools, a provider-neutral runtime with a local Conda provider, a Science Session domain, and a client view in the existing Details column. The Session log is the only durable authority. Runtime handles and mutable scratch files remain process or filesystem state and never become a second Session database.

Development advances one phase at a time. Every phase receives a separate local commit, focused verification, fresh independent review, and a stop before the next phase. The Science work is seeded from exact DSH source `b509e331458534eae524c1807fb4a185e4d28834` in a standalone local repository with no configured remote. It does not modify the existing DSH working tree, create a public repository, touch `dsh-external`, or upload changes.

## Product decisions

| Subject | MVP decision | Consequence |
|---|---|---|
| Outcome | A model-published current research result plus backward evidence references; it is not a Goal or independent review | Publishing never starts or continues execution |
| Charts | Immutable PNG versions only | SVG, HTML, PDF, tables, notebooks, visual diff, restore, and deletion are deferred |
| Environments | Bind allowlisted existing Conda prefixes only | The MVP never creates, clones, upgrades, installs into, or deletes an environment |
| Python and R | Each language may use a different prefix or the same prefix | Availability and drift are reported independently |
| Execution | One fresh process per call | Variables do not persist; explicit files under `state/` carry cross-call state |
| UI | Outcome, Charts, Environment, and Conversation appear in the existing right Details column | The left navigation and generic tool details retain their owners |
| Development isolation | Standalone clean local repository, seeded from the exact DSH commit, with no remote | Existing DSH `ui-journey` changes and all external repositories remain untouched |

## Package ownership

| Package | Responsibility in the complete MVP |
|---|---|
| `@deepseek-ai/dsh-science-session` | Science events, types, strict replay fold, projection, and invariant companion |
| `@deepseek-ai/dsh-science-runtime` | Provider-neutral environment, binding, run, cancellation, and failure types |
| `@deepseek-ai/dsh-science-runtime-local` | Conda prefix validation, clean environment, confinement, owned process tree, output limits, and scratch layout |
| `@deepseek-ai/dsh-tool-science` | Model-visible Science tools that call the domain and runtime services without spawning directly |
| `@deepseek-ai/dsh-client-ui-science` | Read-only projection consumption and the four Science Details tabs |
| Built-in Science preset | Per-session prompt and tool composition; Host-plane runtime and projection services remain outside the isolated preset |

## Science Session domain

### Applicability and mode

The Host registers one `science` projection unit. Its value is `null` until the first valid `science/mode-bound` event, including for Standard sessions; a missing projection key means the Science package is not composed. `science/mode-bound` is legal only when `session.header.agentPreset === 'science'`, occurs once, precedes the first step, request-header, or tool-call fact, and records the fixed mode ID, preset, and a human-maintained mode revision. Every run, chart, or Outcome `requestHeaderSeq` names the latest post-mode header and links its logged prompt plus safe provider/model identity; each record also names one unique, still-pending model tool call after that header. A tool call authorizes exactly one Science fact and cannot be reused after consumption or settlement. A result for that call or the end of its owning step settles it.

### Environment

An environment record has a positive consecutive revision, profile identity, configured and validated times, and independent optional Python and R interpreter bindings. Each binding records configured and canonical prefixes, canonical executable, executable stat identity, language version, `conda-meta/history` digest, `bindingFingerprint-v1`, and one of `available`, `unavailable`, `invalid`, or `drifted`. The fingerprint is not a package lock. A first run requires the latest environment to be `applied`; after the first run, no new `applied` revision may replace it. Later validation may append an `invalid` or `drifted` revision and block new authoritative runs.

### Runs and recovery

`ScienceRunId`, `ScienceEnvironmentProfileId`, `ScienceChartId`, and `ScienceScratchKey` are package-owned branded strings. Numeric environment, chart, and Outcome revisions are positive consecutive counters rather than opaque IDs. Existing `SessionId`, `CallId`, and `AttachmentId` types retain their current owners.

A run start records language, tool call, request-header seq, environment revision and fingerprint, start time, code digest, scratch identity, and a relative `runs/<run-id>/` reference. Python and R starts require pending `run_python` and `run_r` calls respectively. The referenced tool call already identifies its turn and step, so the Science record does not copy them. A run finish carries the complete terminal run value. The strict fold rejects any finish whose immutable start fields differ, whose time precedes the start, or whose status is not `success`, `failed`, `timed-out`, or `cancelled`.

Only `session/end-seed` derives `interrupted`: at each marker the projection replaces every still-running run before that marker with an interrupted view. It does not append another execution event. A normal aborted turn, caller cancellation, or service disposal must settle the owned process tree and append `science/run-finished` with `cancelled` in the runtime phase.

### Chart versions

A chart record contains a stable chart ID, normalized logical name, positive consecutive version, immutable `ImageAttachmentRef`, title and optional caption, successful source run, pending `save_chart` call, request-header seq, environment revision and fingerprint, and creation time. The event envelope supplies the record's sequence. Phase 1 accepts only `image/png` and only a successful run already present in the same folded log. Version creation times never move backwards. A future diagnostic override for failed runs needs a new decision; the MVP does not infer one.

### Outcome

An Outcome publication contains a positive consecutive revision, title, bounded Markdown summary, at least one backward run, chart-version, or message-seq reference, publication time, the unique pending `publish_outcome` tool call, request-header seq, and the exact sorted set of applied environment revisions used by its run or chart evidence. That set is empty for message-only evidence. The call anchors the model action; the request-header reference supplies its logged prompt and safe provider/model identity without copying them. Publication implies `published`; a newer revision makes the older event historically superseded without rewriting it. The projection exposes only the latest Outcome.

Evidence references deliberately omit a Session ID. The strict fold and invariant receive the exact owning Session stream and resolve IDs only in that stream. A foreign reference therefore cannot resolve and is rejected before append. This keeps forked seed evidence locally referential without creating runtime pointers back to the parent Session.

Outcome and Goal are independent domains. Outcome operations never read or mutate `ctx.goals`, Goal changes never publish or supersede an Outcome, and neither durable event payload references the other domain.

## Events, replay, and projection

| Event | Complete payload meaning | Commit point |
|---|---|---|
| `science/mode-bound` | One immutable Science mode snapshot | Before the first Science step or run; no request fact is copied |
| `science/environment-bound` | One complete consecutive environment revision | After validation has produced a stable observation |
| `science/run-started` | One complete running-run snapshot | Before the runtime phase attempts spawn |
| `science/run-finished` | One complete terminal-run snapshot matching its start | After the owned process tree is fully settled |
| `science/chart-saved` | One immutable chart version and provenance snapshot | After attachment bytes are durable |
| `science/outcome-published` | One complete consecutive Outcome publication | After every backward evidence reference validates |

All six events are log-only, required-on-read, lossless JSON, and whole values rather than patches. Their strict decoder rejects unknown fields, unsupported versions, malformed branded strings, non-finite or unsafe numbers, oversized fields, invalid discriminants, and discontinuous transitions. Science event times may equal but never precede the previous Science event time. A payload timestamp cannot precede any request, tool-call, durable source-run, chart, or message fact it claims as authorization or evidence. The Session envelope remains authoritative for event seq and time; domain payloads keep only timestamps or seq values that refer to another fact.

The pure synchronous strict fold is the authority for invariant checks and fail-loud replay tests. The invariant companion stages that fold on `internal/dispatch` so a violation rejects before `session/event` commits. The projection apply function reuses the strict payload decoders and independently enforces local projection transitions while preserving availability: unrelated or malformed events return the same state reference. Tests require the strict fold and the projection to produce equivalent Science values for every valid live and cold log.

The `science` projection registration begins at `stateVersion: 1`. The public value contains mode, current environment, complete run summaries, chart-version metadata, latest Outcome, conversation metrics derived only from those facts, and `lastScienceEventSeq`. Its private checkpoint state also retains a sparse, redacted replay witness: event sequence, time and type; complete Science payloads; and only the call identity, tool name, step coordinates, or evidence identity needed from supporting Core events. Request-header bodies, tool arguments, and message content are omitted. A restored checkpoint is served only when strict replay of that witness derives the exact stored public value. Binary attachment data, code, stdout, stderr, logs, and Host absolute attachment paths never enter the public projection. Changing the private state structure or fold semantics increments the registration version rather than putting a version field inside the public value.

## Phase 1 append boundary

Phase 1 introduces no public mutation service. Its tests append typed, complete event payloads through the existing `Session.append()` boundary; the invariant companion strictly folds each candidate before commit, so a rejected event appends nothing. Runtime and tool consumers define their caller-facing mutation operations only when those consumers exist in later phases.

The package does not probe an interpreter, create directories, spawn a process, read attachment bytes, expose tool schemas, inspect Goal state, or render UI. Those actions belong to later providers and consumers. Phase 1 tests may pass already-validated domain snapshots, but they may not simulate runtime success as live evidence.

## Scratch, execution, and process ownership

The local provider uses `<DSH_HOME>/science/v1/owners/<session-key>.json` for a provider-owned identity record and `<DSH_HOME>/science/v1/sessions/<session-key>/` for the writable Session root. The key is `lowerhex(SHA-256(UTF-8("dsh-science-session-v1\0" + exactSessionId)))`. Resume reuses the same key and directories; fork receives a new Session ID, new key, empty `home/`, `state/`, and `runs/`, while inherited event seed and immutable attachments remain replayable evidence.

Each run owns `runs/<run-id>/code.py` or `code.R`, `tmp/`, and `artifacts/`. Its cwd is the run directory, `HOME` is the Session `home/`, `TMPDIR` is the run `tmp/`, and explicit `SCIENCE_STATE_DIR` and `SCIENCE_ARTIFACT_DIR` point to their owned directories. Code is UTF-8 mode `0600`, flushed before spawn, executed by explicit argv with stdin `/dev/null`, and hashed from the exact file bytes. No shell string chooses the executable or code path.

One Session permits one active Python-or-R run. A second request returns `run-busy` before events or directories and never queues silently. Every acquired lease is released in `finally`. Cancellation and disposal terminate only exact owned handles or process groups and await quiescence; neither process cleanup nor Session disposal deletes a Conda prefix or Science scratch.

The provider starts with an empty environment plus an explicit allowlist. It never inherits provider credentials, `SSH_AUTH_SOCK`, user package paths, or ambient `DSH_*`. Default timeout is 120 seconds with a user-configurable maximum of 600 seconds; stdout and stderr each cap at 64,000 bytes; TERM-to-KILL grace is 3 seconds. The model cannot choose interpreter paths, code paths, or timeouts.

## Prompt compaction prerequisite

Science environment context must be model-visible and reconstructable in the same request that uses it. Before Science tools ship, Core must ensure that pressure compaction, overflow retry, clear, unchanged-context reuse, and cold resume all re-emit a runtime-context snapshot in the same request when a surface replacement removed the retained copy. Science does not add another context database or delivery path.

## Threat model

Science MVP is trusted local code execution with file-write confinement, not a confidentiality sandbox. A clean environment prevents ambient environment-variable credentials from being injected, and existing Conda prefixes remain read-only, but the current sandbox does not prevent code from reading other files or using the network. User-visible limitations must state this in the preset, Environment view, and Science documentation.

The hard guarantees are narrower: no automatic package installation or environment deletion; no credential, chart binary, base64, browser object URL, or Host absolute attachment path in Session events; no chart path outside the current run's `artifacts/`; no model-selected executable or timeout; and no source, fixture, or static test result described as live execution.

## Delivery stages

| Phase | Scope | Exit condition |
|---|---|---|
| 0 | Freeze this decision and establish isolated local source | Formal Agent Note committed; no product code |
| 1 | Science Session events, types, strict fold, projection, invariants, and replay tests | Malformed or discontinuous streams fail loudly; live and cold results match; no public mutation service, UI, model, process, Conda, Python, or R work |
| 2 | Runtime Service Definition and local Conda provider | Fake-prefix CI coverage plus separately reported real-machine acceptance; owned trees settle; environment prefixes remain unchanged |
| 3 | Core compaction prerequisite, Science preset, prompt, state query, and Python/R tools | Science prompt and tools are preset-scoped and every used environment context is durable and model-visible |
| 4 | PNG save and Outcome publication consumers | Immutable versions and backward evidence validation replay identically |
| 5 | Generic Details extension and Science client UI | Four accessible tabs render only projection truth; Standard sessions have no entry |
| 6 | Composition, built-package checks, local MVP source closure | All named source checks pass and fresh review has no HIGH or BLOCK finding; publishing remains separately authorized |

Phase 1 changes only the domain package and repository metadata required to register and document that package. It does not pre-create Runtime, Tool, preset, attachment consumer, or Client packages.

## Alternatives considered

**Reuse Goal for Outcome.** Rejected because Goal carries continuation authority and mutable lifecycle phases, while an Outcome is an append-only result publication with evidence. Combining them would let a result accidentally drive execution and would make Goal completion rewrite research history.

**Store Science truth in tool results or a UI database.** Rejected because cold resume and fork would need a second reconciliation protocol, and the UI could disagree with the authoritative Session log. Tool call arguments and results retain code and output; Science events retain compact provenance and state.

**Use CSSwitch or `dsh-external` as the Science implementation owner.** Rejected because those repositories do not own DSH Outcome, chart-version, environment, conversation, or Session projection semantics. This change remains local to the DSH source line and creates no external mirror.

**Start with persistent Python and R kernels.** Rejected because kernel ownership, crash recovery, hidden mutable variables, package drift, and process disposal would dominate the MVP before the durable product loop is tested. Fresh processes plus explicit `state/` make cross-call state visible.

**Manage Conda environments in the MVP.** Rejected because creation, installation, upgrade, locking, approval, and cleanup form a separate capability with larger security and reproducibility obligations. Binding existing prefixes is sufficient to test the product loop.

**Treat the current sandbox as secret isolation.** Rejected because its policy controls file writes, not reads or networking. A container, microVM, or remote runtime is the correct future option when confidentiality is required.

## Acceptance criteria

The complete MVP is accepted only when a Science preset can be created, resumed, and forked; environment identity and drift are explicit; Python and R execution is bounded and owned; chart and Outcome provenance is durable; the four Details tabs rebuild from cold projection; Standard behavior is unchanged; the threat model is visible; named source, composition, built-package, GUI, and replay checks pass; and a fresh independent review has no HIGH or BLOCK finding.

CI fake-prefix evidence and real-machine Python/R acceptance remain separate. A missing real-machine run is reported as `NOT-RUN`, never inferred from unit tests. Source closure does not prove an installed application, signing, notarization, release readiness, or availability in arbitrary user environments.

## Risks

The principal risks are accidental overlap with the existing `ui-journey` work, projection growth in long Sessions, prompt context lost during compaction, environment drift not captured by `bindingFingerprint-v1`, process-tree leaks, shell or ambient-environment provenance bypasses, and users reading model-published Outcomes as scientific certification. Isolation by local repository, metadata-only projection, the Core compaction prerequisite, explicit fingerprint limitations, owned-tree quiescence, clean-env execution, and fixed UI wording mitigate these risks without expanding Phase 1.

The pre-release event policy makes every Science event required-on-read. Older builds will refuse a Session containing these events. That refusal is intentional until a separately designed compatibility or migration promise exists.
