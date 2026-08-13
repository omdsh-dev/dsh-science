# Agent Note: Science 运行时与本地 Conda 提供方

Status: implemented

[English](2026-08-13-science-runtime-and-local-conda-provider.md) | 中文

## 问题

[Science Mode MVP 记录](../../proposed/feature/2026-08-12-science-mode-core-mvp.md)冻结了持久的 Science 会话事实，并将绑定已有 Conda 前缀的 Runtime 工作归入 Phase 2。执行边界必须把进程树清理保留给 `ctx.subprocess`，避免干净环境继承环境凭据，把私有 Science 暂存目录而不是项目目录设为授权范围，在源码 spawn 前记录 run，并在使用 Host path 前拒绝远端执行环境。

这条边界还必须确保会话日志具有权威性。环境身份、运行开始和终态结算是持久事实；可变进程句柄与暂存文件不是。后续面向模型的工具需要一个操作，由它产生每项外部事实，并按正确顺序提交对应事件；不能把低层提供方交给工具，使工具成为第二个变更责任方。

Phase 2 属于产品功能之前的基础设施。它不包含 Science preset、工具、提示词、图表或 Outcome 消费方、客户端 UI、持久内核、环境管理器，也不加入随产品交付的组合包。虚拟前缀测试与显式启用的真实机器验收仍是分别报告的证据层。

## 决策

### Phase 边界与包职责

Phase 2 包含一个包，不包含生产消费方。

| 包 | 负责 | 不负责 |
|---|---|---|
| `@deepseek-ai/dsh-science-runtime` | `ctx.scienceRuntime`、操作／结果／错误词汇，以及唯一的本地 Conda 实现：允许列表内的 profile 配置、稳定观测、精确会话预约、Science 暂存目录、直接 argv 构造、超时／结果分类，以及对共享服务的编排 | 第二个执行提供方、shell 解析、OS 进程树信号、通用沙箱策略、工具、提示词文本、展示、UI、附件／图表发布或环境创建 |
| 既有能力责任方 | `ctx.subprocess` 负责受管进程树、输出收集、TERM-to-KILL 与完全停稳；`ctx.sandbox` 负责 argv 限制与 runner 诊断；`dsh-home-paths` 负责 Harness home 解析；`dsh-timeout` 负责关联的截止时间 | Science 状态转换或会话变更 |

只有一个可设想的提供方、且没有生产消费方时，这些角色应留在同一个包中，直到出现第二个提供方，或生产消费方否则必须导入仅属于本地实现的类型（[能力 seam 的角色划分](../../implemented/architecture/2026-06-13-capability-seams.md)）。因此 Phase 2 不创建 `@deepseek-ai/dsh-science-runtime-local`，也不声称已经具备完整的三角色 seam。导出的服务类型不含宿主暂存路径、Conda 前缀类型或其他仅属于本地实现的模块，以便日后提取时不必改写调用方。

Phase 3 新增 `@deepseek-ai/dsh-tool-science` 作为生产消费方。这些工具注入 `ctx.scienceRuntime`，绝不自行追加 `science/environment-bound`、`science/run-started` 或 `science/run-finished`。如果折叠后的包无法把仅属于本地实现的类型排除在该导出之外，Phase 3 在同一次变更中提取本地提供方。Loader 测试可以组装这个折叠后的包；它并不使 seam 完整，也不能证明角色需要独立演进。Phase 2 不把该包注册到随产品交付的 profile。

Science 执行不同于 `ctx.codeRuntime`。它在全新进程中执行一个精确的 Python 或 R 源文件，不暴露宿主绑定桥接或 Code Mode SDK，也不实现 Code Mode 记录中延后的 CPython 后端。

本地提供方只有在证明子进程环境位于宿主本地后，才使用 `node:fs` 管理其私有的宿主暂存目录。暂存目录不通过 `ctx.fs` 处理，因为后者当前面向执行环境的文本 API 不具备私有目录模式、排他标记、文件同步或目录同步原语。这项范围有限的职责不会形成第二个通用文件系统提供方。Phase 2 也不使用 `dsh-shell` 或 `ctx.jobs`：argv 始终为结构化数据；每项操作都是由调用方负责的前台句柄，而不是跨轮次后台工作。

### 必需的通用能力扩展

Phase 2 先补齐四处范围有限的通用缺口，而不绕过既有 seam。

