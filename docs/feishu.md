# Cardbush 飞书桥

独立运行的飞书机器人服务，按现有 `cardbush.webhook.v1` 协议连接本机 Cardbush。对话使用所连接 Assistant / 会话的上下文、模型和插件；桥自带消息、文件和发送状态插件，由 Agent 按来信来源搜索调用。

飞书代码及凭据只在这个独立目录中。运行不依赖 Cardbush 源码目录、微信桥或 OpenClaw；平台适配使用锁定版本的飞书官方 Node SDK。

## 第一次使用

需要 Node.js 22.13 或更新版本，以及支持桥插件声明（`bridge_plugins`）的新版 Cardbush。

### 1. 准备飞书应用

在 [飞书开发者后台](https://open.feishu.cn/app) 创建**企业自建应用**，添加「机器人」能力。记录「凭证与基础信息」里的 **App ID** 和 **App Secret**。请在本机终端填写密钥，不要发到聊天中。

在「权限管理」开通：

| 权限 | 用途 |
| --- | --- |
| `im:message.p2p_msg:readonly` | 接收用户发给机器人的私聊消息 |
| `im:message:send_as_bot` | 机器人发送回复 |
| `im:resource` | 上传待发送的文件 |

这里需要能接收消息的应用机器人。群里通过「添加自定义机器人」得到的单个 Webhook URL 不能完成双向对话。

### 2. 启动并连接 Cardbush

本目录已安装依赖，直接运行：

```powershell
cd D:\proj\cardbush-bridges
cardbush-bridge start feishu
```

复制到另一台电脑后，第一次先执行 `npm ci --ignore-scripts` 安装锁定版本的依赖，再执行 `npm link --ignore-scripts` 注册命令，之后可以在任意目录运行 `cardbush-bridge start feishu`。

先在 Cardbush 的 **Assistant 或目标会话右上角 → 连接服务 → 飞书服务 → 连接**；CLI 用户用 `/webhook` 刷新并选择飞书服务。连接后终端才提示输入 App ID 和 App Secret（密钥输入不显示）。飞书凭据尚未填写时，服务也会先出现在待连接列表里。

不需要填写 Cardbush 地址、回调地址、令牌、字段映射或 JSON 模板。桥默认自动发现 `http://127.0.0.1:4791`，回复监听 `127.0.0.1:4793`。两边谁先启动都可以；首次连接申请等待 10 分钟，超时后重新启动即可。

### 3. 开启飞书消息事件

保持终端运行，等到出现「飞书长连接已建立」。此时在飞书应用后台「事件与回调」选择 **使用长连接接收事件**，保存并添加事件 **接收消息 `im.message.receive_v1`**。

在「版本管理与发布」创建并发布版本，确认可用范围包含你自己；如企业要求管理员审核，需审核通过。长连接不需要公网服务器、域名或外网回调地址。

第一次私聊该机器人，发送终端显示的：

```text
连接 终端中的8位数字
```

该码 10 分钟有效；过期后重启桥生成新码。成功后机器人回复「已连接你的 Cardbush」。默认只接受这个用户的私聊，防止其他人通过机器人使用你的本机 Agent。后续启动会记住应用、Cardbush 连接和配对用户，不再重复配置。

## 对话和发送文件

直接在飞书机器人私聊中提问。回复回到发起请求的飞书会话；长回复会拆成多条文字消息。

例如发送：

```text
生成一份测试报告，保存为文本文件，然后把文件通过飞书发给我。
```

或指定一个真实存在的本机文件：

```text
把 D:/reports/report.pdf 作为文件发给我，通过当前飞书会话发送。
```

文件不会自动转发。Agent 必须调用工具；桥收到通用文件事件后校验来源、大小和 SHA256，再上传飞书并发给原始会话。Cardbush 按来信附带来源状态，Agent 能识别这是「飞书服务」，不会依赖一个全局“最近的 Bot”。

单文件最多 **30,000,000 字节**，每次最多 **8 个**，总计 **120,000,000 字节**，空文件不支持。图片也按可下载文件发送，文件能否在线预览取决于飞书支持的格式。

当前接收文字和富文本中的文字、链接。飞书发来的图片、语音和文件**不会自动读取**，机器人会明确告知。此版本实现的是对话与 Agent 向飞书发文件。

## 日常操作

```powershell
cardbush-bridge start feishu         # 启动并复用已保存的连接
cardbush-bridge doctor feishu    # 检查应用鉴权、机器人能力及本地配置
cardbush-bridge setup feishu     # 重新填写应用凭据
cardbush-bridge connect feishu   # 重新申请连接另一个 Cardbush 上下文，完成后再 cardbush-bridge start feishu
```

`Ctrl+C` 停止。修改配置及运行检查前，先停止已经运行的飞书桥；同一数据目录只能运行一个实例。`doctor` 验证鉴权，不能代替飞书后台的发布、事件订阅和实际收件检查。

## 高级配置

默认私有数据位于本目录 `.private/feishu`，自动排除版本控制。配置、已授权用户、消息队列和待发文件均保存在这里；Windows 限制目录 ACL，其他平台使用私有文件权限。凭据以本机文件保存，请保护该目录，勿上传或分享。

| 设置 | 使用方式 |
| --- | --- |
| 独立数据目录 | 环境变量 `CARDBUSH_FEISHU_DATA` 指定绝对路径 |
| 无交互凭据 | `FEISHU_APP_ID`、`FEISHU_APP_SECRET`；不会打印到日志 |
| 非默认 Cardbush 端口 | `CARDBUSH_WEBHOOK_URL`，例如 `http://127.0.0.1:6112`，仅本机地址 |
| 桥回复端口 | 停止服务后修改 `.private/feishu/config.json` 的 `port`，再 `cardbush-bridge connect feishu` 更新绑定 |
| 获准用户 | 配置 `allowedSenders` 为飞书 `open_id` 数组；未设置时使用首次配对用户 |
| 指定群聊 | 配置 `allowedChats` 为 `chat_id` 数组，另开通 `im:message.group_at_msg:readonly` 并发布；只处理获准用户在指定群中 @机器人的消息 |

一个实例绑定一个 Cardbush 上下文。多个获准用户或群共享这一上下文；需要隔离时使用不同数据目录、回复端口和 Cardbush 会话。更换绑定前先处理完未完成请求；换飞书应用请使用新的数据目录，避免旧队列混用。

服务每 15 秒声明插件与能力；正常停止立即撤销，异常退出后最多 45 秒过期。短暂断网保留队列并重试。接收回调落盘后才返回 `accepted`；文件上传后的 `file_key`、每条消息的发送进度及稳定 UUID 也会保存，重启不会无故重复上传已保存的文件。

`accepted` 代表桥已接收，**不代表飞书最终送达或用户已打开**。平台最终确认需以飞书实际收件为准。平台 UUID 去重有时间范围，极端情况下（例如已送达但落盘前断电，且很久以后重试）不能承诺绝对不重复。

## 常见问题

- **等待 Cardbush 启动**：启动 Cardbush，并在目标上下文右上角连接服务；无需复制 `/reply` 地址。
- **找不到机器人或收不到消息**：确认机器人能力已启用、长连接在线、订阅了 `im.message.receive_v1`、权限与版本已发布、应用可用范围包含你，且已完成私聊配对。
- **鉴权失败**：运行 `cardbush-bridge setup feishu` 核对自建应用的 App ID / Secret。只保存新的密钥不会替你发布飞书应用。
- **`connection_revoked`**：原 Cardbush 连接被删除或停用；停止桥后运行 `cardbush-bridge connect feishu`，重新在应用里确认。
- **`service_already_running` / 端口占用**：停止旧进程后重启。微信桥默认用 4792，飞书桥默认用 4793，可以并存。
- **消息/文件等待重试**：查看终端机器错误码和飞书应用权限、网络状态。队列在 `.private/feishu/queue.json`，不要通过删队列的方式重试，以免丢失进度。
- **Cardbush 未完成本次处理**：进入对应 Assistant / 会话查看运行错误，恢复可用的模型配置后重试。桥不会把 Runtime 错误伪装为发送成功。

## 验证与实现边界

```powershell
npm test
npm run test:cardbush
```

第二条仅用于开发集成验证，需要相邻的已构建 Cardbush 仓库，或设置 `CARDBUSH_SOURCE_DIR`。运行服务不需要该仓库。测试使用临时目录和随机本机端口，不接触真实用户连接。

自动化回归覆盖：官方 SDK 事件解析、首次用户配对、双向对话、通用文件回调、字节完整性、去重、失败恢复，以及 Cardbush 先启动/桥先启动。集成测试使用真实 Cardbush Host、Runtime、插件搜索、参数加载与工具调用，同时覆盖普通会话与 Assistant；模型和飞书网络端由测试模拟。

**尚未配置真实飞书账号，因此尚未完成真实飞书收件及打开附件的人工验收。**

参考：[飞书官方 Node SDK](https://github.com/larksuite/node-sdk)、[事件订阅与长连接](https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-)、[发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)、[上传文件](https://open.feishu.cn/document/server-docs/im-v1/file/create)。
