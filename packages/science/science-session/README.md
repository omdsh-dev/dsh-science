# @deepseek-ai/dsh-science-session

English | [中文](README.zh.md)

Event-sourced Science session facts. The package declares required-on-read Session events, validates them through strict replay, exposes a `science` projection, and publishes an independent `./invariant` companion. It does not provide a mutation service: producers append typed whole-value records only after the fact they describe exists.

## Composition

Load the root function plugin on the Host. When `ctx.sessionProjections` is present, the plugin registers one `science` unit through the optional projection dependency; compositions without the registry remain unaffected. Load `@deepseek-ai/dsh-science-session/invariant` wherever package invariants are selected so invalid candidates are rejected before `session/event` commits.

The package does not inspect an interpreter, probe or modify an environment, spawn a process, read attachment bytes, register tools or prompts, or render UI. A later provider or consumer owns each of those operations and may append a Science event only at its documented commit point.

## Durable records

Six versioned events record one Science mode binding, consecutive environment observations, run starts and terminal results, immutable chart versions, and consecutive Outcome publications. The generated [persistence catalog](../../../docs/persistence-catalog.md) owns their literal payload listing. Every event is a complete value rather than a patch and retains only compact metadata and backward references; binary attachments, executed code, stdout, stderr, credentials, browser URLs, and Host absolute attachment paths remain with their existing owners.

Mode binding is valid once and only for a Session whose header names the `science` agent preset, and it precedes the first step, request header, or tool call. Environment revisions are positive and consecutive. Every run, chart, or Outcome authorization names the latest post-mode request header and one unique, still-pending model tool call recorded after that header. A call authorizes exactly one Science fact and cannot be reused after consumption or settlement. A run start also refers to an existing applied environment; its terminal record must preserve the immutable start fields and may end as `success`, `failed`, `timed-out`, or `cancelled`. Only the core `session/end-seed` marker derives `interrupted` for a still-running inherited or recovered record; it appends no synthetic Science terminal event.

A chart version refers backward to a successful run and an immutable PNG `ImageAttachmentRef`. Versions for one normalized logical name are consecutive and read-only, and their creation times never move backwards. An Outcome publication contains at least one backward run, chart-version, or message reference and records exactly the sorted set of applied environment revisions used by its run or chart evidence; message-only evidence therefore records an empty set. Its tool call anchors the model publication, while its request header supplies the logged prompt and safe provider/model identity. A later consecutive revision supersedes the prior publication in the projection without rewriting history. Outcome records never read, mutate, or reference Goal state.

## Replay and projection

The strict synchronous fold rejects unsupported versions, unknown fields, malformed branded identifiers, invalid discriminants, non-finite or unsafe numbers, time regressions, reused identities or authorizations, revision gaps, illegal lifecycle transitions, missing or forward evidence references, and payload timestamps earlier than their supporting facts. It is the fail-loud replay and invariant validator. The projection uses the same strict payload decoders plus a fail-soft read transition; both consume the complete Session log, including inherited seed events, so resume, fork, and cold replay retain the same evidence.

The `science` projection is `null` before a valid mode binding, including for a Standard Session. A missing key means the package is not composed. After binding, the value contains the mode, current environment, run summaries, chart-version metadata, and latest Outcome. Projection state is plain JSON; its registration `stateVersion` invalidates stale cache rows and is not a projected field. Unrelated or malformed events return the same state reference so one rejected record does not disable other projection units; strict replay and the invariant still fail loudly.

The invariant companion seeds an independent fold for every attached Session, stages each candidate during `internal/dispatch`, and advances its state only after the exact `session/event` publishes. A violation therefore appends nothing.

## Extension points

Producers use the exported branded identifiers and event types, preserve existing DSH owners such as `CallId` and `ImageAttachmentRef`, and append through the owning `Session`. Consumers read the projection or replay the log; they do not maintain a second Science database.

## Model Experience

None, as this package validates and projects already-logged Science facts without registering prompts, messages, schemas, streams, or tool results.

#### KV Cache effect

None; replay and projection never assemble or send provider requests.

## Known Limitations and Deferred Work

- **No producer API** — this phase intentionally exposes no public mutation service, tool, runtime, or UI; later consumers must validate their own external work before appending one typed event.
- **Metadata-only records** — code, process output, attachment bytes, and environment package inventories stay outside the projection, so readers must resolve their durable references through the owning services.
- **Growing history** — run summaries and chart-version metadata grow with the Session log; paging or a split chart index is deferred until measured projection size requires it.
- **Trusted in-process producers** — a plugin with direct `Session` access can attempt a counterfeit Science event. Strict replay and the invariant detect malformed or inconsistent records; they do not isolate plugins.
