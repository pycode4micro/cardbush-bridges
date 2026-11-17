# Cardbush Bridges

独立的多平台 Bot 桥项目。当前支持微信和飞书，统一使用 `cardbush.webhook.v1` 接入 Cardbush App 或 CLI，支持对话，并自带供 Agent 搜索调用的平台插件集合。平台代码、账号、SDK 和队列都在本项目中，Cardbush 核心无需增加平台适配，也不依赖 OpenClaw。

## 启动

需要 Node.js 22.13 或更新版本。第一次安装依赖：

```powershell
cd D:\proj\cardbush-bridges
npm ci --ignore-scripts
npm link --ignore-scripts
cardbush-bridge start
```

`npm link` 只需运行一次，将命令注册到当前用户的 PATH。之后可以在任意目录调用；移动源码目录后重新执行一次链接。`cardbush-bridge` 或 `cardbush-bridge --help` 显示帮助，`cardbush-bridge start` 显示平台选择菜单。也可以直接选择：

```powershell
cardbush-bridge start feishu
cardbush-bridge start weixin
```

### 网络模式

默认无代理启动。网络选项对微信、飞书及 `start --all` 一致，也可用于 `login`、`login-start`、`login-check`、`doctor` 等需要联网的命令：

```powershell
cardbush-bridge start weixin                       # 默认直连
cardbush-bridge start weixin --no-proxy             # 显式直连
cardbush-bridge start weixin --proxy system         # 使用系统代理
cardbush-bridge start weixin --proxy http://127.0.0.1:7897
cardbush-bridge start --all --proxy socks5://127.0.0.1:7897
```

选项仅作用于本次启动，不写入账号配置；下次不带选项仍为直连。支持 HTTP、HTTPS 和 SOCKS5 代理 URL（包括 URL 编码的用户名和密码）。不要分享包含代理密码的命令。无论选择哪种模式，本机 Cardbush 的回环发现、授权、消息及插件回调都直连。远程 Cardbush HTTPS 连接和平台的登录、文件上传下载、消息、飞书 WebSocket 使用同一网络策略。

