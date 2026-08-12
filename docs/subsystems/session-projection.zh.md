# 会话投影

[English](session-projection.md) | 中文

会话投影 seam 是一项[能力 seam](../capability-seams.md)：领域 host 插件经由它向客户端载体供给按会话的日志派生状态的当前全量值；三方分别是 Service Definition 与注册表（[dsh-session-projection](../../packages/session/session-projection)，`ctx.sessionProjections`）、领域贡献方（每个领域注册一个纯单元）与载体（[dsh-host-apiproxy](../../packages/host/apiproxy) 的历史尾页与 `session/projection` 推送帧）。它是一项可选能力，不属于 agent loop（智能体循环）主干。框架负责驱动，领域负责计算：注册表只订阅一次 `session/event`，并把每个已提交事件折叠进每个单元；领域不持有任何订阅，客户端也从不折叠领域事件——它们收到的是成品值。设计权威：[session-projection RFC](../../.agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.md)；驱动、缓存与变更流约定：[包 README](../../packages/session/session-projection/README.md)。

源码分工：契约位于 [`definition.ts`](../../packages/session/session-projection/src/definition.ts)，owner/HMR 仲裁位于 [`registration.ts`](../../packages/session/session-projection/src/registration.ts)，JSON 与持久行边界位于 [`checkpoint.ts`](../../packages/session/session-projection/src/checkpoint.ts)，服务编排位于 [`index.ts`](../../packages/session/session-projection/src/index.ts)。

## 投影单元

`SessionProjectionMap` 是整条链路（host 侧单元、协议块、客户端钩子）的 merge-extensible 类型表；值是协议层 JSON 全量值，渲染归 slot 体系管，永远不归本层。领域为每个 key 贡献一个 `ProjectionDefinition`：

```ts type-equiv
/**
 * One domain's pure projection computation. The framework owns event drive,
 * watermarks, persistence admission, and notifications; the domain owns only
 * `init`, `apply`, `view`, and any private-state validation.
 */
interface ProjectionDefinition<K extends keyof SessionProjectionMap, S> {
  /** The non-empty projection key this unit owns. */
  key: K
  /**
   * Process-local identity of this exact definition family. Use one
   * module-private `Symbol()` for definitions whose functions and schemas are
   * interchangeable across repeated composition. Do not use `Symbol.for()` or
   * reuse a token across instance-configured semantics.
   */
  definitionToken: symbol
  /** Validates the wire payload (`view` output) before it leaves the host. */
  schema: ZodType<SessionProjectionMap[K]>
  /**
   * Admits persisted private state. Parsing is validation-only: a transform
   * that changes the JSON value rejects the row rather than migrating it.
   * Live states never pass through this parser.
   */
  checkpointStateSchema?: ZodType<S>
  /**
   * Extracts the event watermark encoded by private checkpoint state. When
   * supplied, the registry requires every emitted or admitted state to equal
   * the row's outer `seq`, which prevents a valid older state from being
   * spliced under a newer watermark.
   */
  checkpointStateSeq?(state: S): number
  /** State for the empty log. */
  init(): S
  /**
   * Pure transition over one committed event. An uninterested unit SHOULD
   * return the same state reference so the default change gate does no work.
   */
  apply(state: S, event: SessionEvent): S
  /** Derive the whole public wire value from private state. */
  view(state: S): SessionProjectionMap[K]
  /**
   * Optionally narrow public-change notification after `apply` returned a
   * different reference. It cannot turn a same-reference no-op into a change.
   */
  viewChanged?(previous: S, next: S): boolean
  /** Persisted-state invalidation version; a non-negative safe integer. */
  stateVersion: number
}
```

全量值事件规则是承重结构：携带状态的日志事件携带的是变更后的完整状态，绝不是裸增量，因此每个被供给的值都能自描述（对消费方即 last-wins）。转移成本仍由领域负责；provenance 密集型单元可能保留并复制历史，广泛组装前必须量测这项成本。

## 快照与变更流

