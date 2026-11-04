# Cardbush Bridges

独立的多平台 Bot 桥项目。当前支持微信和飞书，统一使用 `cardbush.webhook.v1` 接入 Cardbush App 或 CLI，支持对话和 Agent 调用 `send_to_bot` 发送文件。平台代码、账号、SDK 和队列都在本项目中，Cardbush 核心无需增加平台适配，也不依赖 OpenClaw。

## 启动

需要 Node.js 22.13 或更新版本。第一次安装依赖：

```powershell
cd D:\proj\cardbush-bridges
npm ci --ignore-scripts
npm start
```

`npm start` 显示平台选择菜单。也可以直接选择：

```powershell
npm start -- feishu
npm start -- weixin
```

先在 Cardbush 的目标 Assistant / 会话右上角打开“连接服务”，选择相应服务；CLI 用户在目标会话输入 `/webhook`，刷新并选择。之后按终端提示配置平台账号：微信扫码，飞书填写 App ID / App Secret。**平台账号尚未配置，也会先出现连接申请。**无需复制接收地址、回调地址或令牌。

飞书应用仍需开启机器人、消息权限与长连接事件并发布。具体步骤见 [飞书接入](docs/feishu.md)；微信见 [微信接入](docs/weixin.md)。

配置完成后可以同时启动：

```powershell
npm start -- all
```

`all` 仅启动已配置且未运行的平台，未配置的平台会显示提示；不并行弹出账号输入。每个平台独立连接、重试和保存队列，一个平台失败不会终止其他平台。按 `Ctrl+C` 停止本次启动的服务。单独启动时每个平台使用一个终端即可。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run status` | 查看各平台本机配置和进程状态，不打印凭据；不等同于平台在线验证 |
| `npm run connect -- feishu` | 为飞书重新选择 Cardbush 会话 |
| `npm run connect -- weixin` | 为微信重新选择 Cardbush 会话 |
| `npm run setup -- feishu` | 更换飞书应用凭据 |
| `npm run login -- weixin` | 微信重新扫码登录 |
| `npm run doctor -- feishu` | 验证飞书鉴权及机器人能力 |

默认 Cardbush 入口是 `127.0.0.1:4791`；微信回复端口为 `4792`，飞书为 `4793`。App 与 CLI 使用同一协议，但各自保存上下文，默认端口同时只能由一个宿主监听。更换 Cardbush 端口时设置 `CARDBUSH_WEBHOOK_URL`，然后重新执行 `connect`。

## 数据与原项目迁移

默认目录以本项目位置为准，与启动时的工作目录无关：

```text
.private/
  weixin/    配置、登录、队列、待发文件
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

集成测试依赖相邻的已构建 Cardbush 源码，或通过 `CARDBUSH_SOURCE_DIR` 指定；运行服务不需要源码。测试使用临时目录、随机端口及模拟平台接口，覆盖发现顺序、输入提示、数据导入、会话来源、真实 Runtime 文件工具、文件字节和持久化重试。真实账号收件不由模拟测试代替。
