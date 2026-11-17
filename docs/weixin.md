# 微信 ↔ Cardbush 独立桥接服务

## 发送执行反馈

发送工具接收后返回传输状态及 `completion`：完成通知已协商且适配器有通知 Worker 时，返回 `mode=event`、`recipient=assistant`、`eventType=bridge_delivery_result`；否则返回 `mode=query`。这是能力事实，不附带模型下一步指令，也不增加发送后的复核。`delivered` 仍只表示平台 API 接受，不表示用户已阅读。

平台拒绝请求时，`lastError` 保留准确阶段和错误码，`details` 可包含操作、HTTP 状态、数字 `ret`/`errcode` 及最多 512 字符的脱敏平台说明。账号凭据、上下文令牌、媒体密钥和 URL 不进入该说明。文字发送、上传及媒体发送各自记账，不把 `sending_text` 失败解释成上传失败，也不猜测平台数字错误码的含义。重试和终态通知仍由持久化 Worker 驱动，不依赖模型轮询。

微信代码全部位于这个独立目录。**不依赖 OpenClaw，不安装它的插件，不调用它的模型或网关。**微信扫码、长轮询和发送按照腾讯公开的 iLink 协议独立实现；推理、插件执行与上下文由 Cardbush 通用 Webhook 提供。

```text
微信 ⇄ 腾讯 iLink ⇄ 本服务 ⇄ 通用 Webhook ⇄ Cardbush 当前会话
```

支持私聊文字、微信服务端已转写的语音，以及图片、视频、文件收发。来信附件先登记元数据，由 Agent 搜索本桥插件，下载后用已有图像、视频或文件工具读取。发送图片和 MP4 视频可使用平台原生消息，也可以作为普通文件发送。群聊和原始语音音频不接入。默认只接受扫码授权者的消息，防止其他人进入同一 Cardbush 上下文。

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
3. 保持两端运行，在微信给登录的 Bot 发文字或附件。回复使用已绑定的 Cardbush 会话、模型和插件；需要审批的执行仍在 Cardbush 内确认。

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

## 让 Agent 读取和发送附件

使用支持桥插件的 Cardbush，更新后重新运行 `cardbush-bridge start weixin` 即可，已有连接无需重新填写参数。Agent 会根据来信的微信来源搜索本桥工具，发送目标固定为对应微信会话，不会自动转发所有生成文件。

| 工具 | 用途 |
| --- | --- |
| `send_text` | 主动发送用户要求的文字 |
| `send_image` | 发送原生图片消息，支持 PNG、JPEG、GIF、WebP |
| `send_video` | 发送原生 MP4 视频消息，不做转码 |
| `send_file` | 作为文件发送任意格式，可附文字说明 |
| `list_attachments` | 按新到旧分页列出当前微信用户的附件，返回附件 ID、原消息 ID、类型和状态 |
| `download_attachment` | 下载并解密指定附件，返回 `localPath`、大小、类型、SHA-256 |
| `delivery_status` | 查询本次来信触发的发送结果 |

例如，先发一张图片，再说“看看刚才的图片”；或发 MP4 视频并要求“把这个视频原样发回来”；也可以说“把刚才生成的报告作为文件发给我”。插件内部只处理平台传输，内容理解交给当前 Agent 及其已有工具。图像理解需要当前模型支持视觉；视频下载后是否能解析取决于已配置的视频工具。

入站消息包含附件描述，不会把腾讯 CDN 地址、解密密钥或账号令牌放入模型上下文。Agent 可以直接使用消息内的附件 ID，也可以通过 `list_attachments` 查找同一微信用户此前发来的附件。下载结果是桥所在机器的私有本地文件，因此当前附件读取流程要求桥与 Cardbush 同机；远程手动连接仍可用于文字和出站文件，但尚未提供远程入站附件传输。

每条来信最多登记 8 个附件，超出的数量会明确提示；单个附件收发上限 64 MiB，平台可能另有限制。原生图片/视频根据实际文件头校验，其他视频格式需要先转换或用 `send_file`。下载会校验可用的长度、MD5、AES 填充及文件类型，并记录 SHA-256；失败会返回明确状态，Agent 可使用新的 `request_id` 重试。缓存缺失会重新下载，缓存被修改则拒绝读取。腾讯媒体地址可能过期，过期后需要用户重新发送附件。

本服务启动后每 15 秒向 Cardbush 通用 `/capabilities` 接口刷新插件与能力。没有连接、不在线或没有原始来信时，工具不可执行。正常退出立即撤销插件，异常退出最多 45 秒失效。发送仍遵守 Cardbush 文件读取权限。

发送工具通过通用 `tool.call` multipart 回调进入私有持久化队列，按事件 ID 去重；随后本服务独立完成腾讯 CDN 加密上传和发送。上传结果持久化，发送失败或重启后复用已上传媒体和相同 `client_id`，成功后清理待发文件。`accepted`/`queued` 只表示桥已接收；`delivered` 表示微信接口成功，不表示手机端已打开。旧 `message.send` 回调仍兼容，但不再作为常驻 Agent 工具。

通用协议说明见相邻 Cardbush 仓库的 [WEBHOOK_BOT_PROTOCOL.md](../../cardbush/docs/WEBHOOK_BOT_PROTOCOL.md)。