1. `SubprocessSpawnSpec` 新增必填字段 `environmentBase: 'scrubbed-parent' | 'empty'`。每个现有消费方都显式填写其既有的 `'scrubbed-parent'` 选择；Science 使用 `'empty'`。本地与 E2B 提供方必须先向被请求的程序提供该精确基础环境，再应用 `spec.env`。提供方的控制进程可以保留其已记录的传输环境，但不得让该环境进入目标程序。
2. `SubprocessRuntime` 暴露只读的 `executionWorld: 'host-local' | 'remote'` 能力事实。`dsh-subprocess-local` 报告 `'host-local'`，E2B 子进程提供方报告 `'remote'`。本地 Science 提供方必须先确认该值为 `'host-local'`，才能创建 owner record、目录或会话事件。`SandboxProvider` 不新增重复事实：其现有服务定义已经是共用宿主内核、按宿主路径实施限制的 seam，本地提供方依赖这项约定。子进程描述符可以防止这个使用宿主路径的消费方与远端进程环境错误组合；它不是适用于任意远端提供方组合的通用身份协议。
3. runner spawn、runner fatal 和 denial 分类从 Bash 与 Pwsh 消费方下沉到 `dsh-sandbox` 导出的分类模块。Bash、Pwsh 与 Science 调用同一份实现。这两个 shell 消费方已经保持逐调用镜像；如果只迁移 Bash，就会再次产生这份副本本要防止的漂移。runner failure 的优先级高于 denial，因为它证明请求的解释器根本没有运行；两者都不得报告成普通的 Python/R exception。
4. `SubprocessOutputRead` 新增 `utf8Validity: 'valid' | 'invalid' | 'unknown'`，用于描述该次读取所代表的精确字节切片。任何保留这些字节的提供方，都先根据该切片判定 `valid` 或 `invalid`，之后才执行替换式解码。这包括本地收集器，以及通过 base64 传输恢复原始命令字节后的 E2B。只有已经拿到解码文本且无法恢复字节切片的提供方才报告 `unknown`。现有文本消费方保留当前行为。Science 版本探测与 UTF-8 探测要求从 offset zero 开始的无损读取，且 `utf8Validity === 'valid'`；绝不根据没有出现 U+FFFD 来推断有效性。

Science 提供方只消费公开的 `SubprocessHandle` 操作。它不安装第二套进程级退出监听器，不直接发送进程组信号，也不复制输出收集器。这些机制继续由 [subprocess seam](../../implemented/architecture/2026-07-26-subprocess-seam.md)及其同步退出后备机制负责。

### 运行时约定

服务定义暴露两个异步操作和一个实时结果句柄。从第一版起，每个可由工具触达的操作都要求调用方提供并负责 `AbortSignal`。

| API | 约定 |
|---|---|
| `bindEnvironment({ session, profileId, signal })` | 校验一个已配置的本地 profile，追加恰好一个完整的 `science/environment-bound` 修订，并以已接受的持久值完成 |
| `startRun({ session, language, code, toolCallId, requestHeaderSeq, signal })` | 预约精确且仍存活的会话，重新校验其已应用绑定，准备并发布运行开始事实，然后以句柄完成；发布前失败会拒绝，且不产生运行事件 |
| `ScienceRunHandle` | 只暴露 `runId`、`done: Promise<ScienceRunResult>` 和幂等的 `cancel(): void`；绝不暴露 PID、`SubprocessHandle`、可执行文件路径或宿主暂存路径 |
| `ScienceRunResult` | 以已提交的 `ScienceRunTerminal`、有界的 stdout/stderr 尾部、精确字节总数和截断标志完成；普通程序失败、超时与取消结果均作为值返回 |

`bindEnvironment` 和 `startRun` 发布前的失败会以 `ScienceRuntimeError` 拒绝。误用与能力错误码为 `SESSION_NOT_LIVE`、`SERVICE_DISPOSING`、`RUNTIME_BUSY`、`ENVIRONMENT_NOT_READY`、`CONFINEMENT_UNAVAILABLE` 和 `INVALID_REQUEST`；调用方中止、发布前超过截止时间和提供方失败分别使用 `OPERATION_CANCELLED`、`OPERATION_TIMED_OUT` 和 `INFRASTRUCTURE_FAILURE`。这些失败不追加运行事件。`science/run-started` 提交后，spawn、runner、进程、超时和调用方取消等结果会把 `done` 结算为终态值，并追加 `science/run-finished`。持久的非成功错误码为 `SPAWN_FAILED`、`SANDBOX_RUNNER_FAILED`、`SANDBOX_DENIED`、`DESCENDANT_CLEANUP_REQUIRED`、`PROCESS_SIGNALLED`、`PROCESS_EXIT_NONZERO`、`TIMEOUT` 和 `CANCELLED`。如果无法证明整棵进程树完全停稳，`done` 会以 `QUIESCENCE_UNPROVEN` 拒绝。如果精确会话仍然存活，但无法追加终态事实，则拒绝为 `TERMINAL_COMMIT_FAILED`。如果精确会话已经脱离或被替换，则在完全停稳后以 `SESSION_NOT_LIVE` 拒绝；这是发布后唯一使用 `SESSION_NOT_LIVE` 的情况，且不是 `TERMINAL_COMMIT_FAILED`。运行时绝不向已脱离的对象或同 ID 后继会话追加事件，也不得返回看似已经持久提交的值。

