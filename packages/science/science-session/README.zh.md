# @deepseek-ai/dsh-science-session

[English](README.md) | 中文

事件溯源的 Science 会话事实。本包声明读取时必需的 Session 事件，拥有这些事件唯一的严格事件流 fold，从该 fold 派生 `science` 投影，并发布独立的 `./invariant` 配套模块。本包不提供变更服务：生产方只能在所描述事实已经成立后追加带类型的全量记录。

## 组装

在 Host 加载根函数插件。存在 `ctx.sessionProjections` 时，插件通过可选投影依赖注册一个 `science` 单元；不带该注册表的组装不受影响。在选择 package invariant 的位置加载 `@deepseek-ai/dsh-science-session/invariant`，使非法候选项在 `session/event` 提交前被拒绝。

本包不检查解释器，不探测或修改环境，不生成进程，不读取附件字节，不注册工具或提示词，也不渲染 UI。后续提供方或消费方分别拥有这些操作，并且只能在对应事实的既定提交点追加 Science 事件。

## 持久记录

六种带版本的事件分别记录一次 Science 模式绑定、连续的环境观察、运行开始与终态结果、不可变图表版本和连续的 Outcome 发布。[持久化目录](../../../docs/persistence-catalog.md)负责列出其具体 payload。每个事件都是完整值而不是 patch，只保留精简元数据和后向引用；二进制附件、已执行代码、stdout、stderr、凭据、浏览器 URL 和 Host 绝对附件路径仍归现有所有者负责。

模式绑定只允许发生一次，并且所属 Session 的 header 必须指定 `science` agent preset；它必须早于第一条 step、request header 或 tool call。环境 revision 是连续正数。`available` interpreter binding 必须携带完整 canonical executable identity 与 fingerprint；`unavailable`、`invalid`、`drifted` binding 必须携带 reason，但只保留失败前实际观测到的 identity fact，绝不填写 sentinel value。持久 absolute path 接受 POSIX、Windows drive 与 Windows UNC 形式。每次 run、chart 或 Outcome 授权都必须指向模式绑定后的最新 request header，以及在该 header 后记录的一项唯一且尚未结算的模型 tool call。result 或其所属 step 的结束会结算该 call，一个 call 只能授权一项 Science fact。Python run 要求 `run_python`，R run 要求 `run_r`，chart 要求 `save_chart`，Outcome 要求 `publish_outcome`。运行开始记录还要引用已经存在且处于 applied 状态的环境；终态记录必须保留开始时的不可变字段，并且只能结束为 `success`、`failed`、`timed-out` 或 `cancelled`。只有核心 `session/end-seed` 标记会把仍处于 running 的继承或恢复记录派生为 `interrupted`；它不会追加合成的 Science 终态事件。

图表版本向后引用成功运行和不可变的 PNG `ImageAttachmentRef`。同一个规范化逻辑名称的版本连续递增且只读，创建时间不得倒退。Outcome 发布至少包含一个向后指向的成功运行、图表版本或消息引用，并精确记录其 run 或 chart 证据实际使用的 applied environment revision 升序集合；因此纯 message 证据使用空集合。它以 tool call 锚定模型发布，由 request header 提供 logged prompt 与安全的提供方／模型 identity。后续连续 revision 会让投影中的前一项成为已被取代的发布，但不会改写历史。Outcome 记录绝不读取、修改或引用 Goal 状态。

## 回放与投影

严格同步 fold 会拒绝不支持的版本、未知字段、格式错误的 branded identifier、非法 discriminant、非有限数或非安全整数、时间倒退、重复标识或授权、revision 缺口、非法 lifecycle transition、缺失或前向的 evidence reference、早于所引用 supporting fact 的 payload timestamp，以及晚于所属 event envelope 的 payload timestamp。它是事件流 transition 与 provenance 的唯一权威。独立的纯 applicability policy 负责 Session header 的 preset 边界，以及 Science preset Session 必须在 host activity 前绑定 mode 的要求；invariant 在 commit 前组合该 policy 与 fold。`replayScience(events)` 有意假定所属 Session 已准入该事件流，fail-soft live projection 则推进同一 fold 的编码副本，而不运行独立 reducer。对于每份已准入的 live、resume、fork 或 cold log，两条路径都会消费继承的 seed evidence并派生相同结果。

有效模式绑定之前，`science` 投影为 `null`，Standard Session 也是如此。key 缺失表示本包未组装。绑定之后，公开值包含模式、当前环境、运行摘要、图表版本元数据、最新 Outcome 与派生 metrics。其 schema 校验这些公开 JSON 字段与 metrics 一致性；历史 provenance 继续由严格 fold 负责。

私有 state 是纯 JSON `{ observedSeq, fold, witness }`。空日志的 `observedSeq` 为 `-1`，此后每条 committed event 都会推进它，包括不改变 Science 的 event。编码后的 fold 支持 incremental live update，稀疏、脱敏的 witness 则省略 request-header body、tool argument 与 message content。generic registry 只会为不受信任的持久 row 调用 `checkpointStateSchema`；Science 随后校验 watermark、严格回放 witness，并要求它与编码后的 fold 完全一致。`checkpointStateSeq` extractor 会把嵌入 watermark 绑定到 row 外层 `seq`，拒绝把有效但较旧的 value 拼接到更新 watermark 下。registration 使用 `stateVersion: 2`，用于使较旧私有 state 失效，而不成为投影字段。supporting、unrelated 或 malformed event 可以推进私有 state 而不改变公开值，因此 `viewChanged` 会抑制重复 change notification；严格回放与 invariant 仍会大声失败。

Invariant 配套模块会为每个已挂接 Session 播种独立 fold，应用本包的纯 Session applicability policy，在 `internal/dispatch` 期间通过严格 fold 暂存每个候选项，并且只在完全相同的 `session/event` 发布后推进状态。因此，违反规则时不会追加任何内容。

## 扩展点

生产方使用 package root 导出的 branded identifier 与 event type，保留 `CallId`、`ImageAttachmentRef` 等既有 DSH 所有者，并通过所属 `Session` 追加。消费方使用严格 decoder 与 replay result，或读取投影；它们不维护第二个 Science 数据库。mutable accumulator、transition、witness、checkpoint 与 projection-state helper 都是实现细节，不从 package root 导出。

## 模型体验

无——本包只校验和投影已经写入日志的 Science 事实，不注册提示词、消息、schema、流或工具结果。

#### KV Cache 影响

无；回放和投影绝不组装或发送提供方请求。

## 已知限制与暂缓事项

- **没有生产方 API**：本阶段有意不公开变更服务、工具、运行时或 UI；后续消费方必须先校验自己的外部工作，再追加一项带类型的事件。
- **仅记录元数据**：代码、进程输出、附件字节和环境包清单不进入投影，因此读取方必须通过各自所属服务解析持久引用。
- **历史持续增长**：incremental apply 避免为每条 live event 重放此前的完整 witness，但 immutable collection copy、运行摘要、图表版本元数据与脱敏 witness 仍会随保留的 Science 历史增长。本包不主张 constant-time；paging 或 witness compaction 要等待测得的大小与 transition cost。在 mode binding 前，可能成为 Outcome evidence 的 message fact 会保留在 witness 中；如果先出现 step、request header 或 tool call，它会让后续 binding 变得不可能，并把此前的 pre-mode witness 折叠为仅保留该 blocker。
- **信任进程内生产方**：能直接访问 `Session` 的插件可以尝试追加伪造的 Science 事件。严格回放和 invariant 会检测格式错误或不一致的记录，但不会隔离插件。