```ts type-equiv
/** One consistent read cut over every registered projection unit. */
interface ProjectionSnapshot {
  /** Seq of the last event reflected by every value; -1 for an empty log. */
  asOfSeq: number
  /** Detached whole public values keyed by registered projection name. */
  values: Partial<SessionProjectionMap>
}
```

```ts type-equiv
/** One schema-validated public value changed at a committed event watermark. */
type ProjectionChangeListener = (
  session: Session,
  key: Extract<keyof SessionProjectionMap, string>,
  value: unknown,
  seq: number,
) => void | PromiseLike<void>
```

`snapshot(session)` 完全同步：载体在切出页面切片的同一 tick 内读取它，因此 `asOfSeq` 使两次读取使用同一个序号。每个值都会在 schema 解析前复制一次，并在返回前再复制一次，所以 identity view 或会修改输入的 schema 都接触不到 live cell；误写成异步的 `view` 返回 Promise，会被 JSON/schema 边界拒绝。每个 listener 也收到独立副本。对于每个已提交事件，变更流会为公开 view 已变化的单元触发一次。默认闸门是状态引用同一性；拥有私有回放证据的单元提供 `viewChanged`，使仅证据推进时更新 checkpoint 而不发出相同值。

## 注册表：`ctx.sessionProjections`

