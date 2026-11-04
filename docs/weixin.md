# 微信 ↔ Cardbush 独立桥接服务

微信代码全部位于这个独立目录。**不依赖 OpenClaw，不安装它的插件，不调用它的模型或网关。**微信扫码、长轮询和发送按照腾讯公开的 iLink 协议独立实现；推理、插件执行与上下文由 Cardbush 通用 Webhook 提供。

```text
微信 ⇄ 腾讯 iLink ⇄ 本服务 ⇄ 通用 Webhook ⇄ Cardbush 当前会话
```

接收端支持私聊文字和微信服务端已转写的语音。微信发来的图片、视频和文件仍会收到文字提示，不会伪装成已识别。发送端支持 Agent 搜索并调用本桥插件的 `send_file` 工具发送本机文件。群聊不接入。默认只接受扫码授权者的消息，防止其他人进入同一 Cardbush 上下文。

## 首次接入

要求 Node.js 22.13 或更新版本，以及支持本机服务自动接入的新版 Cardbush。先打开 Cardbush，再运行：

```powershell
cd D:\proj\cardbush-bridges
npm ci --ignore-scripts
npm link --ignore-scripts
cardbush-bridge start weixin
```

1. 在需要复用上下文的 Assistant 或本机会话右上角打开“连接服务”，找到“微信服务”，点击“连接”。
2. 首次登录时，终端自动显示二维码，用微信扫码并确认。也可打开 `.private/weixin/login.png` 扫码；若微信要求验证码，在终端输入。
3. 保持两端运行，在微信给登录的 Bot 发文字。回复使用已绑定的 Cardbush 会话、模型和插件；需要审批的执行仍在 Cardbush 内确认。

不用复制地址、令牌或请求头。后续仅运行 `cardbush-bridge start weixin`，复用保存的连接和登录。已有手动配置也能继续使用。登录失效时运行 `cardbush-bridge login weixin` 重新扫码，再启动；更换绑定会话或恢复已移除的连接时，先停止服务，运行 `cardbush-bridge connect weixin`，在目标会话点击连接后再 `cardbush-bridge start weixin`。

`cardbush-bridge login weixin` 和分步登录的 `login-start` 也会先完成同样的 Cardbush 连接，再显示二维码。终端的 `微信扫码状态：wait` 表示等待手机扫码，不代表 Bot 服务已开始收发消息；扫码完成后仍需 `cardbush-bridge start weixin`。首次接入直接使用 `cardbush-bridge start weixin` 即可串起全部步骤。

Cardbush 默认本机入口是 `127.0.0.1:4791`；本服务回复入口默认是 `127.0.0.1:4792/reply`。两端自动交换这两个方向的参数。连接凭据随机生成，不是硬编码密钥。

自动发现与授权客户端位于 `src/shared/local-connection.mjs`，使用 Cardbush 的通用 `discovery` / `pairings` 协议，没有平台 API 或账号逻辑。平台登录、长轮询和消息转换均留在本独立服务中。

本机两端主动连接，不需要公网穿透。微信适配依赖二维码编码库 `qrcode`，HTTP、长轮询、持久化均使用 Node 自带能力。

`CARDBUSH_WEIXIN_DATA` 可以指定私有数据目录。默认目录不纳入 Git；Windows 限制为当前用户访问，其他平台使用目录 0700 / 文件 0600。当前实现保存本机明文凭据，依赖操作系统文件权限保护，不将其记录到日志。

## 手动配置（高级）

一般不需要使用。修改过 Cardbush 本机监听端口时，可设置 `CARDBUSH_WEBHOOK_URL` 为实际本机根地址，例如 `http://127.0.0.1:6112`，再连接；它不是 `/reply` 或消息接收路径。自动配对仅适用于同机服务。

需要远程或手动接入时：

1. 运行 `cardbush-bridge init weixin`。在 Cardbush 的“连接服务 → 手动配置（高级）”填写名称，以及 `.private/weixin/cardbush-connection.json` 中的回复地址和请求头。远程部署须自行提供双向可达的 HTTPS 地址。
2. 保存后，运行 `cardbush-bridge setup weixin`，填写 Cardbush 生成的**接收消息地址**和**接收令牌**。接收地址形如 `http://127.0.0.1:4791/api/webhooks/v1/连接ID/messages`；`http://127.0.0.1:4792/reply` 属于另一方向，不能填在这里。
3. 运行 `cardbush-bridge start weixin`。填错字段会提示并允许重输，不会丢弃旧配置；不要把私有令牌提交到仓库。

