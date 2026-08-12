# Science 会话领域

[English](science.md) | 中文

Science Session Domain 负责精简、读取时必需的事实及其确定性 projection。[Science MVP Decision Record](../../.agents/notes/proposed/feature/2026-08-12-science-mode-core-mvp.md)负责分阶段产品决策；本页记录 [`@deepseek-ai/dsh-science-session`](../../packages/science/science-session/README.md) 已实现的持久词汇。

## 标识与适用性

`ScienceRunId`、`ScienceEnvironmentProfileId`、`ScienceChartId` 与 `ScienceScratchKey` 是[品牌化标识](core.md#branded-ids)。只有 `SessionHeader.agentPreset` 为 `science` 时，Session 才能包含 Science 事件。唯一一次 mode binding 前，projection 为 `null`；缺少 `science` key 表示没有组合该包。

mode 事件只记录稳定模式事实，且必须早于第一条 step、request header 或 tool call。run、chart 与 Outcome 记录向后引用拥有 prompt 与模型 provenance 的最新 mode 后 `request/header`，并引用一项唯一且尚未结算、用于锚定模型操作的 tool call。

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

environment revision 是正数且连续。第一次 run 要求最新 revision 为 `applied`；后续 `invalid` 或 `drifted` observation 会阻止新 run，而第一次 run 后不能再以新的 applied revision 替换环境。每个可选 interpreter binding 保留 canonical identity 与 fingerprint 事实，不保存 package inventory 或 credential。

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

run start 是完整且不可变的 execution identity。finish 重复这些字段并增加一个终态。`interrupted` 永远不是 finish payload：只有 `session/end-seed` 关闭仍为 running 的记录时，回放才会派生它。chart version 引用成功 run 与不可变 PNG attachment。Outcome revision 引用先前 run、chart version 或 message，不读取也不修改 Goal 状态。每项 tool call 只授权一个 Science fact，payload timestamp 也不得早于其 supporting fact。

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

严格 fold 拒绝格式错误的 payload、不连续的事件与 revision、非法 lifecycle transition，以及缺失或前向引用。invariant 会在 `Session.append()` commit 前暂存该 fold。fail-soft projection 复用严格 payload decoder，忽略已被 invariant 拒绝的非法事件，并对无关事件返回同一 reference。live 与 cold fold 消费同一份完整 Session log，包括继承的 evidence 与 `session/end-seed`。

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

Phase 1 有意不提供 public mutation service、interpreter probe、process execution、tool、prompt 或 UI。后续阶段的 producer 只能在外部事实到达规定的 commit point 后，追加六种 typed event 之一。
