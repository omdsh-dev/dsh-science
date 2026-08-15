# Agent Note: DSH Science 桌面发行与生态调查

Status: proposed

[English](2026-08-15-dsh-science-desktop-distribution-reconnaissance.md) | 中文

## Problem

DSH Science 需要一个可发布的 v0.1：保留 Web 访问，增加普通桌面发行，并同时提供 Standard 与 Science mode，而不复制产品逻辑。DSH 已经负责 provider／模型选择、Session 持久化、权限、设置、凭据引用与 Web client composition；Science 必须消费这些能力，而不是建立平行 stack。

官方 DSH 没有 desktop artifact 或 desktop release lifecycle；当前 Science source 与本次检查的官方 baseline 存在差异；required Science Session event 目前也无法由纯仓外 bundle 针对该源码注册。社区 desktop 与 workbench 项目包含有用模式，但其年龄、release 声明、权限与 state model 都不足以支持继承整个 fork。

本决策还必须把使用已有 Python／R installation 的 v0.1，与后续面向普通用户的环境供应链分开。把 download、install、repair、update、rollback 或 deletion 放进 Science Runtime，会把 installer authority 与 exact-Session execution 混在一起。

## Proposal

采用一份确切官方 DSH 源码基线、独立负责的 Science overlay（覆盖层）与 bundle（组合包）、一个共享 Web 客户端，以及精简的 Electron 桌面宿主。Web 与 Desktop 是载体，Standard 与 Science 是组合。四种产品形态共享 DSH 基础，而不是发展成四套代码。

Web v0.1 使用现有 HTTP／WebSocket 载体。Desktop v0.1 遵循官方 Client 分层：Electron 打包确切的 DSH runtime 与同一份已构建 Web 客户端，从 app-owned `file://` 入口加载该客户端，并向 Host handler 提供狭窄的 IPC fetch／stream 载体。Electron 只负责生命周期与传输，不实现 Science 行为。

从确切公开官方 source 建立新的发行 baseline，再移植最小通用 patch 与 Science 自有 package。不要 rebase 到社区 fork，也不要把当前仓库保留为永久整树 fork。长期目标是在 package family 具有公开 source provenance、完整 integrity／compatibility identity、required downstream Session event registration 与 packed-install 证据后，采用官方 package 加仓外 Science bundle。

v0.1 不打包 Conda，也不管理环境。Science 设置卡片通过 interpreter 路径选择已有 Python／R Conda 环境，并记录公共 package 来源默认值；settings provider 把每个已选 interpreter canonicalize 到其所属 Conda prefix，而当前 Runtime 仍只消费 `pythonPrefix` 与 `rPrefix`，要求 `conda-meta/history`，并从固定平台路径解析 interpreter。任意非 Conda executable 不属于 v0.1。只有后续一键托管环境发行才需要独立 Science Environment Manager capability；该职责绝不进入 Science Runtime。

## 范围与证据方法

本决策使用 2026-08-15 收集的只读证据。调查检查了仓库 metadata、确切 commit 与 tag、license、package manifest、source、CI workflow、release metadata 与官方供应链文档。未安装、执行或信任任何社区插件或 binary。GitHub 广度扫描检查 150 条搜索结果，保留 40 个与 desktop、Web UI、sidebar、artifact、workspace 及 plugin market 相关的仓库；下表记录会实质影响决策的项目。

仓库年龄、star、tag、README 声明，以及 release 是否存在，都只是发现信号，不是成熟度或安全证据。下文的事实描述已检查的源码或 metadata；推断说明这些事实意味着什么；建议说明本项目的选择。

## 基线

### 官方 DSH

