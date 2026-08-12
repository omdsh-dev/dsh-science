# @deepseek-ai/dsh-session-projection

[English](README.md) | 中文

会话投影 Service Definition 与驱动注册表。它拥有 `ctx.sessionProjections`：该注册表在已提交的会话事件上驱动每个已注册的投影单元，并向载体提供完整的最终值，目前包括 api-proxy 历史尾页和 `session/projection` 推送帧。领域注册的只是纯数学；驱动权归框架。[session-projection RFC](../../../.agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.md) 记录了设计理由。

## 服务：`SessionProjectionRegistry`（ctx 键：`sessionProjections`）

### 公开 API

- `ctx.sessionProjections.register(definition): () => void` 注册一个领域单元。重复组合只有在 key、模块私有 `definitionToken` 与 `stateVersion` 全部相同时，才共享同一 canonical definition 及其 cell；其他 active owner 一律冲突。Cordis HMR 期间，全部旧 owner 已进入 unloading 后，新 fiber 才可接管；token 或版本变化都会从日志重建 cell。最后一个 live disposer 会移除 key 与 cell——客户端将其读作能力缺失。
- `ctx.sessionProjections.onChanged(listener): () => void` 订阅变更流：每个已提交事件、每个公开 view 发生变化的单元各回调一次，携带经 schema 校验的 view 与致因 seq。与 `register` 一样绑定 effect；listener 的同步 throw 与异步 rejection 都会被记录并隔离，使后续订阅者仍能运行。
- `ctx.sessionProjections.snapshot(session): ProjectionSnapshot` 对全部已注册单元做一次一致的同步切面——`{ asOfSeq, values }`，其中 `asOfSeq` = 所有值共同反映到的最后一个事件的 seq（空日志为 `-1`）。
- `checkpoint(session)`、`restoreFloor(checkpoint)`、`viewCheckpoint(checkpoint)` 与 `restore(checkpoint, events, baseSeq)` 构成持久缓存边界。注册表先用单元自有的 checkpoint schema 与可选的“私有状态到外层水位”绑定校验缓存行，再查看或正向 apply；被拒的行不可用，必须完整回放。

### 关键类型

- `SessionProjectionMap`——整条链路唯一的 merge-extensible 类型表（host 侧单元、协议块、React 钩子）。值是协议层 JSON 全量值；渲染归 slot 体系管，永远不归本层。
- `ProjectionDefinition<K, S>`——`{ key, definitionToken, schema, checkpointStateSchema?, checkpointStateSeq?, init(), apply(state, event), view(state), viewChanged?, stateVersion }`：由三个纯同步函数外加声明构成的状态驱动计算单元，绝不是不透明 getter。`key` 是非空的 wire identifier；其他所有 JSON-safe string，包括字面量 `__proto__`，都保持合法。一个模块私有 `Symbol()` token 标识精确、可互换的 definition family；不得使用 `Symbol.for()`，也不得把同一 token 用于带实例配置的不同语义。`checkpointStateSchema` 只准入 canonical 的持久私有状态，不负责迁移；`checkpointStateSeq` 把自带水位的私有状态绑定到缓存行外层 `seq`；`viewChanged` 可区分私有回放推进与公开值变化。

## 约定