`startRun` 在发布前分配延后生效的 `ScienceRunHandle`，但直到 `science/run-started` 提交后才对外暴露。随后，运行时启动由其负责的结算任务，并以同一句柄完成该操作。同步 spawn 抛错或已经拒绝的进程 promise 可能在调用方看到句柄前就结算 `done`，但由于持久的开始事实已经存在，`startRun` 仍须返回该句柄。结算任务会一直持有精确会话预约，直到终态提交完成或显式的基础设施拒绝发生。如果有界结算无法证明完全停稳，`done` 会拒绝，但会话 ID 隔离会继续保留。后续肯定的静止证明会先构造终态事实并向仍存活的精确会话追加，再释放隔离；已经脱离的生命周期在证明后不追加并释放，而否定或拒绝的证明以及仍存活会话的终态提交失败会继续保留隔离。本地提供方声明对 `sessions`、`subprocess` 和 `sandbox` 的必需 Cordis 注入，使这些服务在终态结算和提供方资源释放期间始终可用。

请求不得选择前缀、可执行文件、运行 ID、目录、环境条目、输出上限、宽限期或超时时间。源码必须是非空、格式正确且不含 U+0000 的 Unicode 字符串；其未经改动的 UTF-8 编码最多为 262,144 字节。提供方不添加 BOM、换行或任何规范化处理。它生成 UUID 形式的 `ScienceRunId`。`codeSha256` 是已刷写到源文件中的精确字节的 SHA-256。`scratchKey` 为 `lowerhex(SHA-256(UTF-8("dsh-science-scratch-v1\0" + language + "\0") || codeBytes))`。

本地提供方只有一套严格的 Cordis 配置：可选的 `dshHome`、必填的 `profiles` 和可选的 `timeoutMs`。`profiles` 是以有效 `ScienceEnvironmentProfileId` 为键的非空记录；每个值至少声明一个绝对路径 `pythonPrefix` 或 `rPrefix`，且不允许未知键。`timeoutMs` 默认值为 120,000，只接受 1 至 600,000 范围内的安全整数。262,144 字节的源码上限、每个流 64,000 字节的保留上限和 3,000 ms 的终止宽限期是固定的协议与安全限制，不是每次调用可选或由模型选择的可调参数。

### 精确会话的职责归属与变更顺序

可变操作的职责归属分为相互配合的两级。`WeakMap` 以精确 `Session` 对象为键保存控制器和句柄，提供方私有 map 则以会话 ID 及其派生会话键为键，维护一项生命周期隔离。绑定与运行准备共用一个不排队的预约。同一精确会话上的第二项操作会在创建运行目录或事件之前返回 `RUNTIME_BUSY`；不同会话 ID 可以并发执行。旧生命周期脱离后，其 ID 隔离会一直保留到由该生命周期负责的全部探测和进程树完全停稳，且所有清理均已结算。同 ID 的后继会话因此必须在接触共享暂存根目录之前返回 `RUNTIME_BUSY`，并且只能在隔离解除后复用该目录。每次追加前还会重新检查 `ctx.sessions.get(session.id) === session`，因此旧生命周期绝不能写入同 ID 的后继会话。

`bindEnvironment` 执行以下事务：

1. 证明精确会话仍存活、已绑定 Science 且没有运行正在执行；取得预约。
2. 解析允许列表中的 profile 及其静态路径，但不创建暂存目录。如果规范 Science 会话根目录与通用平台临时根目录相等、包含后者或被后者包含，则拒绝该目录；这既确保专用暂存目录在 Linux mount profile 下保持可见，也防止沙箱的宽泛临时目录授权将其包含在内。派生未来运行策略的规范可写根目录，并拒绝与其中任一根目录重叠的前缀。
3. 对每个需要版本或 UTF-8 探测的可执行文件，在 Science 会话根目录下规划一个唯一、由提供方负责的观测目录。把该目录作为探测策略的 `workspaceRoot`，策略设为 `workspace-write`；派生该策略的每个规范可写根目录，并拒绝与其中任一根目录相等、包含该根目录或被其包含的规范前缀。先用这个最终策略包装两个精确的直接 argv 值并要求 `enforcement === 'full'`；只有成功后，才能创建或校验 owner marker 与会话根目录、创建私有观测目录，并 spawn 已保留的包装后 argv。探测使用的 `HOME`、`TMPDIR` 与 cwd 都留在这个沙箱可见的目录中。R 会在解释器启动前选择每会话临时目录，而且要求所选路径不含空格，因此，如果 R 观测使用的规范 `tmp/` 路径包含 ASCII 空格，则在 spawn 前以 `CONFINEMENT_UNAVAILABLE` 拒绝。接受观测前，必须等待整棵探测进程树结算，并删除未发布的观测目录。如果变化后的静态事实要求重新规划重试，而其精确 argv 无法取得完整限制，失败操作会在所有同级探测清理结算后，仅删除由本操作首次创建的精确 marker 与会话根目录；操作开始前已存在的归属保持不变。清理失败记为 `INFRASTRUCTURE_FAILURE`。边界不可用、仅部分实施或与前缀重叠时，以 `CONFINEMENT_UNAVAILABLE` 拒绝，且不追加环境事件；如果解释器在静态检查中缺失或不可用，则无需启动进程，仍可生成如实的 `invalid` 观测。
4. 构造一个完整的环境修订。所有已声明解释器均可用时状态为 `applied`；环境观测缺失或不可用时，生成如实的 `invalid` 值，只保留已经取得的事实和有界原因。提供方 I/O、取消、超时或限制失败会直接拒绝，而不会伪造环境事实。
5. 重新检查精确存活性、调用方取消状态和截止时间，追加 `science/environment-bound`，然后在 `finally` 中释放预约。