- **direct**：忽略继承的 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`。Windows 使用自带 PowerShell/.NET 启动按需的本机认证隧道，为连接和 DNS 绑定物理 IPv4 上联网卡，避免全局 TUN/Fake-IP 再次接管；TLS 仍由 Node 校验证书和加密，隧道不解密内容。不修改代理软件、系统路由或 DNS。需要活动的物理 IPv4 默认路由及该网卡的 DNS；不满足时明确报错，不偷偷退回代理。更换物理网卡或 DNS 后重启桥。其他系统使用普通直连套接字，操作系统 VPN/TUN 路由仍需由用户配置。
- **system**：Windows 使用当前用户系统代理及绕过规则（含系统可解析的自动配置）；macOS 使用系统静态代理，PAC 模式会明确报错；Linux 使用标准代理环境变量及 `NO_PROXY`。系统代理路由短暂缓存 30 秒。
- **指定 URL**：所有远程平台连接使用指定代理，重连沿用同一策略。代理失败时返回错误，不静默换成直连。代理口令不进入桥的普通日志或持久化队列。

Windows 网络辅助文件随源码/npm 包一起交付，从模块位置加载，不依赖当前工作目录。网络辅助进程仅监听带随机口令的回环端口，随桥退出；不会向局域网开放端口。

先在 Cardbush 的目标 Assistant / 会话右上角打开“连接服务”，选择相应服务；CLI 用户在目标会话输入 `/webhook`，刷新并选择。之后按终端提示配置平台账号：微信扫码，飞书填写 App ID / App Secret。**平台账号尚未配置，也会先出现连接申请。**无需复制接收地址、回调地址或令牌。

飞书应用仍需开启机器人、消息权限与长连接事件并发布。具体步骤见 [飞书接入](docs/feishu.md)；微信见 [微信接入](docs/weixin.md)。

配置完成后可以同时启动：

```powershell
cardbush-bridge start --all
```

`--all` 仅启动已配置且未运行的平台，未配置的平台会显示提示；不并行弹出账号输入。每个平台独立连接、重试和保存队列，一个平台失败不会终止其他平台。按 `Ctrl+C` 停止本次启动的服务。单独启动时每个平台使用一个终端即可。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `cardbush-bridge status` | 查看各平台本机配置和进程状态，不打印凭据；不等同于平台在线验证 |
| `cardbush-bridge connect feishu` | 为飞书重新选择 Cardbush 会话 |
| `cardbush-bridge connect weixin` | 为微信重新选择 Cardbush 会话 |
| `cardbush-bridge setup feishu` | 更换飞书应用凭据 |
| `cardbush-bridge login weixin` | 微信重新扫码登录 |
| `cardbush-bridge doctor feishu` | 验证飞书鉴权及机器人能力 |
| `cardbush-bridge status feishu --json` | 以 JSON 输出指定平台状态 |
| `cardbush-bridge start --help` | 查看子命令帮助 |
| `cardbush-bridge --version` | 查看版本 |

参数错误写入 stderr 并返回退出码 `2`，运行错误返回 `1`，正常完成返回 `0`。脚本中可使用 `--no-interactive` 禁止终端询问；`status` 为只读操作，不创建目录或迁移数据。`--` 可用于终止本命令的选项解析。

`cardbush-bridges`、`npm start -- feishu`、`npm start -- all` 等旧入口仍然兼容。npm 脚本需要独立的 `--` 来转发参数；日常使用直接调用 `cardbush-bridge` 即可。

默认 Cardbush 入口是 `127.0.0.1:4791`；微信回复端口为 `4792`，飞书为 `4793`。App 与 CLI 使用同一协议，但各自保存上下文，默认端口同时只能由一个宿主监听。更换 Cardbush 端口时设置 `CARDBUSH_WEBHOOK_URL`，然后重新执行 `connect`。

## 桥自带插件

使用支持桥插件的 Cardbush，更新后重启本桥，已保存的连接会自动恢复。桥在连接时向当前会话的插件搜索注册自己的工具：

| 平台 | Agent 工具 |
| --- | --- |
| 微信 | `send_text`、`send_file`、`send_image`、`send_video`、`list_attachments`、`download_attachment`、`delivery_status` |
| 飞书 | `send_text`、`send_file`、`delivery_status` |

用户可以在微信发来图片、MP4 视频或文件，再说“看一下附件”或“把刚才的文件发回来”。Agent 按来信来源搜索微信桥插件、下载并使用已有工具读取，必要时调用对应发送工具；图片支持原生图片消息、视频支持原生 MP4 消息。Assistant 也可以委派子任务执行。登录、平台配置、输入状态和启停由桥自己管理。微信入站附件的 `localPath` 读取要求桥和 Cardbush 在同一台机器，详见 [微信接入](docs/weixin.md)。

常驻 `send_to_bot` 已移除。桥不在线、连接撤销或租约过期时，工具不可执行；正常退出主动撤销，异常退出最多 45 秒失效。每 15 秒刷新声明。卡片等未来平台特有能力只需在对应适配器的 `plugins.mjs` 增加，不必修改 Cardbush。旧版 Cardbush 不支持插件声明时会提示 `cardbush_plugins_upgrade_required`，请同时升级。

`accepted` 表示桥已持久化接收；`delivery_status` 的 `delivered` 表示平台接口成功，不表示用户已打开文件。来源、文件权限与字节校验仍由通用协议和运行时执行。

## 数据与原项目迁移

默认目录以本项目位置为准，与启动时的工作目录无关：

```text
.private/
  weixin/    配置、登录、队列、待发文件、来信附件缓存
  feishu/    配置、配对用户、队列、待发文件
```

首次使用会从相邻的 `cardbush-weixin-bridge/.private`、`cardbush-feishu-bridge/.private` 自动导入。导入前必须停止旧服务。原目录保留作为备份；已存在的新配置不会被覆盖，已发送进度和待发文件原样保存，不需要重新扫码或重新绑定已保存的会话。

旧项目中的启动命令及模块路径保留为兼容入口，均调用本项目及同一份新数据。代码与依赖只在本项目维护。不要在原备份目录继续改队列。

`CARDBUSH_BRIDGES_DATA` 可指定新的统一私有目录；仍支持 `CARDBUSH_WEIXIN_DATA`、`CARDBUSH_FEISHU_DATA` 单独指定某个平台的数据目录，后者优先。显式指定的新数据目录不会自动导入其他目录。目录由操作系统访问权限保护，凭据不进入 Git；不要上传或分享 `.private`。

## 增加平台

实现步骤见 [适配器接口](docs/ADAPTERS.md)。结构为：

```text
src/registry.mjs             平台注册、支持的命令与配置检查
src/cli.mjs                  平台选择、统一启动与状态
src/data.mjs                 数据目录、旧数据导入
src/shared/                  通用发现、配对、文件回调、存储、终端输入
src/adapters/weixin/         微信协议、登录、收发及队列恢复
src/adapters/feishu/         飞书 SDK、账号、收发及队列恢复
```

## 验证

```powershell
npm test
npm run test:cardbush
```

集成测试依赖相邻的已构建 Cardbush 源码，或通过 `CARDBUSH_SOURCE_DIR` 指定；运行服务不需要源码。测试使用临时目录、随机端口及模拟平台接口，覆盖发现顺序、输入提示、数据导入、会话来源、真实 Runtime 插件搜索与文件/图像工具、媒体收发字节和持久化重试。图片、视频、文件分别覆盖普通会话和 Assistant 委派链路。真实账号收件不由模拟测试代替。
