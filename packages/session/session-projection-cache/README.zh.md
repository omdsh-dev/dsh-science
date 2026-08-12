# @deepseek-ai/dsh-session-projection-cache

[English](README.md) | 中文

持久投影缓存（`ctx.sessionProjectionCache`）：把每个已注册投影单元的状态持久化为检查点，基于域数据形态（domain data form）每会话一条记录（`session_projcache` 域——出厂 JSON 后端将其落在配置的存储根目录下、`workspace.json` 旁边）。设计权威：[session-projection RFC](../../../.agents/notes/proposed/architecture/2026-07-27-session-projection-and-command-log.md)（persisted projection cache 一节）。

一条存储行 `(key → {ver, seq, val})` 是折叠捷径，绝不是权威。它可能陈旧（`seq` 精确说明陈旧到哪）、版本不兼容、schema-invalid 或 non-canonical；只有当前运行单元准入的行才能播种 fold。语义完整性假设存储记录由本缓存写端原子产出——单元 schema 能拒绝畸形状态，却不能认证一个结构合法但伪造的行。实现据此承诺：

- **每次自动写入都 fail-soft。** 持久写失败只记一条警告，并保持上一份由本写端产出的缓存切面陈旧。live session 保留脏状态供下个间隔重试；detach 写失败会保留那个精确生命周期，供间隔或 cold-read 重试。如果日志 revision 已经越过这份陈旧切面，该记录会成为 cache miss，cold path 将执行完整回放。
- **`ver` 与当前运行单元的 `stateVersion` 不匹配即丢弃，绝不迁移。** 单元递增版本会在读取时使其行失效；该 key 从日志重新折叠。
- **单元自有的 `checkpointStateSchema` 拒绝无效私有状态。** 注册表在每个持久状态读取面调用它。被拒的行不会出现在零 I/O 列表中，并会让冷读退回完整回放；live 路径不承担这项校验成本。
- **整记录写入。** 每次写入替换该会话的完整检查点（注册表切面始终是完整的），并经无损 JSON 边界快照——违反纯 JSON 约定的单元状态会显式失败并报错。
- **记录绑定到持久日志 revision，而不只是 id。** 每条记录存储它所跟随的精确日志之 source-qualified persistence revision；列表与冷读用自己已经持有的 persistence observation 比对。即使 header 字段碰撞，重建 id 或替换 persistence store 也会改变这项绑定。
- **日志领先，缓存跟随。** 同一会话 id 的完整 checkpoint 事务串行执行。每个事务在前序事务结束后取得切面，等待精确的活动或退役中 Session 生命周期完成持久化 drain，再落地缓存行。因此崩溃可能留下 revision 不匹配、读取时会被丢弃的缓存切面，但绝不会让缓存切面领先于日志；较旧的阻塞写入也不能覆盖较新的切面。

## 写策略

两个必写点，其间节流：

| 触发 | 性质 |
|---|---|
| `turn/end` | 必写——冷读要的正是轮次终值。 |
| 会话释放（detach） | 必写——live 转 cold 的时刻；此后冷读阶梯接管该会话。 |
| 累计 `writeEveryEvents` 个已提交事件 | 配置节流（条数）。 |
| 距首个脏事件 `writeIntervalMs` 毫秒 | 配置节流（间隔）。 |

两个 `Config` 字段均必填（无默认值）：写入节奏是部署选择，没有普适正确值，由 cordis.yml 明示。

## 列表读（`cachedSnapshot(snapshot)`）

零 I/O 一档：从 revision 匹配的存储记录直接 view 全量值（仅版本及 checkpoint schema 均匹配的 key），且只有全部已服务行共享同一精确水位时才返回。这个共同水位就是 `asOfSeq`；客户端按 higher-seq-wins 播种值存储时，较旧列表块不会覆盖更新的推送帧。无可用记录（未知 id、无关日志 revision、没有已准入行或行水位不一致）时返回 `undefined`；api-proxy 列表载体将其转为列缺席。

## 冷读（`coldSnapshot(id, signal?)`）

当 checkpoint revision 仍与尾部读取的 revision 相等时，读取阶梯无需加载全量日志：缓存行 → `sessionProjections.restoreFloor`（最低已准入水位，也就是首条仍需 apply 的事件之前一个位置）→ 持久化 `readFrom(id, floor)` → `sessionProjections.restore` → 刷新行的 fail-soft 写回。私有状态被拒、revision 变化或行越过日志末尾时，系统会从 seq 0 执行恰好一次权威读取，而不会服务来自未证明前缀的值；这也覆盖崩溃修复后缩短的日志。无已注册单元时仍会执行一次持久化探测，以维持 `not found` 语义并为无事件日志确定空切面，随后服务 `{asOfSeq: -1, values: {}}`。

`write(session)` 会排入两个必写点共用的串行 checkpoint 事务；载体可以直接调用（非 fail-soft——由 fail-soft 包装层负责遏制）。空闲 id 的第一个事务立即取得切面；排队事务只在前序事务结束后取得切面，因此不会在更晚时刻发布较旧快照。

## 组合

```yaml
- id: session-projection-cache
  name: '@deepseek-ai/dsh-session-projection-cache'
  config:
    writeEveryEvents: 200
    writeIntervalMs: 5000
```

注入 `storageDomain`、`sessionProjections`、`sessionPersistence`、`sessions`。没有这一行时，投影系统只跑 live（水位缓存；冷读在实现了它的载体处退回全量日志加载）。

## 模型体验

无，因为缓存只持久化并恢复 host 侧的、由已写入日志的会话状态派生的读模型，不触碰任何提示词、消息、schema、流或工具结果。

#### KV Cache 影响

无；缓存从不组装或发送提供方请求。

## 已知局限与延后工作

- **不提供淘汰或保留接口**：记录会按会话持续累积；清理已存储的检查点属于带外维护，与会话持久化采用相同策略。
- **间隔节流采用按会话的粗粒度控制**：一次无脏数据的写入完成后，计时器会在首个脏事件到达时启动；对于持续但未达到条数阈值的事件流，系统每个间隔写入一次，而不采用滑动窗口。
- **`coldSnapshot` 读取串行但不去重**——同一会话的两个并发冷读会依次各跑一遍阶梯；其缓存写回不能越过活动 checkpoint 事务，但重复读取仍会重复持久化工作。