任何运行发生后，显式绑定都会被拒绝，而不是追加用于替换的 `applied` 环境。运行预检会重新观测选中的绑定。观测完全相同时不追加事件；观测无效或发生变化时，追加一个连续的 `invalid` 或 `drifted` 环境修订，并在创建运行目录或开始事件之前拒绝该运行。

`startRun` 执行以下事务：

1. 预约精确且仍存活的会话，并严格回放其中已经通过准入的 Science 事件。要求最新环境为 `applied`，且请求语言的绑定为 `available`。
2. 重新观测该精确绑定。发生漂移时，按上述环境路径处理并阻止执行。
3. 生成运行 ID 和计划使用的私有路径，派生源码哈希，并构造固定的解释器 argv、干净环境与 `stdio` 策略，但不创建运行目录。Stdin 始终为 `'ignore'`，本地使用 `/dev/null`；stdout 与 stderr 分别使用有界收集器。
4. 派生固定 Science `workspace-write` 策略的规范可写根目录。当规范 Conda 前缀与任一可写根目录相等、包含该根目录，或被该根目录包含时，必须拒绝请求；否则，用户代码即使处于完整限制之下也能修改环境。请求 `ctx.sandbox` 限制计划使用的 argv，并要求 `enforcement === 'full'`。已知不可用、仅部分实施或存在重叠的边界会在创建运行文件或发布开始事实前被拒绝。包装过程可以探测 runner，但不会执行请求的源码。
5. 创建私有运行目录，以 `0600` 模式写入精确源码并刷写文件，分配延后生效的句柄，然后重新检查精确存活性、调用方取消状态和截止时间。追加 `science/run-started`；只有追加成功后才暴露句柄。调用 `ctx.subprocess.spawn` 前立即重新检查 first-cause 控制器：如果开始事实发布后已经锁定原因，则跳过 spawn，并把运行结算为 `cancelled` 或 `timed-out`。开始前追加被拒绝时，删除未发布的运行目录。从此处开始的同步或异步 spawn 失败是终态失败运行，而不是被遗弃的开始事实。
6. 运行时负责的后台任务在等待直接进程结算期间持续持有预约，最多允许后代进程在已配置的 3,000 ms 宽限期内退出；如果进程树仍然存活，则调用唯一的 `terminate()` 操作，然后等待 `waitForExit()`，直到整棵受管进程树退出。任务按第一个已锁定且归运行时负责的原因完成分类，从 offset zero 读取两个已收集的尾部，追加完整终态事件，之后才释放会话预约。父进程退出后仍需终止进程树的运行不得报告为 `success`。

终态分类首先采用最早锁定且归运行时负责的原因：超过截止时间会成为 `timed-out`，调用方信号、`cancel()` 或正常服务资源释放会成为 `cancelled`。如果没有锁定此类原因，沙箱 runner failure 的优先级高于沙箱 denial；随后，spawn failure、强制清理后代进程、信号导致的死亡或非零退出都会成为 `failed`，零值退出则成为 `success`。安全的失败错误码会持久化，原始错误与输出只属于运行结果数据。stdout 与 stderr 分别收集且不生成 spill 文件，各自最多保留 64,000 字节；`nextOffset` 提供精确的总字节数，`lossy` 提供截断事实。

运行时不重复实现领域层对待处理工具调用、请求标头、修订或状态转换的规则。它构造完整的类型化候选值，并交由现有 Science 不变式与严格折叠在 `Session.append()` 时决定是否准入。如果开始前的追加被拒绝，运行时只删除该操作新建且尚未发布的运行目录，并拒绝请求；它绝不 spawn。这样，状态转换语义继续留在 `science-session`，运行时只负责外部事实的顺序与回滚。

### 取消、资源释放与已脱离的会话

提供方通过同一个 first-cause 控制器关联必填的调用方信号、固定超时、显式句柄取消和服务资源释放。超时默认值为 120,000 ms，配置只能在 1–600,000 ms 范围内降低或提高该值。子进程宽限期固定为 3,000 ms。运行发布后的取消会调用 `SubprocessHandle.terminate()`，并且仍须等待 `done` 和整棵进程树退出，之后才追加 `cancelled`。

