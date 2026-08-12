# science/：持久 Science 会话事实

[English](README.md) | 中文

Science 组负责精简且读取时必需的记录，用于标识 Science 会话如何产出运行记录、图表版本和已发布 Outcome。原始 Session 日志仍是唯一的持久权威；投影和未来消费方都从这些记录重建状态。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`science-session/`](science-session/README.md) | 带版本的 Science 事件、唯一严格 fold 权威、派生的 `science` 投影和事件流不变式 | 无 |

domain fold 拥有 Science transition；projection code 推进同一 fold semantics，不维护第二套 provenance state machine。public package root 让 mutable replay 与 checkpoint machinery 保持私有。

本组不包含解释器、环境管理、进程、工具或 UI 实现。这些职责需要独立的包，也不会改变 Science Session 事件定义。
