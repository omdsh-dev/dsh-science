# @deepseek-ai/dsh-science-session

[English](README.md) | 中文

事件溯源的 Science 会话事实。本包声明读取时必需的 Session 事件，通过严格回放校验这些事件，公开 `science` 投影，并发布独立的 `./invariant` 配套模块。本包不提供变更服务：生产方只能在所描述事实已经成立后追加带类型的全量记录。

## 组装

在 Host 加载根函数插件。存在 `ctx.sessionProjections` 时，插件通过可选投影依赖注册一个 `science` 单元；不带该注册表的组装不受影响。在选择 package invariant 的位置加载 `@deepseek-ai/dsh-science-session/invariant`，使非法候选项在 `session/event` 提交前被拒绝。

本包不检查解释器，不探测或修改环境，不生成进程，不读取附件字节，不注册工具或提示词，也不渲染 UI。后续提供方或消费方分别拥有这些操作，并且只能在对应事实的既定提交点追加 Science 事件。

## 持久记录

六种带版本的事件分别记录一次 Science 模式绑定、连续的环境观察、运行开始与终态结果、不可变图表版本和连续的 Outcome 发布。[持久化目录](../../../docs/persistence-catalog.md)负责列出其具体 payload。每个事件都是完整值而不是 patch，只保留精简元数据和后向引用；二进制附件、已执行代码、stdout、stderr、凭据、浏览器 URL 和 Host 绝对附件路径仍归现有所有者负责。

模式绑定只允许发生一次，并且所属 Session 的 header 必须指定 `science` agent preset；它必须早于第一条 step、request header 或 tool call。环境 revision 是连续正数。每次 run、chart 或 Outcome 授权都必须指向模式绑定后的最新 request header，以及在该 header 后记录的一项唯一且尚未结算的模型 tool call。一个 call 只授权一项 Science fact，消费或结算后不得复用。运行开始记录还要引用已经存在且处于 applied 状态的环境；终态记录必须保留开始时的不可变字段，并且只能结束为 `success`、`failed`、`timed-out` 或 `cancelled`。只有核心 `session/end-seed` 标记会把仍处于 running 的继承或恢复记录派生为 `interrupted`；它不会追加合成的 Science 终态事件。

图表版本向后引用成功运行和不可变的 PNG `ImageAttachmentRef`。同一个规范化逻辑名称的版本连续递增且只读，创建时间不得倒退。Outcome 发布至少包含一个向后指向的运行、图表版本或消息引用，并精确记录其 run 或 chart 证据实际使用的 applied environment revision 升序集合；因此纯 message 证据使用空集合。它以 tool call 锚定模型发布，由 request header 提供 logged prompt 与安全的提供方／模型 identity。后续连续 revision 会让投影中的前一项成为已被取代的发布，但不会改写历史。Outcome 记录绝不读取、修改或引用 Goal 状态。

## 回放与投影

严格同步 fold 会拒绝不支持的版本、未知字段、格式错误的 branded identifier、非法 discriminant、非有限数或非安全整数、时间倒退、重复标识或授权、revision 缺口、非法生命周期转换、缺失或前向的证据引用，以及早于 supporting fact 的 payload timestamp。它负责大声失败的回放与 invariant 校验；projection 使用同一组严格 payload decoder 和独立的 fail-soft 读取 transition。两者都会消费完整 Session 日志，包括继承的 seed 事件，因此恢复、fork 和冷回放保留相同证据。

有效模式绑定之前，`science` 投影为 `null`，Standard Session 也是如此。key 缺失表示本包未组装。绑定之后，值包含模式、当前环境、运行摘要、图表版本元数据和最新 Outcome。投影状态是纯 JSON；注册项的 `stateVersion` 用于使陈旧缓存行失效，不属于投影字段。无关或格式错误的事件返回同一状态引用，避免一条已被拒绝的记录停用其他投影单元；严格回放和 invariant 仍会大声失败。

Invariant 配套模块会为每个已挂接 Session 播种独立 fold，在 `internal/dispatch` 期间暂存每个候选项，并且只在完全相同的 `session/event` 发布后推进状态。因此，违反规则时不会追加任何内容。

## 扩展点

生产方使用本包导出的 branded identifier 和事件类型，保留 `CallId`、`ImageAttachmentRef` 等既有 DSH 所有者，并通过所属 `Session` 追加。消费方读取投影或回放日志，不维护第二个 Science 数据库。

## 模型体验

无——本包只校验和投影已经写入日志的 Science 事实，不注册提示词、消息、schema、流或工具结果。

#### KV Cache 影响

无；回放和投影绝不组装或发送提供方请求。

## 已知限制与暂缓事项

- **没有生产方 API**：本阶段有意不公开变更服务、工具、运行时或 UI；后续消费方必须先校验自己的外部工作，再追加一项带类型的事件。
- **仅记录元数据**：代码、进程输出、附件字节和环境包清单不进入投影，因此读取方必须通过各自所属服务解析持久引用。
- **历史持续增长**：运行摘要和图表版本元数据会随 Session 日志增长；只有测得的投影大小需要时，才会引入分页或拆分图表索引。
- **信任进程内生产方**：能直接访问 `Session` 的插件可以尝试追加伪造的 Science 事件。严格回放和 invariant 会检测格式错误或不一致的记录，但不会隔离插件。