服务资源释放会先拒绝新工作，再取消每项由提供方负责的探测和运行，等待每棵受管进程树退出并完成终态追加，之后才返回。依赖顺序保证该消费方完全停稳前，子进程与沙箱提供方仍然存活。相互独立的清理结果使用 `Promise.allSettled`；一个目标失败不得让另一个目标得不到清理机会。

`session/disposed` 只用于观测，而且存储在脱离会话前不能等待该事件。因此，意外脱离会触发清理，但禁止随后向已脱离的对象或同 ID 后继会话追加任何事件。受管进程树完全停稳后，`done` 按运行时约定以 `SESSION_NOT_LIVE` 拒绝；如果持久日志包含没有匹配结束事实的开始事实，冷回放会派生 `interrupted`，其依据是 `session/end-seed`。Phase 3 的正常拆卸必须先取消并等待运行时操作，再脱离会话。本记录不声称任意脱离都能记录 `cancelled`。

### Conda 观测与不可变前缀的使用

profile 是从 `ScienceEnvironmentProfileId` 到至少包含 `pythonPrefix` 或 `rPrefix` 之一的配置 map。提供方绝不调用 `conda` CLI。它对配置的前缀执行规范化，要求规范目录树中存在常规文件 `conda-meta/history`，并且只使用固定的可执行文件候选项：POSIX 上为 `bin/python` 和 `bin/Rscript`，Windows 上为 `python.exe` 和 `Scripts/Rscript.exe`。可执行文件必须是常规可执行文件，且其规范路径始终位于前缀内。当前 Windows 沙箱只实施部分限制，因此凡是需要可执行文件探测的观测以及每次 Science 运行都会以 `CONFINEMENT_UNAVAILABLE` 失败；在完整后端可用之前，两者都不发布相应的环境事件或运行事件。静态检查中缺失或不可用的解释器不会启动进程，因此仍可发布上文所述、如实的 `invalid` 观测。

Python 版本探测使用 `python -I -B -X utf8 --version`；运行使用 `python -I -B -u -X utf8 <code.py>`。`-I` 有意忽略全部 `PYTHON*` 环境条目，`-B` 防止写入字节码，`-u` 让运行输出立即可见，`-X utf8` 固定源码与文本 I/O 编码。R 版本探测使用 `Rscript --vanilla --encoding=UTF-8 --version`；运行使用 `Rscript --vanilla --encoding=UTF-8 <code.R>`。`--vanilla` 忽略用户与站点启动文件，因此不提供 `R_ENVIRON_USER` 或 `R_PROFILE_USER` 条目。在支持的 POSIX 宿主上，两种语言都接收由提供方固定的 `LANG` 和 `LC_ALL`：Linux 上为 `C.UTF-8`，Darwin 上为 `en_US.UTF-8`，另加 `TZ=UTC`。同一个专用 `workspace-write` 观测策略下的第二项固定直接 argv 探测使用 `python -I -B -X utf8 -c 'import sys;sys.stdout.buffer.write("dsh-科学-✓".encode("utf-8"))'` 或 `Rscript --vanilla --encoding=UTF-8 -e 'cat(enc2utf8("dsh-科学-✓"),sep="")'`。绑定不得标记为 `available`，除非该探测以零值退出、stdout 精确等于 `dsh-科学-✓` 的 UTF-8 字节且 stderr 为空。

每个流最多捕获 1,024 字节的版本输出。系统要求从 offset zero 开始无损读取，且通用输出事实为 `utf8Validity === 'valid'`；随后将 CRLF 转换为 LF，移除首尾 ASCII 空白，拒绝 U+0000，并且要求 stdout 恰好包含一个非空行；只有 stdout 为空时，才允许 stderr 恰好包含一个非空行。任何其他形式都是无效观测。观测过程通过 `fs.stat({ bigint: true })` 读取可执行文件身份，对 `conda-meta/history` 的精确字节计算哈希，在专用观测暂存目录内完整实施限制并执行两项探测，然后重复文件系统观测。如果观测变化一次，则重试一次；第二次仍然变化时，记录无效的不稳定观测，而不是伪造指纹。

`executableIdentity` 是 UTF-8 字符串 `stat-v1\0<platform>\0<dev>\0<ino>\0<mode>\0<size>\0<mtimeNs>\0<ctimeNs>`。每个数值字段都是不含填充的十进制整数；`dev`、`ino`、`mode` 和 `size` 必须为非负数，时间戳则保留其符号。全部值来自同一次 bigint stat。`bindingFingerprint` 为 `lowerhex(SHA-256(UTF-8("dsh-science-binding-v1\0" + language + "\0" + canonicalPrefix + "\0" + executable + "\0" + executableIdentity + "\0" + languageVersion + "\0" + condaHistorySha256)))`。该指纹用于检测已捕获身份是否变化；它不是包锁，也不能证明环境中的每个文件均未改变。

