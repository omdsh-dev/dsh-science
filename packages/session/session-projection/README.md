# @deepseek-ai/dsh-session-projection

English | [中文](README.zh.md)

Session-projection Service Definition and drive registry. It owns `ctx.sessionProjections`, the registry that drives every registered projection unit over committed session events and serves finished whole values to carriers, currently the api-proxy history tail page and `session/projection` push frame. A domain registers pure mathematics; the framework owns the drive. The [session-projection RFC](../../../.agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.md) records the design rationale.

## Service: `SessionProjectionRegistry` (ctx key: `sessionProjections`)

### Public API

- `ctx.sessionProjections.register(definition): () => void` Register one domain's unit. Repeated composition shares one canonical definition and its cells only when key, module-private `definitionToken`, and `stateVersion` all match; any other active owner conflicts. During Cordis HMR, an incoming fiber may take over once all prior owners are unloading, and a changed token or version rebuilds cells from the log. The last live disposer removes the key and cells — clients read that as capability absence.
- `ctx.sessionProjections.onChanged(listener): () => void` Subscribe to the change feed: one call per unit whose public view changed, per committed event, carrying the schema-validated view and the causing seq. Effect-tied like `register`; listener throws and asynchronous rejections are logged and contained so later subscribers still run.
- `ctx.sessionProjections.snapshot(session): ProjectionSnapshot` One consistent synchronous cut over every registered unit — `{ asOfSeq, values }` with `asOfSeq` = the seq of the last event every value reflects (`-1` for an empty log).
- `checkpoint(session)`, `restoreFloor(checkpoint)`, `viewCheckpoint(checkpoint)`, and `restore(checkpoint, events, baseSeq)` form the persisted-cache boundary. The registry validates a row through its unit-owned checkpoint schema and optional state-to-row-watermark binding before viewing or forward-applying it; a rejected row is unavailable and requires a full replay.

### Key Types

- `SessionProjectionMap` — the single merge-extensible type table for the whole chain (host unit, wire block, React hook). Values are wire-JSON whole values; rendering belongs to the slot system, never this layer.
- `ProjectionDefinition<K, S>` — `{ key, definitionToken, schema, checkpointStateSchema?, checkpointStateSeq?, init(), apply(state, event), view(state), viewChanged?, stateVersion }`: a state-driven computation unit of three pure synchronous functions plus declarations, never an opaque getter. `key` is a non-empty wire identifier; every other JSON-safe string, including the literal `__proto__`, remains valid. One module-private `Symbol()` token names the exact interchangeable definition family; do not use `Symbol.for()` or reuse a token across instance-configured semantics. `checkpointStateSchema` admits canonical persisted private state without migrating it; `checkpointStateSeq` binds state that encodes its own watermark to the row's outer `seq`; `viewChanged` may distinguish private replay-state movement from a public-value change.

## Contract

