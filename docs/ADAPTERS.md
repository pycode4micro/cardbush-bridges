# 增加一个桥适配器

在 `src/adapters/<id>/` 实现平台 API、授权、来信标准化与发送逻辑，在 `src/registry.mjs` 增加一个描述对象。通用 HTTP 协议无需更改，Cardbush 源码也无需更改。

描述对象包含：

- `id`：稳定的平台标识，作为私有数据子目录名。
- `name`、`serviceName`：终端名称及 Cardbush 连接列表名称。
- `port`：独立的默认本机回复端口，避免与已有平台冲突。
- `dataEnv`、`legacyDirectory`：可选独立数据环境变量和旧项目目录；新平台可以省略。
- `commands`：支持的命令，至少包括 `start`、`connect`。
- `configured(config, account)`：纯检查，表示是否具备无交互启动所需的已保存配置，不调用网络，也不返回凭据。
- `load()`：延迟导入适配器，返回导出 `main(command, { root, args, interactive })` 的模块。

`root` 已由统一入口确定。适配器不得另建与当前工作目录相关的数据路径；同一个平台的多个命令必须使用 `acquireLock(root)` 防止并发操作队列。`main` 在退出前释放监听、写入、连接与锁；`start` 在服务运行期间保持 Promise 未完成。`interactive: false` 时不得等待凭据输入。信号取消应以 `AbortError` 安静退出，平台故障不得终止其他适配器。

首次 `start` 和 `connect` 先调用 `shared/connect.mjs` 的 `connectBridge`，再收集平台账号。这样 App / CLI 能发现服务，账号提示不会阻挡服务注册。共享客户端负责本机 `discovery`、`pairings`、授权恢复与直连 HTTP，不受代理变量影响。

平台只负责以下转换：

1. 将平台来信转换为 `messageId`、`senderId`、`conversationId`、`text`，先持久化，再向 Cardbush 提交。消息 ID 必须稳定并支持重放去重。
2. 在适配器 `plugins.mjs` 提供 `{ manifest, handlers }` 集合；通过共享 `advertisePlugins` 每 15 秒声明插件、文件和大小限制，退出时 `withdrawPlugins` 撤销。
3. 使用共享 `bot-outbound.mjs` 解析通用回调并校验 SHA-256；将 `tool.call` 交给 `invokePlugin` 按插件 ID、版本与工具名分发。处理器验证参数及平台限制。
4. 从已持久化的原始来信决定收件人。外部回调不能指定任意陌生收件人。
5. 将文件和发送进度持久化，再返回 `accepted`；它表示桥已接收，不表示平台已送达。平台回执、重试标识及上传状态仍由适配器保存。

通用共享层不得导入某个平台 SDK、判断具体平台名称或读取其账号。新适配器可以参考两个现有队列，但不要把平台上传协议塞入共享回调解析器。应增加独立协议测试，并通过真实 Cardbush Runtime 的对话、来源与文件工具集成测试。

## 插件集合

`manifest` 包含 `id`、`name`、`version`、`description`、`tools`；工具包含 `name`、`description`、JSON `inputSchema`，可声明 `fileArguments` 与 `readOnly`。`handlers[toolName](event, files)` 返回 JSON 结果。微信、飞书各有自己的集合，通用层不固定平台功能列表。

模型文件参数使用本机路径，但桥收到的是 `{part: "file_0"}` 和经过校验的二进制数组；不得将参数当成本机路径读取。`source_ref`、`request_id` 属于宿主保留参数，不应声明到平台 schema。回调包含可信路由字段，处理器仍必须对照原始来信校验，不允许任意收件人。

`send_text` / `send_file` 可复用 `messagingHandlers`，其他能力直接定义自己的处理器。有副作用的处理器必须按 `eventId` 持久化去重并保存重试进度。只读工具也必须验证来源。`accepted` 与平台送达状态分开；返回值通过 `result` 交给 Agent。

详细线协议见相邻 Cardbush 的 `docs/WEBHOOK_BOT_PROTOCOL.md`。运行服务不需要引用 Cardbush 源码或安装平台插件到核心仓库。