### 暂存目录布局与干净的子进程环境

提供方只通过 `resolveDshHome(config.dshHome)` 解析其根目录。创建任何内容前，如果派生的 Science 根目录与规范的 `/tmp` 或 `os.tmpdir()` 根目录在任一方向上重叠，则拒绝该目录。会话键仍为 `lowerhex(SHA-256(UTF-8("dsh-science-session-v1\0" + exactSessionId)))`。安全标记 `science/v1/owners/<session-key>.json` 精确包含 `{ version: 1, key, sessionId }`，模式为 `0600`；首次创建时使用排他式 `open('wx')`、精确的 UTF-8 JSON、文件同步和父目录同步。只有独占标记创建成功的物化操作才取得回滚归属；并发的精确复用者不会取得。`science/v1/sessions/<session-key>/` 及其 `home/`、`state/`、`runs/` 和 `probes/` 目录均使用 `0700` 模式。检查现有标记、目录和源文件时，不跟随非预期符号链接。如果取得归属的物化操作失败，它会校验精确的标记字节，并且只删除本次新建的会话根目录与标记；并发或既有归属绝不会被删除。仅有有效且精确匹配的标记、但尚无会话根目录时，属于可恢复的崩溃残留，只允许该精确会话创建根目录。现有会话根目录旁缺少标记、标记格式错误或不匹配、受管文件并非私有，或路径发生逃逸时，系统均快速失败并保持关闭状态。

每次运行的专用内容包括 `runs/<run-id>/code.py` 或 `code.R`、`tmp/` 和 `artifacts/`。其 cwd 为该运行目录。源文件及其所在的运行目录会在开始事件前完成同步。开始前回滚只能删除新创建且尚未发布的运行目录；清理失败会与发起清理的失败合并报告，不得隐藏。成功、失败、取消、恢复、会话资源释放和服务资源释放后的运行均保留暂存数据。提供方绝不删除或写入已配置的 Conda 前缀。owner marker 是冲突防护标记，不是第二份事件日志或投影数据库。

每次观测的专用内容包括 `probes/<observation-id>/home/`、`tmp/`，以及用作 cwd 的观测目录。这些内容属于未发布的提供方准备工作，不是已接受的用户状态。只有每个探测进程完全停稳后，提供方才删除该次观测目录；删除失败会拒绝绑定或预检，并阻止发布环境事件或运行事件。它绝不删除 `home/`、`state/`、已接受的运行目录或其他生命周期的探测目录。

Science 运行进程设置 `environmentBase: 'empty'`，并且只提供 `HOME`、`TMPDIR`、`PATH`、`SCIENCE_STATE_DIR`、`SCIENCE_ARTIFACT_DIR`、`LANG`、`LC_ALL` 和 `TZ`，这些值均按上文要求固定或由提供方派生。在支持的 POSIX 宿主上，`PATH` 精确为 `<canonical-prefix>/bin:/usr/bin:/bin`；它绝不来自环境输入。Python 行为由 argv 固定，而不是依靠会被忽略的 `PYTHON*` 条目；R 不接收用户 profile、环境文件或库路径条目。探测使用相同的空基础环境，但只包含 `HOME`、`TMPDIR`、`PATH`、`LANG`、`LC_ALL` 和 `TZ`；`HOME`、`TMPDIR` 与 cwd 都位于唯一观测目录内。R 运行同样把 `TMPDIR` 指向该运行专用的 `tmp/`；如果其规范路径包含 ASCII 空格，则在发布前拒绝。系统不转发形似凭据的变量、代理变量、`SSH_AUTH_SOCK`、用户包路径、环境中的 `DSH_*` 或调用方提供的条目。

运行限制始终使用 `workspace-write`，其中 `workspaceRoot` 等于规范的 Science 会话根目录，`sessionId` 等于精确会话 ID。它绝不使用项目 cwd 或由 agent 选择的策略。在包装前，提供方调用沙箱责任方的 `writableRoots(policy)`，并以可识别路径边界的规范路径比较，拒绝在任一方向上与可写根目录重叠的任何已配置前缀。通用沙箱还允许使用其已记录的平台临时根目录；运行时把 `TMPDIR` 指向专用运行目录，并且只接受来自相应专用目录的持久 Science 状态或产物。限制机制控制文件写入，但不控制读取、网络、系统调用或科学有效性。

探测限制同样使用 `workspace-write`，但其 `workspaceRoot` 是唯一的观测目录，而不是整个会话根目录。同一项规范重叠检查覆盖该精确策略返回的每个可写根目录，包括通用平台临时根目录。探测写入权限仅用于满足解释器启动要求，例如 R 的每会话临时目录；它绝不授权写入 Conda 前缀。

### 文件与测试结构

