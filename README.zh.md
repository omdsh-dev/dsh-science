# DSH Science

[English](README.md) | 中文

DSH Science 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的社区分支，面向持久化智能体会话中的可复现 Python 与 R 工作。

本项目沿用**一切皆插件**的架构，增加 Science Session 领域、主机本地 Runtime，以及通向完整 Science 工作区的分阶段实现路线。

## 运行

### 从源码运行

请先安装 Node.js（版本要求：`^22.19` 或 `>=24`）和 pnpm 11，然后从源码运行仓库：

```sh
git clone https://github.com/omdsh-dev/dsh-science.git
cd dsh-science
pnpm install
pnpm run build
pnpm dsh web
```

该命令会启动 Web profile 并打印本地地址。在**设置 → 模型**中添加 DeepSeek API 密钥，然后在启动 DSH 时所在的工作区中创建会话。

## Science 基础能力

Phase 2 已完成，为 Science Mode 提供以下 Runtime 基础：

- 持久化 Science Session 事件、严格重放、不变量与面向客户端的安全投影。
- 观测配置好的现有 Python 与 R Conda prefix。
- 通过直接 argv、显式空白环境、每会话私有 scratch 和完整文件写入约束运行全新进程。
- 取消、超时、进程树静默、环境漂移检测与有界输出收集。

[Science Mode 执行链](docs/science-mode.md)、[Science 子系统参考](docs/subsystems/science.md)与 [Science Runtime 包](packages/science/science-runtime/README.md)说明了已实现接口及其归属。

## 路线图

| Phase | 计划 |
| --- | --- |
| 3 | 交付 Science preset、可重建的环境上下文、状态查询以及 Python/R 工具。 |
| 4 | 增加不可变 PNG 图表版本，以及带证据关联的 Outcome 发布。 |
| 5 | 在现有 Details 栏中增加 Science 视图。 |
| 6 | 完成产品组合、构建产物检查、GUI 重放与源码闭环。 |

[Science MVP 决策记录](.agents/notes/proposed/feature/2026-08-12-science-mode-core-mvp.md)负责完整的分阶段设计。

## Profile 与插件

profile 由一组按顺序排列的插件组合包构成。在源码仓库中，可以使用 DSH 通用的 pnpm 插件命令管理 Web profile：

```sh
pnpm dsh plugin --profile web add <package>
pnpm dsh plugin --profile web remove <package>
```

发布 DSH 插件时，请添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic，让插件进入共享生态的发现入口。

## 文档

[Web UI 指南](docs/user/guide/index.md)、[CLI 参考](apps/cli/README.md)、[Python SDK](python/README.md)与[示例](examples/README.md)介绍 DSH 的主要使用与扩展方式。

参与开发请先阅读[开发指南](docs/development.md)与[架构文档](docs/architecture.md)。Agent 遵循 [AGENTS.md](AGENTS.md)。

## 社区

DSH Science 由 [omdsh-dev](https://github.com/omdsh-dev) 社区维护，并基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 构建。

Bug、提案与实现讨论请提交到 [issue](https://github.com/omdsh-dev/dsh-science/issues)。

## 参与贡献

贡献代码前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[BSD 3-Clause](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
