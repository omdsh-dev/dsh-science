# DeepSeek Harness

[English](README.md) | 中文

DeepSeek Harness（`dsh`）是一款开源 coding agent（编程智能体），也是一个基于插件的 agent harness（智能体框架）。

它采用了**一切皆插件**的架构。

## 内测说明

DeepSeek Harness 正处于内部测试阶段，功能和接口可能发生变化。

Session Log 默认留在本地。设置 `DSH_TELEMETRY_MODE=FEEDBACK_ONLY` 可仅在提交反馈时共享 Session Log，设置 `DSH_TELEMETRY_MODE=FULL` 可持续上传；`FULL` 同时会启用 dsh-sdk 命令遥测，上报匿名 ID、命令结果以及脱敏后的项目配置。请通过内部企业微信群反馈问题和建议。


## 运行

请先安装 Node.js（版本要求：`^22.19` 或 `>=24`）和 pnpm 11，然后运行已发布的包：

```sh
npx @deepseek-ai/dsh web
```

该命令会初始化 Web profile 并打印 Web UI 地址，默认地址为 `http://127.0.0.1:3080`。打开该地址，在**设置 → 模型**中添加 DeepSeek API 密钥，然后启动一个会话。运行命令时所在的目录将作为默认工作区；你可以尝试输入 `Summarize this repository and identify its main packages.`。

下一步请阅读 [Web UI 指南](docs/user/guide/index.md)。

### 从源码运行

如需从仓库源码运行：

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` 会准备仓库产物。`pnpm dsh web` 不会重新构建，而是直接启动同一个 Web UI。

## Profile 与插件

profile 由一组按顺序排列的插件组合包构成。随附的 `web` profile 用于运行 `dsh web`。使用 `dsh plugin --profile <name> <pnpm args>` 管理 profile；该命令会在对应 profile 目录中将剩余参数转发给 pnpm：

```sh
npx -p @deepseek-ai/dsh dsh plugin --profile web add <package>
npx -p @deepseek-ai/dsh dsh plugin --profile web remove <package>
```

`add`、`remove`、`update`、`why` 等 pnpm 命令均可直接使用。该命令会先初始化不存在的 profile，再修改其中的包，并根据声明了 `dsh.bundle` 的已安装包更新 bundle 列表。具体行为见 [CLI 参考](apps/cli/reference/README.md#plugin-management)。

[CLI（命令行界面）参考](apps/cli/README.md)介绍 headless 执行与自定义 profile。[Python SDK](python/README.md) 和[示例](examples/README.md)介绍程序化组合与自定义组合。

## 社区

扫描二维码，或打开 <a href="https://wj.qq.com/s2/27234598/03eb/">DeepSeek Harness 微信社区申请页面</a> 申请加入。

<p>
  <img src="assets/community-wecom-survey.png" alt="DeepSeek Harness 微信社区二维码" width="240">
</p>

## 开发

请先阅读[开发指南](docs/development.md)；修改包之前，请阅读[架构文档](docs/architecture.md)。

面向 agent：遵循 [AGENTS.md](AGENTS.md)。

## 许可证

[BSD 3-Clause](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 参与贡献

向本仓库贡献前，请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。