- **框架负责驱动，领域负责计算。** 注册表只订阅一次 `session/event`；每个已提交事件都会主动经过每个单元的 `apply`。领域不持有任何订阅。drive 分两阶段：所有成功单元先提交该事件与 watermark，随后才运行任何公开 view 或 change listener，因此重入 snapshot 不会看到只 apply 一半的 registry cut。cell（每会话每单元一份 `{state, observedSeq}`，以 WeakMap 为键）惰性构建——在事件流过之后才注册的单元，或读取一个早于该注册的会话，都在首次触达时从 `init` 出发在内存日志上折叠。
- **私有推进与公开变化分离。** 若公开值和私有 checkpoint 证明都未推进，单元应返回同一个状态引用。驱动会先提交成功的 `apply` 结果及其水位，再用 `Object.is` 与可选的 `viewChanged` 筛选通知。predicate 或公开 view 抛错时，私有折叠已经推进；错误会被记录并隔离，一个单元失败不会饿死后续单元。
- **全量值事件规则（承重）。** 携带状态的日志事件必须携带变更后的完整状态，绝不携带裸增量——这让该次状态转移保持廉价，也让每个被供给的值自描述（对消费方即 last-wins）。事实/provenance 领域可以改为拥有严格的多事件折叠及其转移成本。
- **单元的同步纪律。**`init`/`apply`/`view` 必须是同步的；载体在切出页面切片的同一 tick 内读取 `snapshot()`，`asOfSeq` 之所以是一个一致切面正系于此。误写成异步的 `view` 会返回 Promise，让边界的 `schema.parse` 当场大声失败。
- **所有公开值与持久值都是隔离的纯 JSON。** 注册表在公开 schema 校验前后都复制值，并给每个 listener 单独副本；identity view 或会原地修改输入的 schema transform 因此无法取得或污染 live cell。非 JSON 的公开值或 checkpoint 状态会在边界大声失败。
- **`stateVersion` 负责失效，schema 不负责迁移。** 持久缓存存储 `(sessionId, key, ver, seq, val)` 行。状态形状或折叠语义变化时必须递增 `stateVersion`。`checkpointStateSchema` 只在持久状态读取边界运行，输出必须与输入 JSON 深度相等；default、strip 或变换出不同值都会拒绝该行。provenance 较重的单元还应提供 `checkpointStateSeq`，避免合法旧状态被拼到较新的外层水位下。
- **自带水位的单元必须逐事件推进私有状态。**`checkpointStateSeq` 是纯 extractor；写出缓存行（`checkpoint`、刷新后的 `restore`）与准入缓存行（`restoreFloor`、`viewCheckpoint`、`restore`）时都会调用它。这类单元即使遇到领域无关事件，也必须把最新 committed seq 编入私有状态，因此每次返回新私有状态，并用 `viewChanged` 抑制相同公开值。未提供该 hook 的单元仍走同引用快路径。
- **本层没有协议词汇。** 注册表只暴露变更流与快照读取面；载体（api-proxy）据此自铸各自的帧（`session/projection`）与块。
- **可选能力。** 领域插件在 `ctx.inject(['sessionProjections'], …)` 下注册，因此不带注册表的 headless 组装完全不受影响；载体使用 `ctx.get('sessionProjections')`，注册表缺席时完全省略自己的块与帧。

## 职责

本包承担能力 seam 的 Service Definition、live 驱动与持久缓存准入角色：领域 host 插件（如 `dsh-tool-todo`）贡献单元，并拥有自身状态数学与 schema；载体（`dsh-host-apiproxy`）消费快照与变更流。两侧互不相识。

实现文件也遵循同一职责拆分：`definition.ts` 拥有契约，`registration.ts` 拥有 fiber/HMR 仲裁，`checkpoint.ts` 拥有 JSON 隔离与持久行准入，`index.ts` 只编排服务和事件驱动。

## 模型体验

无——注册表只对已入日志的会话状态计算面向客户端的读模型，不触碰任何提示词、消息、schema、流或工具结果。

#### KV Cache 影响

无；投影从不组装或发送提供方请求。

## 已知限制与暂缓事项

- **每个尾页携带每个已注册的 key**——尚无逐 key 的 opt-out 或惰性 key 请求形状；在值都是 UI 量级的全量状态（一张 todo 清单、一份 goal 快照）时可以接受，若某领域的值变大再重议。
- **单元表是进程级的，因此 key 是否存在不能当作逐会话的能力信号**——只要**任何**一个 agent preset 注册了某个 key，它就出现在每个会话的快照里，包括自身组装完全不产出该值的会话。客户端必须读**值**（`plan.active`、空的 todo 列表），不能把 key 缺席当作功能缺席；如果某个单元的空值与真实值无法区分，它就该待在宿主平面——`dsh-token-meter` 正因如此留在那里。
- **主动驱动（eager drive）逐事件触达每个单元**——同引用与 `viewChanged` 闸门能避免无用的下游工作，但转移成本仍由单元承担。私有状态随历史增长的单元仍可能复制保留数组；广泛组装前必须量测。若出现热点路径，可加按单元的事件类型预过滤，约定不变。
- **注册表 cell 只活在内存里**——重启后首次触达时靠折叠日志重建；挂载了 `dsh-session-projection-cache` 的组合改由持久行播种该折叠。
- **单元同步纪律只有部分可机械把关**——边界 `schema.parse` 能拒绝返回 Promise 的 `view`，但阻塞的 `apply`、或读取撕裂的非会话状态的 `apply`，只能靠评审把关；invariant 配套项记载了为何不存在运行时检查。