截至 2026-08-15，官方仓库默认 `master` 分支是 [`deepseek-ai/deepseek-harness@47f943859bef60e4160492346772ded9b24f765a`](https://github.com/deepseek-ai/deepseek-harness/commit/47f943859bef60e4160492346772ded9b24f765a)，提交于 2026-08-13。本提案选择该确切 commit 作为公开源码 baseline。它是 MIT license、根版本为 `0.1.0-rc.5` 的 developer preview 源码，只交付 CLI 与 Web 应用，没有官方 Electron app、desktop installer、desktop signing、desktop updater 或 [GitHub Release](https://github.com/deepseek-ai/deepseek-harness/releases)。官方架构已经分离 Host 与 Client，并支持 profile／bundle 和客户端插件组合。[GUI 分层决策](../../implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md)预留了复用 Web client package、只把载体替换为 IPC fetch 的 Electron 应用；该 baseline 中没有这种 shell，也没有 protocol-version field。

另一个独立观测到的 artifact identity 是 [`@deepseek-ai/dsh@0.1.0-rc.6`](https://www.npmjs.com/package/@deepseek-ai/dsh/v/0.1.0-rc.6)。在 2026-08-15，[registry metadata](https://registry.npmjs.org/@deepseek-ai%2Fdsh)把 `latest` 与 `next` 都指向 RC6，记录其发布时间为 `2026-08-13T12:35:03.812Z`，tarball integrity 为 `sha512-brpZfED7ieRa2PQ5tUxMhHrM1pb2CmKFVM/f6yMULBDMicahk+Z2OsHgTwTDnoiZm23Ftu9rQz0NN4pflaoJcg==`；其中没有 RC6 `gitHead`，也没有 RC5 发布时间。尚未确认任何公开 commit、tag、tree 或 source archive 对应 RC6。因此，本记录只把 RC6 作为源码未映射的 npm artifact 观测，并只把 `47f943...`／RC5 作为公开源码 baseline 采用；时间接近不能建立等价关系。

官方 package 发布、基础 CLI 安装、profile 更新和 desktop 更新是不同机制。确切源码的 [release workflow](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/.github/workflows/release.yml)从 `dsh-v*` tag 发布 package tarball，并把 prerelease 指向 `next`；用户的外部 npm／pnpm 安装负责更新基础 `@deepseek-ai/dsh` CLI；[`dsh plugin --profile <name> update`](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/47f943859bef60e4160492346772ded9b24f765a/apps/cli/reference/README.md)只在一个 profile 中转交 pnpm，再协调其 bundle，并不更新基础 CLI。三者都不更新 packaged desktop closure；提议的精简 desktop 发行必须拥有自己的签名应用更新生命周期。

在 `47f943...` 源码构建中，`KNOWN_SESSION_EVENT_TYPES` 从源码树生成。未知且非 `ignorable` 的 event 会使日志读取失败；源码注释明确把仓外 event 注册延后。Science mode、environment、run、chart 与 Outcome event 是权威事实，不能标记为 ignorable。这会阻塞针对未修改 `47f943...` build 的纯 package Science；源码未映射的 RC6 artifact 必须单独审计 tarball 与 API，才能对它作出相同判断。

### 当前 DSH Science

本次调查从 `main@e5e8b29b435f67e0a5dde5e2132580966e78b27b` 开始。当前已实现的 Science 所有权有意保持狭窄：

- `dsh-science-session` 负责 required durable event、strict replay、projection 与 provenance validation。
- `dsh-science-runtime` 观测显式选择的已有 Conda prefix，并在 exact Session lease 下执行其中固定的 Python／R interpreter 路径。它不创建、更新、修复或删除环境。
- DSH 本身继续负责 provider／模型选择、凭据引用、设置、Session、权限、attachment、Host／client 传输与 Standard 组合。

独立 Phase 3 候选 `fae091e1080e830bed8ad0456e4cbced29101b01` 只作为背景身份，没有被修改或重新验收。Science tool、preset、chart／Outcome Consumer、设置卡片与 Science client UI 是计划中的 overlay owner，并非 `e5e8b29...` 已交付能力。

本地 commit `0a940733e80d57c70245134bf260012f9be29114` 与 `e5e8b29b435f67e0a5dde5e2132580966e78b27b` 中的通用 runtime-context replacement 修复不在官方 `47f943...`；它属于 upstream candidate（上游候选），而非 Science 自有行为。read-only filesystem commit `8c7d5e01e3876b0c645f13f20ada8cf7add0c356` 与 `0073f6e0a11cd3444564cd1add5a252c70200b64` 属于同类且尚未被接受的通用候选。

## 候选证据

| 项目 | 确切身份、维护时间、license | 直接证据 | 决策 |
|---|---|---|---|
| [anywhere-labs/deepseek-harness-desktop](https://github.com/anywhere-labs/deepseek-harness-desktop) | HEAD [`549fd422`](https://github.com/anywhere-labs/deepseek-harness-desktop/commit/549fd4226729c6add02aa53e44091f5389bbce8e)；release tag [`v0.1.0@4081742`](https://github.com/anywhere-labs/deepseek-harness-desktop/releases/tag/v0.1.0)；创建于 `2026-08-13T16:30:50Z`，最后 push 于 `2026-08-14T17:47:17Z`；MIT | 完整复制的 DSH monorepo 加 Electron 43 app；HEAD stage production DSH closure，并实现 single-instance、tray、exact origin、sandboxed renderer 与 owned Host teardown。该 tag 有 DMG／EXE asset，但 HEAD 的 Windows target 只有 directory，且没有已检查 workflow 证明这些 asset 或 signature | **移植** lifecycle、runtime staging、origin 与权限控制；拒绝复制的 monorepo |
| [bruc3van/dsh-desktop](https://github.com/bruc3van/dsh-desktop) | HEAD [`04952135`](https://github.com/bruc3van/dsh-desktop/commit/049521353d9711278d84239ce6b78cf69fd4cb87)；`v0.1.5` tag object `d2f70dfa`，peeled commit [`22bb7e33`](https://github.com/bruc3van/dsh-desktop/commit/22bb7e335f34cd5346ee507b9091327fb7c6c0a1)；创建于 `2026-08-12T04:30:03Z`，最后 push 于 `2026-08-14T18:23:40Z`；MIT | 依托固定 DSH RC6 的精简 Electron 39 shell；具备 bundled fallback runtime、restart budget、process-tree cleanup、精确 navigation／IPC check，以及来源／SHA 受限 updater。release 有 macOS／Windows asset；HEAD 有 packaged／NSIS smoke，但配置为 ad-hoc／unsigned macOS 与 unsigned Windows | **移植** supervisor、IPC check、update verification 与 install-smoke 模式；作为主要 Electron 验证候选 |
| [dataelement/dsh-desktop](https://github.com/dataelement/dsh-desktop) | HEAD [`29d52400`](https://github.com/dataelement/dsh-desktop/commit/29d52400c42d6c2121ffcfeb2c8b550cea302732)；`v0.1.5` tag object `44c295e2`，peeled 到 HEAD；创建于 `2026-08-13T13:45:50Z`，最后 push 于 `2026-08-14T15:17:06Z`；MIT | Electron 43；HEAD workflow 包含 macOS signing、notarization、staple 与 verification step，但实际 release signature 未检查。它 patch 官方 package，允许任意 loopback origin，禁用 Windows update-signature check，使用 `asar: false`，且未证明 Windows process-tree teardown | 只**移植** macOS release workflow；拒绝 patch-package、宽泛 origin 与 Windows updater policy |
| [xiincs/deepseek-harness-desktop](https://github.com/xiincs/deepseek-harness-desktop) | HEAD [`18306682`](https://github.com/xiincs/deepseek-harness-desktop/commit/183066822e0345e846e0e6bd3659cfe21c4b48a0)；`v1.0.0` tag object `32d5c934`，peeled 到 HEAD；创建于 `2026-08-13T17:32:36Z`，最后 push 于 `2026-08-14T11:48:57Z`；MIT | Tauri 2，带 bundled Node／DSH、tray、single-instance、restart 与三平台 asset。source／workflow 配置 Tauri updater signature，不是 Authenticode 或 Apple signing；实际 release signature 未检查。它有 `csp: null`、没有闭环 exact-origin navigation 证明、lifecycle／install smoke 不完整，且版本 manifest 不一致 | **参考**为 Tauri 对照候选；不采用 |
| [zhu1090093659/dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui) | HEAD [`62651870`](https://github.com/zhu1090093659/dsh-web-ui/commit/62651870dd18ad3d9bf54a9cb934b75d0fbaf639)；tag `v0.1.12@ddcca76639e113c3f84396654a30a0e5c7f87678`；创建于 `2026-08-12T05:15:20Z`，最后 push 于 `2026-08-14T14:14:54Z`；Apache-2.0 | 非 fork 的 DSH bundle／client-extension monorepo，具备 session-scoped panel／service registration、disposal、build／test CI 与 npm release workflow；没有 desktop artifact。其 aggregate 同时授予 SSH、subprocess、file 与 Git mutation capability | **移植** panel／service registration 与 lifecycle 模式；拒绝 aggregate bundle |
| [omdsh-dev/DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) | HEAD [`2bace68a`](https://github.com/omdsh-dev/DSH-better-sidebar/commit/2bace68af8fa092a9a75070231bbf3488ee55a6b)；`v0.12.1` tag object `9c08fa28`，peeled commit [`4e275aa3`](https://github.com/omdsh-dev/DSH-better-sidebar/commit/4e275aa3218fc10c5623283d5958155a6618b5cd)；创建于 `2026-08-07T16:04:00Z`，最后 push 于 `2026-08-14T17:55:39Z`；MIT | 真实 bundle／client plugin，具备 service-first tab／viewer registration、lazy chunk、session isolation、packed-install 与 Playwright CI。它还携带 terminal／Git／filesystem 权限，推荐远程 install script，并允许用户关闭 iframe sandbox | 只**移植**固定且不可降级的 renderer registration 与 lazy-loading 模式 |
| [poplarity/dsh-science-workbench](https://github.com/poplarity/dsh-science-workbench) | HEAD [`754ed9ed`](https://github.com/poplarity/dsh-science-workbench/commit/754ed9ed9fc37db3eb4d21fd4be4842000c47b2e)；创建于 `2026-08-14T12:46:27Z`，最后 push 于 `2026-08-14T14:15:03Z`；MIT；无 release | DSH client／tool extension 与 chart-lineage UX，但在该 SHA，execution 使用 `danger-full-access`、shell string、PATH interpreter、mutable manifest 与 Git，且未发现 Science event registration。唯一 test script 是 `node --check`；未发现 CI workflow | **参考** workbench 与 lineage UX；拒绝 execution、environment 与 state code |
| [biociao/dsh-science](https://github.com/biociao/dsh-science) | HEAD [`ef7ef5ad`](https://github.com/biociao/dsh-science/commit/ef7ef5ad4b78c8a58b2545afe33bc17d60d72f95)；创建于 `2026-08-14T03:05:28Z`，最后 push 于 `2026-08-14T11:51:22Z`；MIT；无 release | Bundle、preset、skill 与 filesystem artifact registry；provenance 是独立 mutable manifest。在该 SHA 未发现 Science Runtime、exact-Session ownership 或 client extension | **参考** terminology 与 artifact-version UX；拒绝 state engine |
| [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) | HEAD [`45b3fbf9`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/commit/45b3fbf9144ea61b7554b8ad129de232e436a2d8)；创建于 `2026-08-13T13:55:31Z`，最后 push 于 `2026-08-14T18:04:10Z`；CC0-1.0；无 release | README／site index，没有 DSH bundle 或 installer。其 CI 收集 npm／README／star metadata，但不检查 plugin source、installation behavior 或 security | 只**参考**发现信息；绝不作为 trust root 或 allowlist |
| [dsh-market/dsh-market](https://github.com/dsh-market/dsh-market) | HEAD 与 tag `v1.2.2` 均为 [`67a66a4e`](https://github.com/dsh-market/dsh-market/commit/67a66a4e7cd6c344772ce38846b99f6a79074052)；创建于 `2026-08-14T04:58:15Z`，最后 push 于 `2026-08-14T18:09:54Z`；package 声称 MIT，但仓库没有 license file | 真实 bundle／client market，具备 URL 与 manifest check；安装调用 `dsh plugin add/remove`，且可能 enable Corepack 或全局安装 pnpm。其 registry source 是 index，而不是签名 provenance | 只**参考** market UX 与失败清理；拒绝自动安装与 global-tool bootstrapping |

其他有用但不具权威性的参考包括：[Wisp Science `6f20cff`](https://github.com/xuzhougeng/wisp-science/tree/6f20cff34d31e0f3eb336c0364aee71dbb7c5ba4) 的科学工作台 UX 与 updater 概念，但受 AGPL-3.0-only license 约束。Wisp 从 PATH 或 `UV_PATH` 发现 `uv`，使用 `.wisp_deps_ok` marker 而不是完整 environment seal，从 PATH 或常见目录发现 R，且没有 locked side-by-side revision 或完整 repair／uninstall lifecycle。[dsh-genui `f75f286`](https://github.com/omdsh-dev/dsh-genui/tree/f75f28621c46ffebf73f368d29c60ab4a83e19b3)提供 allowlisted chart rendering 参考；[dsh-visualize `0da0ab5`](https://github.com/Nagi-ovo/dsh-visualize/tree/0da0ab5a274146c023be652f0d8848ccca8b09d4)提供 opaque-origin iframe 与 CSP 处理参考，但其 repository license 证据不完整。它们都不能替代 immutable attachment、strict Session replay、exact Runtime ownership 或产品验收。

本次检查没有任何社区仓库符合整项目采用条件。

## 载体比较

| 载体 | 优点 | 成本与缺口 | 决策 |
|---|---|---|---|
| Electron | 复用 DSH 的 Web stack，并可用 Electron embedded Node 或确切 standalone Node 运行 Host；社区代码已展示 runtime staging、lifecycle、exact-origin policy、NSIS／DMG packaging 与 packaged smoke | 应用更大；embedded-Node engine、ESM 与 native-addon ABI compatibility 保持 `NOT-RUN`；正式 signing、notarization、Windows Authenticode、migration 与 rollback 仍需自行负责 | **选择为 Desktop** |
| Tauri 2 | remote page 可以不获 Tauri command capability | DSH 仍需要确切 Node 与 package closure；在没有消除 Host 复杂度的情况下增加 Rust、system-WebView 差异、sidecar lifecycle 与另一套 signing 语义。packaged size、memory 与 startup 优势保持 `NOT-RUN` | 构建一次作为对照，不设为默认 |
| Browser／PWA | 覆盖广且可嵌入；已有 DSH client／bundle 模型天然适配 | 浏览器本身不能负责 local Node Host lifecycle、single-instance、process cleanup、environment discovery、installer、OS credential 或 native update | **保留为一等 Web 载体** |
| IDE／mobile／custom WebView | 可以嵌入已有 Host，并提供 workspace UX 参考 | 独立安装、升级、迁移与安全生命周期证据不足 | 仅参考 |

## Web/Desktop × Standard/Science 架构

载体与组合是两个独立选择。一个发行版可以提供两种组合；选择 Science 改变 bundle／profile 与 Session applicability，而不改变 provider stack 或 transport protocol。

| | Standard 组合 | Science 组合 |
|---|---|---|
| Web 载体 | 官方 Web Host／client、Standard preset 与 tool | 同一 Host／client 加 Science Session、Runtime、tool、preset、设置卡片、chart／Outcome consumer 与溯源侧边栏 |
| Desktop 载体 | 精简 Electron host 打包确切 Standard Web 组合 | 同一 Electron binary 与客户端加载 Science 组合；Electron 不负责 Science state 或 execution logic |

该矩阵描述 composition，而不是 platform acceptance。当前 Windows sandbox 只报告 partial enforcement，而 Science Runtime 在 environment probe 与每次 Python／R run 中都要求 full enforcement；Windows Science 因而以 `CONFINEMENT_UNAVAILABLE` fail closed。v0.1 可以发布 Windows Standard，但在具备 full-confinement provider 与独立 real Python／R acceptance 前，Windows Science 不是 release target。其他平台也只有在各自 full-sandbox 与 real-runtime evidence 完成后才符合条件。

共享层如下：

1. **官方 DSH 基础：**Cordis、Host service、Session log／projection、权限、provider／模型 capability、设置、凭据引用、attachment、API gateway 与 Web client slot。
2. **Science overlay：**Science 自有 package 与一个 Science bundle／profile。Standard 不加载 Science consumer，不发出 Science event，也不暴露 Science UI。
3. **载体 adapter：**浏览器使用 HTTP／WebSocket，Desktop 使用 Electron IPC fetch／stream 载体。二者挂载同一份 built client package，并终止于同一个 Host handler。嵌入不会绕过 Host 权限、凭据引用、origin policy 或 IPC sender validation。
4. **发行 metadata：**upstream URL／SHA／version、overlay SHA／version、bundle／profile revision、Host／client protocol identity、desktop version、package closure digest、environment identity、build provenance、checksum、signing identity 与 migration range。后续已接受 baseline 与 artifact tuple 属于 [`docs/evidence/`](../../../../docs/evidence/AGENTS.md) 下的日期化记录。本 proposal 自身记录上述调查 identity；当前没有独立日期化 acceptance record，且这些 identity 不证明 source、package、desktop、signing、installer 或 runtime PASS。

Desktop v0.1 创建一个 app-owned DSH Host，加载已打包的 `file://` client entry，并只通过狭窄 preload bridge 暴露 typed fetch 与 stream message。main process 验证 sender、top frame、entry URL、request size、response size、stream identity、cancellation 与 teardown。renderer 使用 context isolation、禁用 Node integration、默认拒绝 permission、拒绝 navigation 与 popup，并把外部链接交给 OS。supervisor 负责 single-instance、tray／close policy、bounded restart、owned Host settlement、Windows child-process cleanup 与 explicit-quit cleanup。packaged runtime 绝不回退到 PATH 中未定版本的 DSH。

Web 是受支持产品，而非开发回退。当嵌入 Host 提供同样的带版本 API 与 security policy 时，受支持的 client module 可以嵌入其他网站。任意页面不会仅因嵌入客户端就获得 local filesystem、process、credential 或 Science Runtime 权限。

## Science 环境供应

本发行决策为 v0.1 选择 prefix-only Runtime 配置：设置卡片可以把确切 Python 与 `Rscript` picker 作为发现输入，但每个已选 executable 必须解析到已有 `external/unmanaged` Conda prefix。成功的设置事务保存推导出的 profile prefix 与公共 Conda／Python／CRAN 来源默认值，而不授予 install authority。由于 Runtime profile 是加载时不可变 Config，v0.1 要求重启 Host 后，变更的 profile 设置才生效；重启后由 composition resolver 把保存的 prefix 提供给 Runtime。变更只影响未来 Session binding。Runtime 仍是最终权威：它 canonicalize 每个 prefix、要求 `conda-meta/history`、解析固定平台 executable，并持久绑定已验证 identity；已有 Session binding 绝不重绑。当前 [Science MVP 产品 owner](../feature/2026-08-12-science-mode-core-mvp.md#v01-product-boundary)仍描述可选 prefix 与显式 executable 并列配置；设置实现开始前，必须在另行授权的产品文档变更中对齐。本次调查的源码 identity 尚未实现设置卡片，DSH 不打包 Conda，也不修改已选 prefix。

后续面向普通用户的一键环境需要独立 `ScienceEnvironmentManager` capability，包含 Service Definition、provider 与 Consumer。它负责 signed environment manifest、download、hash、platform lock、side-by-side concrete revision、health probe、transaction recovery、repair、rollback，以及只删除 manager-owned prefix。activation 只改变后续 binding 的默认 revision；Runtime 收到 immutable concrete prefix，而不是移动的 alias，并继续独占 exact-Session lease。revision collection 同时消费 Runtime settlement 与 durable Session-retention pin，因此空闲但保留的 Session 不会失去其 provenance 命名的环境。

Manager 只写 manager-owned staging、cache 与 revision directory；使用固定 config 与 allowed network domain；拒绝 disabled TLS；不继承用户 Pixi／Conda config、project path、DSH home 或 credential environment；默认不运行 package post-link script。外部 prefix 保持 `external/unmanaged`：discovery 只读，import 需要显式 copy 或 rebuild，而不是接管、repair、update 或 uninstall 用户 prefix。managed manifest／revision digest 必须进入 Runtime observation 与 durable Science environment binding；download progress 与 crash-recovery journal 则保持为 manager state。

调查倾向未来托管实现采用 locked Pixi，因为 [Pixi `v0.76.2`](https://github.com/prefix-dev/pixi/releases/tag/v0.76.2)发布跨平台 binary 与 checksum，[`pixi install --frozen/--locked`](https://pixi.sh/latest/reference/cli/pixi/install/)同时覆盖 Python、R 与 native dependency，而 [`pixi reinstall`](https://pixi.sh/latest/reference/cli/pixi/reinstall/)提供独立 rebuild operation。checksum 建立 integrity，而不是 bootstrap authenticity 或 channel trust。[Conda explicit specification](https://docs.conda.io/projects/conda/en/stable/user-guide/tasks/manage-environments.html)只能在同一平台精确复现 package；普通跨平台 YAML 不是 exact lock。[Micromamba](https://mamba.readthedocs.io/en/stable/user_guide/micromamba.html)是没有默认 Python 的 static executable，[uv](https://docs.astral.sh/uv/concepts/python-versions/)只解决 Python 且使用第三方 redistributable Python build，[renv](https://docs.posit.co/ide/user/ide/guide/environments/r/renv.html)则假设 R 已存在。这是调查结论，不是 v0.1 dependency selection 或 environment PASS。

v0.1 不安装或运行 Jupyter kernel、notebook 或 persistent kernel。后续 [Jupyter Kernel Provisioner](https://jupyter-client.readthedocs.io/en/stable/provisioning.html)／kernelspec integration 是 interoperability Consumer，不能替代 Runtime 的 exact-Session ownership；[nbformat MIME output](https://nbformat.readthedocs.io/en/stable/format_description.html)不能绕过 immutable attachment 或 chart provenance。

私有 mirror 使用已有 DSH credentials capability 的 opaque reference。desktop credentials provider 可以通过 [macOS Keychain](https://developer.apple.com/documentation/security/keychain-services)或 [Windows Credential Manager](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritea)解析这些引用，并注入最小 process-scoped value；Environment Manager 绝不直接调用 OS secret store。Session event、manifest、log 与 subprocess diagnostic 绝不包含 secret。

应用更新、environment update 与 data migration 保持分离。signed desktop updater 负责 packaged Node／DSH／client closure；Environment Manager 负责 side-by-side environment revision；durable Session 与 settings schema 以独立 backup 单调、事务化迁移。应用 rollback 绝不静默反向迁移数据。

## 所有权矩阵

| 处置 | 项目 |
|---|---|
| 保留在 DSH Science | Science Session event／fold／projection、Runtime exact-Session execution、Science tool／preset、chart／Outcome publication、设置卡片、溯源侧边栏、Science bundle |
| 建议上游到官方 DSH | replacement／retry／resume 后通用 runtime-context resubmission；read-only filesystem 入口；required downstream Session-event registration；带版本 external desktop carrier／client protocol。本记录不把其中任何一项称为已接受 upstream behavior |
| 采用为维护依赖 | 本次调查的社区生态中没有 |
| 重写、测试后移植 | Electron supervisor／security／release 模式；session-scoped panel registration；lazy／sandboxed artifact rendering；package／install smoke 模式 |
| 只参考 | Tauri 对照、Wisp UX、社区 workbench 术语、plugin index |
| 拒绝 | 社区整树 fork、Science execution 使用未版本化 PATH interpreter 或 shell-string construction、`danger-full-access`、把 mutable side manifest 当权威、宽泛 loopback navigation、信任 unsigned update、远程 install script、自动安装 global tool |

## Alternatives considered

**把当前 history rebase 到官方 upstream。**拒绝。`e5e8b29...` 与 `47f943...` 没有 merge base，左右计数为 `17/12,293`，下游 snapshot root 是 `7b9644f2b664e46c9518506035aa6c8d5af4d8e8`。大范围 history replay 会模糊所有权，并可能恢复冲突的 branding、license、version 与 release 文件。

**把当前仓库作为长期 full fork 维护。**拒绝作为产品模型。技术上可行，但会让本项目负责每项 upstream security、packaging、release、protocol 与 migration change，并具有最高持续 drift cost。

**使用官方 npm package 加仓外 Science bundle。**保留为长期目标，而不是当前 baseline。它受源码未映射的 RC6 provenance、完整 package-family version／integrity、Host／client／closure compatibility identity、required Science-event registration／cold replay，以及 anonymous packed-install evidence 阻塞。

**建立干净确切公开源码 baseline，再移植 Science overlay 与精简 Electron host。**选择为下一条发行线。它明确是 `47f943...`／RC5 公开源码 derivative，而不是 RC6 等价 build，并让通用候选、Science package、carrier code 与 artifact evidence 分别可审查。

**基于社区 desktop fork 继续开发。**拒绝。它继承无人负责的 monorepo drift、安全与发行决策、只有数日的历史，且没有 Science durable-state 保证。

选定的 rebaseline 流程如下：

1. 分开记录 `adopted_source_baseline` 与 `observed_artifact` identity：官方 URL、确切 SHA、根版本、source archive checksum、npm package version／integrity／source mapping、当前 Science identity，以及每项本地通用／Science 自有差异。没有公开 mapping 时绝不把两者视为等价，也不要把移动中的 branch 或源码未映射 artifact 称为 source baseline。
2. 在官方 SHA 建立新的隔离 worktree。不要 rebase、merge 或改写当前 Phase 3 候选。
3. 丢弃与官方源码冲突的下游 branding、version、license 与 release config；保留官方 notice，并进行 license review。
4. 针对当前官方 API，把通用修复作为独立 upstreamable change 移植。把 Science Session、Runtime、tool、bundle／preset、chart／Outcome、设置与 client UI 作为 Science 自有 slice 移植。
5. 只有在共享 Web Standard 与 Web Science 组合通过后，才加入精简 Electron app。desktop packaging／signing evidence 与 source acceptance 保持分层。
6. 每次官方 release 都触发 read-only intake；只有计划内 checkpoint、阻塞／安全变化或 v0.1 freeze 才实际采用。应从下一份确切公开 source 开始，比较 source 与 behavior，再重放小型自有 stack。绝不把移动中的 `master` 或源码未映射 npm artifact 直接 merge 进 release branch。
7. 只有在公开 source mapping、完整 package-family version／integrity、Host／client／closure compatibility identity、无需 patch 官方 build 的 required downstream event registration／cold replay，以及 anonymous packed-install evidence 全部通过后，才转向官方 package 加 external Science bundle。

## Acceptance criteria

当以下条件成立时，本 proposal 才可接受：分列的 `adopted_source_baseline`、`observed_artifact` identity 与 Science overlay inventory 已记录，且没有推断两者等价；设置实现前 Science MVP 产品 owner 已对齐 prefix-only 加载／重启语义；Web Standard、Web Science、Desktop Standard 与 Desktop Science 使用共享 Host／client 与 composition model；Electron carrier 通过安全与 lifecycle 检查；Science 设置不修改 environment；required Science event 可从 cold state replay；source、package、desktop artifact、signing、installer 与 real Python／R evidence 始终分开报告。

实施前，先对两个社区候选分别进行 supply-chain review，再只在另行授权、没有 credential 或 project state 访问权的隔离 VM／CI 中构建。该 build 是比较，不是 implementation dependency 或 code baseline：

1. Electron：[`bruc3van/dsh-desktop@04952135`](https://github.com/bruc3van/dsh-desktop/commit/049521353d9711278d84239ce6b78cf69fd4cb87)。
2. Tauri 对照：[`xiincs/deepseek-harness-desktop@18306682`](https://github.com/xiincs/deepseek-harness-desktop/commit/183066822e0345e846e0e6bd3659cfe21c4b48a0)。

社区 shell 对照覆盖 empty PATH、offline second start、exact packaged runtime identity、occupied port、hostile loopback origin、readiness timeout、Host crash／bounded restart、single-instance、close／tray／explicit quit、orphan-process check、external navigation、redirect、popup／permission denial、存在时的 IPC sender／frame check、updater source／hash／signature rejection，以及 unsigned installer smoke。它把 code signing、notarization 与 Authenticode 报告为 `NOT-RUN`；credential-free build 不能证明这些项目。

后续第一方 DSH prototype 分别验证 Standard／Science switching、Science data retention、确切 Host／client protocol mismatch behavior、macOS DMG lifecycle，以及 Windows Standard NSIS install／upgrade／uninstall。signing、notarization 与 Authenticode 需要自有 credentialed release pipeline；Windows Science 必须先具备 full confinement 与 real Python／R acceptance。

Python／R／Conda supply、Windows Science、Jupyter、OS credential store、schema migration、rollback、telemetry 与 real scientific execution 在本次候选比较中保持 `NOT-RUN`。每一项都是独立证据层。

## Risks

主要风险是低估 official-baseline port，把源码未映射的 RC6 或社区 release metadata 当成 source／binary evidence，让 Electron carrier 变成第二套 API 或产品实现，为实现纯 package 分发而削弱 required Science-event replay，或让后续 environment manager 修改或回收被 active／retained Session 命名的 prefix。proposal 通过双身份、狭窄 IPC carrier、strict Session event 与分层 evidence 约束这些风险。

本记录不实现 desktop app、不打包 installer、不选择最终 bundle identifier 或 signing identity、不发布 npm package、不运行社区 binary、不 rebase code、不改变 Phase 3、不管理 Conda environment，也不证明 desktop、installer、signing、notarization、Windows、Python、R 或 release readiness。

以下事实仍未验证：RC6 的公开 commit／tag／tree／source archive，以及它是否包含 `47f943...` 没有的 event registration、client protocol 或 runtime-context change；每个 RC6 family package 的 version、integrity、publish time、metadata 与 anonymous packed install；未公开的官方 desktop 工作；社区 release asset 的实际 signature 与 notarization ticket；尚未实现的 settings-card UX；Electron embedded-Node compatibility；Windows full confinement 与 real Python／R acceptance；最终 app name、update feed、migration schema 与 rollback policy；Pixi bootstrap authenticity、trusted lock／channel policy、三平台 materialization、post-link policy、transaction recovery、managed-manifest durability、repair／uninstall 与 Session retention；OS credential-provider implementation 与 private-mirror redaction；Jupyter interoperability；Conda／PyPI／CRAN redistribution、license、channel 与 SBOM obligation；以及 event registration、runtime-context、read-only filesystem 与 desktop protocol candidate 获 upstream 接受的时间。

本次调查中的社区仓库都只有数日历史，并可能在上述带日期身份之后快速变化。任何采用或移植决策都需要重新进行 exact-SHA audit 与适用的 license review。
