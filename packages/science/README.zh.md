# science/：持久 Science 事实与本地 Runtime

[English](README.md) | 中文

Science 组拥有精简、读取时必需的记录，以及记录环境观测和全新 Python/R run 的 host-local Runtime。原始 Session 日志仍是唯一的持久权威；私有 process handle 与 scratch 保持为运行期状态。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`science-session/`](science-session/README.md) | 带版本的 Science 事件、唯一严格 fold 权威、派生的 `science` 投影和事件流不变式 | 无 |
| [`science-runtime/`](science-runtime/README.md) | `ctx.scienceRuntime`：本地 Conda 观测、私有 scratch、direct argv、精确 Session lifecycle ownership 与 durable environment/run mutation | `scienceRuntime` |

domain fold 拥有 Science transition；projection code 推进同一 fold semantics，不维护第二套 provenance state machine。public package root 让 mutable replay 与 checkpoint machinery 保持私有。

Runtime 通过共享 subprocess 与 sandbox 服务观测已配置的现有 prefix，并启动全新的 host-local Python/R process。它不管理 Conda environment，也不添加 Science tool、preset、prompt、UI、chart 或 Outcome consumer。后续 Consumer 使用 runtime operation，而不是重复 Science Session mutation。