`SessionProjectionRegistry`（[签名](#ctxsessionprojections--sessionprojectionregistry)）拥有驱动权：一份 `session/event` 订阅、对每个已注册单元即时调用 `apply`、每会话每单元的水位 cell，以及持久缓存准入。cell 惰性构建：事件流过后才注册的单元，或比注册表更早的会话，会在首次触达时从 `init` 出发折叠内存日志。成功的 `apply` 结果与水位先于可选通知工作提交；错误按单元隔离，后续单元仍会收到该事件。在持久读取面，`checkpointStateSchema` 只负责准入，`checkpointStateSeq` 可把私有状态绑定到缓存行的外层水位；拒绝会省略零 I/O 值并要求完整回放。这些 hook 不进入 live `init`/`apply`，但 `checkpointStateSeq` 也会检查即将写出的缓存行。注册按 owner 管理：active registrant 只有在 module-private definition token 与 state version 都相同时才共享 cell，且第一份 definition 保持 canonical。所有旧 owner 进入 unloading 或 disposed 后 HMR 才可接管；若 token 或 version 改变，则从日志重建 cell。领域插件在 `ctx.inject(['sessionProjections'], …)` 下注册，因此不带注册表的 headless 组装完全不受影响。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxsessionprojectioncache--sessionprojectioncache"></a>

### `ctx.sessionProjectionCache` — `SessionProjectionCache`

The persisted projection cache service. Opens the `session_projcache` domain at init, checkpoints live sessions on a throttled write-behind (count/interval triggers from Config) plus two mandatory points — `turn/end` and session disposal (the live-to-cold moment) — and serves the cold-read ladder: cached row, persistence `readFrom` tail, registry `restore`, durable write-back. Automatic writes are fail-soft: failures log a warning; a live dirty session retries on its interval or next mandatory point, while a failed detach retains its exact lifecycle for interval and cold-read retries.

```ts cordis-catalog
/**
 * The zero-I/O listing read: whole values viewed straight from the stored
 * rows (version- and checkpoint-schema-matching keys only). Every served
 * row must share one watermark so a client value store can seed the exact
 * cut under its higher-seq-wins rule — as stale as the last durable
 * checkpoint but never from an unrelated source or log revision (the
 * caller's persistence snapshot is the witness). Fresher
 * paths (the history tail baseline, {@link coldSnapshot}) supersede these
 * values whenever a session is actually opened.
 * @param persisted - the listed session header and revision (no log read).
 * @returns the exact cut, or `undefined` when no usable row exists for this
 *   lifecycle or its admitted rows do not share one watermark.
 */
cachedSnapshot(persisted: SessionPersistenceSnapshot): ProjectionSnapshot | undefined

/**
 * Durably checkpoint one live or retiring session (both mandatory points
 * call this; tests and carriers may too). Transactions for one session id
 * are serialized. Each transaction snapshots the registry only after its
 * predecessor settles, waits for the exact Session lifecycle's log drain,
 * then replaces the whole record. NOT fail-soft — callers on the fail-soft
 * paths contain it.
 * @param session - the live session to checkpoint.
 * @returns resolution after log durability and cache replacement.
 */
write(session: Session): Promise<void>

/**
 * Cold-read one persisted session's projections: cached rows plus a
 * persistence `readFrom` tail from the registry's restore floor, refolded
 * by the registry and written back (fail-soft). The rows seed that fold only
 * when their source-qualified revision equals the tail read's revision. A
 * revision mismatch, shrunk log, or unit-owned state rejection triggers one
 * full re-read from seq 0 — the
 * ladder's slow rung, still no crash. Rejects when the session has no
 * persisted log (`not found` from the persistence seam).
 * @param id - the persisted session to read.
 * @param signal - optional cancellation for the persistence reads.
 * @returns the snapshot cut at the stored log end, serialized with cache writes for this id.
 */
coldSnapshot(id: SessionId, signal?: AbortSignal): Promise<ProjectionSnapshot>
```

Types: [Session](session.md) · [SessionId](core.md) · [SessionPersistenceSnapshot](persistence.md)

Source: [`packages/session/session-projection-cache/src/index.ts:77`](../../packages/session/session-projection-cache/src/index.ts)

<a id="ctxsessionprojections--sessionprojectionregistry"></a>

### `ctx.sessionProjections` — `SessionProjectionRegistry`

`ctx.sessionProjections`: the projection unit table and its drive. The service subscribes to `session/event` once; every committed event passes every registered unit's `apply` (eager drive), and a changed public view notifies the change feed with the schema-validated value. Cells build lazily — a unit registered after events flowed, or a session older than the registry, folds `init` over the in-memory log on first touch (event or read). Registration is an effect (disposer rides the calling fiber): an unloaded domain plugin's key disappears from snapshots and clients read it as capability absence. Domain plugins register under `ctx.inject(['sessionProjections'], …)` so headless assemblies without the registry stay unaffected. Registrants sharing a key are tracked by owner: only the same process-local `definitionToken` and `stateVersion` may share one canonical definition and its cells, and the key survives until the last owner unloads. An HMR replacement may take over only while every prior owner is already unloading or disposed; a token or version change rebuilds its cells from the authoritative log.

```ts cordis-catalog
/**
 * Register one domain's unit. The registration is an effect on the calling
 * context's fiber: disposing the fiber (or calling the returned disposer)
 * removes exactly that owner. Concurrent owners share only when both the
 * module-private `definitionToken` and `stateVersion` match; the first
 * definition remains canonical, so another owner cannot change a public
 * view without an event. HMR replacement is allowed only when every older
 * owner is unloading; a different definition token or state version
 * rebuilds cells from the authoritative log.
 * @param definition - key, wire and optional checkpoint schemas, pure unit functions, and stateVersion.
 * @returns the exact disposer that unregisters this unit.
 */
register<K extends keyof SessionProjectionMap, S>(definition: ProjectionDefinition<K, S>): () => void

/**
 * Subscribe to the change feed. The registration is an effect on the
 * calling context's fiber. Listener throws and asynchronous rejections are
 * logged and contained so one subscriber cannot starve later subscribers.
 * @param listener - called once per unit whose public view changed, per committed event.
 * @returns the exact disposer that unsubscribes.
 */
onChanged(listener: ProjectionChangeListener): () => void

/**
 * One consistent cut over every registered unit for one session, read from
 * the watermark cache (missing cells fold lazily over the in-memory log).
 * Fully synchronous — every value and `asOfSeq` reflect the same log
 * position. Each value passes its unit's schema before leaving.
 * @param session - the session whose projection values are read.
 * @returns the snapshot; `values` is empty when no unit is registered.
 */
snapshot(session: Session): ProjectionSnapshot

/**
 * State-level checkpoint of every registered unit for one session, read
 * from the watermark cache (missing cells fold lazily over the in-memory
 * log). This is the write side of the persisted projection cache: the
 * returned rows are the `(key → {ver, seq, val})` part of the durable
 * `(sessionId, key, ver, seq, val)`
 * rows. Every `val` is validated and copied as lossless plain JSON — never
 * the live cell reference. A non-JSON state violates the unit contract and
 * throws here; a caller reaching the live reference could otherwise corrupt
 * every subsequent snapshot and frame.
 * @param session - the session whose unit states are checkpointed.
 * @returns one row per registered key; empty when no unit is registered.
 */
checkpoint(session: Session): ProjectionCheckpoint

/**
 * The stored seq a {@link restore} tail read over `checkpoint` must start
 * at: the lowest usable watermark, one event before the first event that
 * still needs applying (a row is usable when
 * its `ver` matches the live unit's `stateVersion` and its private state
 * passes the unit's optional `checkpointStateSchema`; an absent, mismatched,
 * or rejected row pulls the floor to `0` — that key must refold the full log). The
 * one-event overlap is load-bearing: the tail then proves how far the
 * stored log still extends, so {@link restore} can detect a log that
 * shrank below a row's watermark (crash-repair truncation) instead of
 * serving the stale row as current — an empty tail read from the anchor
 * yields an end below every watermark and the restore rejects for a full
 * re-read.
 * @param checkpoint - persisted rows for one session (possibly stale or empty).
 * @returns the seq to hand the persistence `readFrom`, or `undefined`
 *   when no unit is registered (no read needed — {@link restore} would
 *   serve empty values regardless).
 */
restoreFloor(checkpoint: ProjectionCheckpoint): number | undefined

/**
 * View a checkpoint's rows without any log read: for every registered
 * unit whose row's `ver` matches and whose private state passes the unit's
 * optional `checkpointStateSchema`, serve the schema-validated `view` of
 * the parsed state; rejected, mismatched, or absent rows leave their key
 * absent (a cold or listing consumer treats it as not-yet-available and a
 * fuller read path refolds it). This is the zero-I/O rung of the read
 * ladder: it proves schema admission and optional state-to-seq consistency,
 * while semantic provenance still depends on the durable cache writer and
 * lifecycle identity that supplied the row.
 * @param checkpoint - persisted rows for one session (possibly stale or empty).
 * @returns whole values per key with a usable row; empty when none.
 */
viewCheckpoint(checkpoint: ProjectionCheckpoint): Partial<SessionProjectionMap>

/**
 * Cold read: fold every registered unit over a stored log suffix, seeding
 * each from its checkpoint row when usable — the one read recipe (cached
 * state + forward tail replay + `view`) applied without a live `Session`.
 * Call with the events returned by a persistence
 * `readFrom(id, restoreFloor(checkpoint))` and that same floor as
 * `baseSeq`; the floor's one-below anchor makes the supplied end honest,
 * so a shrunk log is detected here. A row is usable iff its
 * `ver` matches the live unit's `stateVersion`, it does not predate `baseSeq`
 * (`seq >= baseSeq - 1`), it does not claim events past the supplied end
 * (`seq <= endSeq`), and its private state passes the unit's optional
 * `checkpointStateSchema`; an unusable row is discarded
 * and its key refolds from `init` — which is only sound over the full
 * log, so a discarded row with `baseSeq > 0` throws (the caller re-reads
 * from seq 0, e.g. after a crash-repair truncation shrank the log below
 * a row's watermark).
 * @param checkpoint - persisted rows for one session (possibly stale or empty).
 * @param events - the stored events with `seq >= baseSeq`, in seq order.
 * @param baseSeq - the seq `events` starts at (its first event's seq when non-empty).
 * @returns the snapshot cut at the supplied log end (`asOfSeq` is the last
 *   supplied event's seq, `baseSeq - 1` for an empty tail) plus the
 *   refreshed checkpoint rows at that cut, ready for a durable write-back.
 */
restore(checkpoint: ProjectionCheckpoint, events: readonly SessionEvent[], baseSeq: number): { snapshot: ProjectionSnapshot; checkpoint: ProjectionCheckpoint }
```

Types: [Session](session.md) · [SessionEvent](session.md)

Source: [`packages/session/session-projection/src/index.ts:93`](../../packages/session/session-projection/src/index.ts)
<!-- END GENERATED cordis-surface -->