保持职责聚焦和高内聚。折叠后的包把 public type 和精简 entrypoint 与严格 configuration、environment observation、private scratch、direct execution 和 lifecycle ownership 分开；当不存在独立的 event/data relation 时，`./invariant` 配套模块给出包专用的空原因。模块拆分由独立职责、耦合方向或可审查性决定，而不是机械满足行数。测试文件按一个行为族组织，只有独立 fixture 或 lifecycle concern 会遮蔽该行为时才拆分。

使用虚拟前缀的 CI 覆盖以下场景：严格的 profile 配置；仅 Python、仅 R、共享前缀及不同前缀；路径缺失或逃逸；稳定与变化的指纹；精确序列化和版本归一化；owner marker 恢复／fork／冲突；精确模式；包含空格和元字符的直接 argv 路径；非 ASCII 源码／输出；由保留字节得到的 UTF-8 `valid`／`invalid` 事实，以及仅在不存在字节切片时出现的 `unknown`；空基础环境捕获；完整实施限制的专用探测暂存目录及其清理；拒绝 Science 根目录与临时根目录重叠、拒绝前缀与可写根目录重叠；runner／denial 分类；先开始后 spawn、进程树退出后才结束的顺序；输出字节边界；超时／取消／TERM-trap 升级；精确会话并发；清理前的同 ID 生命周期隔离与完全停稳后的安全复用；资源释放达到完全停稳；前缀变更前后 manifest；以及严格冷回放。E2B 在恢复原始字节后的读取报告 `valid` 或 `invalid`；不得仅因进程环境位于远端就报告 `unknown`。Python 以包含空格的非临时 Science 根目录作为正例；R 覆盖普通的无空格暂存目录，以及包含空格的 `TMPDIR` 快速失败 fixture。用于实际受限探测或运行的虚拟前缀与隔离的 `DSH_HOME` 都位于测试负责的非临时根目录下，既不与沙箱临时根目录重叠，也不相互重叠；`/tmp` 中的虚拟前缀或 `DSH_HOME` 只用于重叠的反例 fixture。至少一个 Loader 组合使用真实的 `SessionStore`、Science invariant、本地子进程、本地沙箱、折叠后的 Runtime 包和虚拟解释器；只使用 mock 无法证明运行时操作。这些测试并不使 Science seam 完整。

真实机器验收需要显式启用，并接收显式的 Python 与 R 前缀，以及隔离、由测试负责且非临时的 `DSH_HOME`。它会分别运行每个被选择的语言，验证规范 executable/version/history identity、非 ASCII source/output、环境清理、owned cwd/directory、success、cancellation、timeout、full confinement、prefix-write denial 与 terminal settlement。前后递归 prefix manifest 使用 `lstat` 且不跟随 symlink，并记录相对路径、类型、symlink target、mode、size、mtime nanoseconds、ctime nanoseconds 和 regular-file SHA-256；它有意排除 atime，因为观测本身可能更新该值。只有空 diff 才能支持“prefix unchanged”的结论。Python 与 R 分别报告 `PASS`、`FAIL` 或 `NOT-RUN`。虚拟前缀测试不能证明真实 Conda，源码验收也不能证明已安装应用或发布版本。

## 曾考虑的替代方案

**在 Science 内使用 `node:child_process` spawn。** 不予采纳，因为这会重复已经归 `ctx.subprocess` 负责的受管进程树身份、TERM-to-KILL 升级、输出上限、宿主退出后备机制与提供方可移植性。

**使用 `dsh-shell` 或构造 shell 命令。** 不予采纳，因为解释器、源码与路径是结构化事实。shell 只会增加 quoting 与启动行为，不会提供任何必需的产品语义。

**把 Science 实现为 `ctx.codeRuntime` 的 Python 后端。** 不予采纳，因为 Code Mode 向一个模型程序暴露宿主绑定和可移植 SDK，而 Science 记录 Conda 身份、会话来源、文件以及相互独立的 Python/R 运行。合并两者会耦合无关的消费方与持久语义。

**让工具围绕低层提供方追加 Science 事件。** 不予采纳，因为每个消费方都必须重复实现禁止先 spawn 后记录开始事实的规则、漂移修订、精确会话租约、完全停稳后结束和脱离行为。负责观测或执行事实的操作应负责追加相应事件。

**保留当前已清理的环境基础。** 不予采纳，因为 `PATH`、`HOME`、locale、代理和其他非凭据变量仍会保留；“按凭据形式清理”并不等同于承诺的显式允许列表。在 Science 中枚举环境变量 tombstone 会与环境变更发生竞态，并重复平台键语义，因此子进程 seam 新增显式的空基础环境。

**把会话项目 cwd 用作沙箱工作区。** 不予采纳，因为 Science 代码只能写入其专用暂存目录，以及沙箱声明的临时根目录，不能写入用户项目。在当前威胁模型下，项目文件仍可能被读取。

**允许沙箱仅实施部分限制并显示警告。** 不予采纳，因为只有后端完整实施文件影响承诺时，可写根目录之外的环境前缀才能视为只读。Phase 2 会快速失败并报告宿主不受支持。