- **The framework drives, the domain computes.** The registry subscribes to `session/event` once; every committed event passes every unit's `apply` eagerly. Domains hold no subscriptions. Drive is two-phase: all successful units commit the event and watermark before any public view or change listener runs, so a re-entrant snapshot cannot observe a half-applied registry cut. Cells (`{state, observedSeq}` per unit per session, WeakMap-keyed) build lazily — a unit registered after events flowed, or a read of a session predating the registration, folds `init` over the in-memory log on first touch.
- **Private progress and public change are distinct.** A unit SHOULD return the same state reference when neither its public value nor private checkpoint proof advances. The drive first commits every successful `apply` and its watermark, then gates notifications on `Object.is` and optional `viewChanged`. A throwing predicate or public view is logged and contained after the private fold has advanced; one failing unit does not starve later units.
- **Whole-value event rule (load-bearing).** A state-carrying log event MUST carry the complete post-change state, never a bare delta — it keeps that transition cheap and every served value self-describing (last-wins for consumers). A fact/provenance domain may instead own a strict multi-event fold and its transition cost.
- **Synchronous unit discipline.** `init`/`apply`/`view` MUST be synchronous; carriers read `snapshot()` in the same tick as their page slice, which is what makes `asOfSeq` one consistent cut. An accidentally-async `view` returns a Promise, which fails the boundary `schema.parse` loudly.
- **Every public and persisted value is detached plain JSON.** The registry clones before and after public schema validation, and gives each listener an independent value, so identity-returning views and mutating schema transforms cannot expose or alter a live cell. A non-JSON public value or checkpoint state fails loudly at the boundary.
- **`stateVersion` invalidates; schemas do not migrate.** The persisted cache stores `(sessionId, key, ver, seq, val)` rows. Bump `stateVersion` whenever state shape or fold semantics change. `checkpointStateSchema` runs only at persisted-state read boundaries and must return JSON deeply equal to its input; defaulting, stripping, or transforming a row into a different value rejects it. A provenance-heavy unit should also supply `checkpointStateSeq` so a valid older state cannot be paired with a newer outer watermark.
- **A self-watermarked unit advances private state on every event.** `checkpointStateSeq` is a pure extractor called when rows are emitted (`checkpoint`, refreshed `restore`) and admitted (`restoreFloor`, `viewCheckpoint`, `restore`). Such a unit must encode the latest committed seq even for domain-irrelevant events, so it returns a new private state each time and uses `viewChanged` to suppress identical public values. Units without this hook retain the same-reference fast path.
- **No wire vocabulary here.** The registry exposes only the change feed and the snapshot read face; carriers (api-proxy) mint their own frames (`session/projection`) and blocks from them.
- **Optional capability.** Domain plugins register under `ctx.inject(['sessionProjections'], …)` so headless assemblies without the registry stay unaffected; carriers use `ctx.get('sessionProjections')` and omit their block/frames entirely when the registry is absent.

## Role

This package owns the Service Definition, live drive, and persisted-cache admission roles of the capability seam: domain host plugins (e.g. `dsh-tool-todo`) contribute units and own their state mathematics and schemas; carriers (`dsh-host-apiproxy`) consume snapshots and the change feed. Neither knows the other.

The implementation follows the same ownership split: `definition.ts` owns contracts, `registration.ts` owns fiber/HMR arbitration, `checkpoint.ts` owns JSON detachment and persisted-row admission, and `index.ts` orchestrates the service and event drive.

## Model Experience

None, as the registry only computes client-facing read models of already-logged session state and touches no prompt, message, schema, stream, or tool result.

#### KV Cache effect

None; projections never assemble or send provider requests.

## Known Limitations and Deferred Work

- **Every tail page carries every registered key** — there is no per-key opt-out or lazy-key request shape yet; acceptable while values are UI-scale whole states (a todo list, a goal snapshot), revisit if a domain's value grows large.
- **The unit table is process-wide, so key presence is not a per-session capability signal** — a key registered by ANY agent preset appears in every session's snapshot, including sessions whose own composition mounts nothing that produces it. A client must read the VALUE (`plan.active`, an empty todo list) rather than treat an absent key as absence of the feature; a unit whose empty value is indistinguishable from a real one belongs on the host plane instead, which is why `dsh-token-meter` sits there.
- **Eager drive touches every unit per event** — same-reference and `viewChanged` gates prevent unnecessary downstream work, but transition cost remains unit-owned. A history-growing private state may still copy retained arrays; measure such units before broad composition. A hot path would justify per-unit event-type prefilters, addable without contract change.
- **Registry cells live in memory only** — a restart rebuilds by folding the log on first touch; compositions that mount `dsh-session-projection-cache` seed that fold from persisted rows instead.
- **Synchronous unit discipline is only partially mechanical** — the boundary `schema.parse` rejects a Promise-returning `view`, but an `apply` that blocks or reads torn non-session state is a review concern; the invariant companion documents why no runtime check exists.