## 让 Agent 发送文件

更新后重启 Cardbush 和本服务，已有连接无需重新填写参数。在微信给 Bot 发一条消息，再提出“把刚才生成的报告作为文件发给我”。Agent 会根据这条消息的来源搜索并调用本桥的文件工具，发送到同一微信会话；不会自动转发所有生成文件。

本服务启动后每 15 秒向 Cardbush 通用 `/capabilities` 接口刷新插件与能力。没有连接、不在线或没有原始来信时，工具会报告不可用。发送仍遵守 Cardbush 的文件读取权限；当前 `send_file` 每次一个文件，上限 64 MiB。正常退出立即撤销插件，异常退出最多 45 秒失效。图片和视频也按文件附件发送，暂不转换为平台专用预览消息。

附件通过通用 `message.send` multipart 回调进入私有持久化队列，按事件 ID 去重；随后本服务独立完成腾讯 CDN 加密上传和发送。成功入队只表示 Bot 接收，不能视为微信已送达。失败保留队列重试，成功后清理暂存文件。协议可供其他平台复用，Cardbush 源码不包含微信适配。

通用协议说明见相邻 Cardbush 仓库的 [WEBHOOK_BOT_PROTOCOL.md](../../cardbush/docs/WEBHOOK_BOT_PROTOCOL.md)。

## 运行行为

- 微信来信先持久化，再推进长轮询游标；Cardbush 不在线时保留消息并重试。
- 平台 uint64 消息 ID 保留全部数字；重复消息与重复回调去重。
- 回调使用独立 Bearer 令牌，发送目标从已记录来信读取，回调不能任意指定微信收件人。
- 长回复按 UTF-8 字节边界拆分，逐片保存进度。发送失败复用相同 `client_id` 重试；腾讯协议没有公开恰好一次投递保证，极端丢回执场景仍可能重发。
- Assistant 后台任务的完整新快照只发送新增后缀；文本被改写时发送新的完整文本。
- 收到登录失效错误会停止服务，重新扫码后启动。单实例锁避免两个本服务进程同时长轮询。
- 私有队列不自动过期，包含上下文令牌和消息正文。更换微信账号须归档旧队列，禁止将旧账号消息发送到新账号。
- 可在私有配置 `allowedSenders` 指定额外微信用户 ID；这些用户会共享同一个 Cardbush 上下文。默认不配置此字段。

## 测试与当前验收边界

```powershell
npm test
npm run test:cardbush
```

第一项验证通用自动发现和授权恢复、腾讯协议请求、超大消息 ID、私聊权限、重复收发、崩溃恢复、分片与后续结果，以及文件加密上传、字节校验、收件人绑定和重启恢复。第二项使用旁边 `../cardbush` 的已构建代码，跑真实桌面 Webhook Host 和 Runtime：自动申请 → 选定会话授权 → 微信模拟消息 → 既有会话 → mock 模型/文件工具 → HTTP 回调 → 微信发送模拟器；可用 `CARDBUSH_SOURCE_DIR` 修改源码路径。

旧版出口在 2026-11-04 已完成一次真实账号附件验收（不代表新插件入口已做真人收件验收）：微信来信 → Assistant 实际调用 `send_to_bot` → 通用 multipart 回调 → 腾讯 CDN 加密上传 → 微信收到并打开 `icon.png`（266,874 字节）。接收者明确确认“收到了，能打开”；SHA-256 为 `e9c1b2cea4d39b4d900d208f889ee77e425652732fdc3c730b7821a0f7c16a17`。

本次首轮在桌面启动后出现 `assistant_failed`，通过现有 Assistant 重试入口恢复并保留原消息来源，随后文件发送成功；这项启动失败的原因尚未在本次验收中确定。此次实测覆盖 PNG 文件，不代表所有格式、大小及启动场景均已验收。自动化测试仍独立使用模拟账号接口。

## 协议依据

- [腾讯协议说明](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md)
- 核对版本：上游提交 `874637a0dbc24050f72d1385add4fc6170a2d726`，协议客户端版本 `2.4.10`。
- 上游说明基于客户端行为，不构成完整服务端契约。该项目只参考协议文档，运行时不加载上游源码；`.reference/` 是本地检索缓存，不进入提交或发布包。

用户给出的 `npx -y @tencent-weixin/openclaw-weixin-cli@latest install` 是 OpenClaw 专用安装器，不用于本服务。本服务直接与腾讯接口通信。
