# Science 会话领域

[English](science.md) | 中文

Science Session Domain 负责精简、读取时必需的事实及其确定性 projection。[`@deepseek-ai/dsh-science-runtime`](../../packages/science/science-runtime/README.md) 负责观测已配置 Conda prefix 并通过该领域追加 environment/run fact 的 host-local operation。[Science Mode 执行链路](../science-mode.md)映射二者的跨子系统责任与扩展点；[Science MVP Decision Record](../../.agents/notes/proposed/feature/2026-08-12-science-mode-core-mvp.md)负责分阶段产品决策。

## 标识与适用性

`ScienceRunId`、`ScienceEnvironmentProfileId`、`ScienceChartId` 与 `ScienceScratchKey` 是[品牌化标识](core.md#branded-ids)。纯 applicability policy 只在 `SessionHeader.agentPreset` 为 `science` 时准入 Science 事件，并要求 Science preset Session 在 host activity 前绑定 mode；invariant 负责这个 Session container 边界。唯一一次 mode binding 前，projection 为 `null`；缺少 `science` key 表示没有组合该包。

mode 事件只记录稳定模式事实，且必须早于第一条 step、request header 或 tool call。run、chart 与 Outcome 记录向后引用拥有 prompt 与模型 provenance 的最新 mode 后 `request/header`，并引用一项唯一且尚未结算、用于锚定模型操作的 tool call。result 或所属 `step/end` 会结算 call；Python 与 R run、chart、Outcome 分别要求 `run_python` 或 `run_r`、`save_chart`、`publish_outcome`。

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

## 环境事实

environment revision 是正数且连续。第一次 run 要求最新 revision 为 `applied`；后续 `invalid` 或 `drifted` observation 会阻止新 run，而第一次 run 后不能再以新的 applied revision 替换环境。`available` interpreter binding 保留完整 canonical identity 与 fingerprint；失败 capability record 必须携带 reason，且只保留失败前实际观测到的事实，因此 executable 不存在时无需伪造 sentinel。absolute path 字段接受 POSIX、Windows drive 与 Windows UNC 语法，但 Phase 1 不执行任何解释器。

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

## Run、图表与 Outcome

run start 是完整且不可变的 execution identity。finish 重复这些字段并增加一个终态。`interrupted` 永远不是 finish payload：只有 `session/end-seed` 关闭仍为 running 的记录时，回放才会派生它。chart version 引用成功 run 与不可变 PNG attachment。Outcome revision 引用先前成功 run、chart version 或 message，不读取也不修改 Goal 状态。每项 tool call 只授权一个 Science fact，payload timestamp 必须落在 supporting fact 到所属 event envelope time 的区间内。公开 projection 保持仅含元数据。

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

## Projection 与校验

严格 fold 拒绝格式错误的 payload、不连续的事件与 revision、非法 lifecycle transition，以及缺失或前向引用。它是 Science 事件流 transition 与 provenance 的唯一权威。Session header metadata 不在事件流中，因此由正交的 applicability policy 负责；invariant 会在 `Session.append()` commit 前组合该 policy 与 fold。`replayScience(events)` 假定事件流已经准入。fail-soft live projection 会推进同一 accumulator 的编码副本，而不维护独立 reducer 或重复 provenance rule。每条 committed event 都会推进私有 watermark；unrelated 或 malformed event 保持 fold 与 witness 不变，也不通知公开读取方。对已准入的 log，live 与 cold path 都消费继承的 evidence 与 `session/end-seed`，并派生相同的公开值。

私有 projection state 是纯 JSON `{ observedSeq, fold, witness }`。空 watermark 为 `-1`；每条 committed event 都会推进它，稀疏、脱敏的 witness 则只保留 strict replay 所需的 supporting fact。使用 `stateVersion: 2` 的 registration 向 generic registry 提供 `checkpointStateSchema`；该 schema 会校验 watermark、严格回放 witness，只有精确复现编码后的 fold 才接纳持久 row。纯 `checkpointStateSeq` extractor 还要求嵌入 watermark 与 row 外层 `seq` 相等。schema 准入只用于不受信任的 checkpoint；extractor 也会校验即将写出的 row，因此持久化两侧都遵守同一条“内嵌水位等于外层 seq”关系。私有 state 可以在公开 projection 不变时变化，因此 `viewChanged` 会抑制重复 notification。公开 schema 校验自身 JSON 字段与派生 metrics，不校验历史 provenance transition。

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

package root 只公开消费方所需的 durable identifier、event type、严格 decoder 与 replay result。mutable fold state、transition、witness construction、checkpoint validation 与 projection-state operation 保持内部可见。incremental apply 避免每条 live event 都执行 full-witness replay，但 immutable collection copy 与 witness retention 仍会随历史增长；实现不主张 constant-time，paging 或 compaction 要等测量结果证明需要时再引入。

runtime 是 Phase 2 中 `science/environment-bound`、`science/run-started` 与 `science/run-finished` 的唯一 owner。它要求精确的 live Session、direct argv、空 child environment base、full sandbox enforcement、私有 Host scratch，以及 terminal publication 前的整棵 process tree quiescence。它不添加 tool、prompt、preset、UI、chart 或 Outcome consumer；后续 Consumer 调用 `ctx.scienceRuntime`，而不是自行追加 runtime fact。

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