## 运行行为

- 已覆盖公开文档的 7 个 BotAPI：`getupdates`、`getuploadurl`、`sendmessage`、`getconfig`、`sendtyping`、`msg/notifystart`、`msg/notifystop`，另有二维码登录接口。未宣称覆盖所有微信产品或账号管理 API。
- `getconfig` 自动获取并短期缓存输入状态票据；处理消息期间刷新“正在输入”，任务完成或停止时取消。多个同一用户的任务结束后才取消，接口失败退避，不使对话失败。启动/停止通知随桥生命周期发送。这些接口、登录和启停不暴露成 Agent 工具。
- 微信来信先持久化，再推进长轮询游标；Cardbush 不在线时保留消息并重试。
- 平台 uint64 消息 ID 保留全部数字；重复消息与重复回调去重。
- 回调使用独立 Bearer 令牌，发送目标从已记录来信读取，回调不能任意指定微信收件人。
- 长回复按 UTF-8 字节边界拆分，逐片保存进度。发送失败复用相同 `client_id` 重试；腾讯协议没有公开恰好一次投递保证，极端丢回执场景仍可能重发。
- Assistant 后台任务的完整新快照只发送新增后缀；文本被改写时发送新的完整文本。
- 收到登录失效错误会停止服务，重新扫码后启动。单实例锁避免两个本服务进程同时长轮询。
- 私有队列与 `inbound-files` 附件缓存不自动过期，包含上下文令牌、消息正文及附件下载凭据。需要清理缓存时先停止桥；原消息记录仍保留，后续下载可能因媒体过期失败。更换微信账号须归档旧队列，禁止将旧账号消息发送到新账号。
- 可在私有配置 `allowedSenders` 指定额外微信用户 ID；这些用户会共享同一个 Cardbush 上下文。默认不配置此字段。

## 测试与当前验收边界

```powershell
npm test
npm run test:cardbush
```

第一项验证通用自动发现和授权恢复、腾讯协议请求、超大消息 ID、私聊权限、重复收发、崩溃恢复、分片与后续结果，以及图片/视频/文件加密上传、下载解密、字节校验、收件人绑定、重启复用、缓存篡改与路径保护、接口失败退避。

第二项使用旁边 `../cardbush` 的已构建代码，跑真实 Webhook Host 和 Runtime。除既有配对和发文件测试，还分别验证普通会话及 Assistant 子任务的三类媒体链路：模拟微信来信 → 插件搜索 → 获取工具定义 → 附件列表/下载 → 真正调用 `inject_image_input` 或 `read_file` → 同来源原生媒体发送。模型实际收到图像输入，视频经过下载和原样回发，文件经过实际读取，下载及回发字节与仓库内真实格式样本逐字节一致。可用 `CARDBUSH_SOURCE_DIR` 修改源码路径。

上述测试的腾讯 API/CDN 和模型为模拟器，没有使用真实账号收件；原生图片、视频与新插件入站附件仍需手机端实际使用验收，不能把模拟成功等同于真实微信已收到并打开。

旧版出口在 2026-11-04 已完成一次真实账号附件验收（不代表新插件入口已做真人收件验收）：微信来信 → Assistant 实际调用 `send_to_bot` → 通用 multipart 回调 → 腾讯 CDN 加密上传 → 微信收到并打开 `icon.png`（266,874 字节）。接收者明确确认“收到了，能打开”；SHA-256 为 `e9c1b2cea4d39b4d900d208f889ee77e425652732fdc3c730b7821a0f7c16a17`。

那次旧版验收首轮在桌面启动后出现 `assistant_failed`，通过现有 Assistant 重试入口恢复并保留原消息来源，随后文件发送成功；该记录只覆盖 PNG 文件，不代表本版原生图片、视频等新链路已经过真人验收。

## 协议依据

- [腾讯协议说明](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md)
- 核对版本：上游提交 `874637a0dbc24050f72d1385add4fc6170a2d726`，协议客户端版本 `2.4.10`。
- 上游说明基于客户端行为，不构成完整服务端契约。该项目只参考协议文档，运行时不加载上游源码。

用户给出的 `npx -y @tencent-weixin/openclaw-weixin-cli@latest install` 是 OpenClaw 专用安装器，不用于本服务。本服务直接与腾讯接口通信。

## 网络与图片上传诊断

启动默认直连；需要代理时使用 `cardbush-bridge start weixin --proxy system` 或 `--proxy http://127.0.0.1:7897`，完整说明见 [网络模式](../README.md#网络模式)。扫码、API、CDN 和重连共用该模式。Windows 默认直连会绑定物理 IPv4 网卡和 DNS，可避免全局 TUN 代理导致的微信 CDN 上传失败。

上传 HTTP 错误保留状态码及数字形式的 `x-error-code`，例如 `weixin_upload_http_500_cdn_-5104001`；HTTP 200 缺少媒体回执单独返回 `weixin_upload_receipt_missing`。不记录上传 URL、密钥、原始错误正文或任意响应头。`attempts` 包括首次尝试，`nextAttemptAt` 是下一次重试时间，`timings` 是各阶段累计毫秒数。