**创建、克隆、更新或修复 Conda 环境。** 不予采纳，因为包求解、审批、锁、变更回滚和清理属于另一项能力。Phase 2 只观测并执行已配置的现有前缀。

**在成功或资源释放时删除暂存目录。** 不予采纳，因为显式的 `state/` 与运行文件是 MVP 跨调用状态和诊断证据。清理过程负责进程和未发布的准备内容，不负责删除已接受的用户数据。

**把发布后每一次失败的终态追加都记为 `TERMINAL_COMMIT_FAILED`，包括意外脱离。** 不予采纳，因为仍然存活的会话在追加被拒绝时仍可写入，需要基础设施失败；已脱离的会话不得再写入，并通过回放派生的 `interrupted` 恢复。

**把发布后每一次失败的终态追加都记为 `SESSION_NOT_LIVE`。** 不予采纳，因为仍然存活的精确会话上的 fold、I/O 或不变式拒绝并不是存活性失败。

**因为 SDK 回调是文本，就把 E2B 输出报告为 `utf8Validity: 'unknown'`。** 不予采纳，因为 E2B 提供方已经通过 base64 传输恢复原始命令字节，因此拥有与本地收集器相同的字节切片。

**让 Pwsh 继续使用其复制的分类器，只让 Bash 与 Science 共享沙箱模块。** 不予采纳，因为 Bash 与 Pwsh 已经保持逐调用镜像。只迁移 Bash 会再次产生这份副本本要防止的漂移。

**在 Phase 2 把提供方无关的 `dsh-science-runtime` 与 `dsh-science-runtime-local` 拆开，并让测试消费方补全 seam。** 不予采纳，因为[能力 seam 规则](../../implemented/architecture/2026-06-13-capability-seams.md)禁止预先拆分：只有一个可设想的提供方、且没有生产消费方时，应留在同一个包中。测试消费方不是生产责任方，不能证明 Definition／提供方需要独立演进。

**把 Phase 3 工具提前到 Phase 2，以便两包拆分拥有生产消费方。** 不予采纳，因为工具面向模型，需要 Science preset，并依赖 Core 的同一次请求压缩修复。那部分工作仍属于 Phase 3。折叠后的包让操作 API 不含仅属于本地实现的类型，因此这些工具稍后可以注入 `ctx.scienceRuntime`。

## 验证

折叠包具有聚焦的虚拟前缀覆盖：严格配置、Python-only/R-only/shared/distinct profile、静态无效路径、保留字节的有效和无效 UTF-8、prefix drift、direct argv、精确空环境、有界输出和严格 live/cold replay。scratch 覆盖检查 owner-marker 配对、私有 mode 路径、source byte、symlink 拒绝和 probe cleanup。lifecycle 覆盖检查取消、超时、service disposal、detached Session、同 ID quarantine、runner 与 denial 优先级、spawn error 和 terminal-commit rejection。

一个 Loader composition 使用真实的 Session store、Science invariant、local subprocess provider、local sandbox provider、折叠 Runtime 和虚拟 prefix。只用 lstat 的 prefix manifest 证明虚拟 prefix 未被修改。opt-in real runner 为 Python 与 R 分别生成 `PASS`、`FAIL` 或 `NOT-RUN` record，绝不把虚拟前缀 evidence 提升为真实机器 evidence。

通用空环境、execution-world、保留字节 UTF-8 validity 与共享 sandbox classification 变更具有聚焦的 provider 和 Consumer 覆盖。现有 Consumer 显式声明其 scrubbed-parent environment base；E2B 保留字节读取报告 `valid` 或 `invalid`。

## 后果

主要正确性风险仍包括：Session 在 process settlement 与 terminal append 之间 detached、prefix 在 observation 期间不稳定变化、sandbox runner failure 看起来像 program failure，以及 teardown 在 descendant 退出前释放 lease。每个 commit 的 exact-object check、有界稳定 observation、同一分类器与 provider-observable quiescence 会约束这些竞态，但不宣称任意 Host race 都会消失。

sandbox 不是 confidentiality boundary。成功的 Science run 可能读取项目或用户文件并使用 network，通用平台 temp root 仍然可写。full file-write enforcement 不宣称 read 或 network isolation。

environment fingerprint 是 observation，不是可复现 environment lock。`conda-meta/history` 与 executable stat tuple 之外的文件可以变化而不改变 fingerprint。前后 manifest 只支持更窄的结论：被选择的 Runtime operation 未改变配置的 prefix；它不是 durable Session payload。

必需的通用迁移影响既有 provider 和 Consumer，因此它们的聚焦 type 与 behavior 覆盖仍是 Runtime 的回归证据。意外 Session disposal 无法同步等待 cleanup 或保证 terminal append；runtime 清理 owned work、不写入 detached log，并由 replay 从未匹配的 durable start 派生 `interrupted`。
