import { join } from 'node:path';
import { writeJson } from './storage.mjs';
import { connectLocalService } from './local-connection.mjs';

export function connectBridge(config, { root, name, signal, force = false, log = console.log, fetcher }) {
  log(`正在连接 Cardbush：${name}。`);
  return connectLocalService(config, { name, signal, force, fetcher, baseUrl: process.env.CARDBUSH_WEBHOOK_URL,
    save: value => writeJson(join(root, 'config.json'), value), onStatus(status, title) {
      if (status === 'connected') log('已连接 Cardbush 会话：' + title);
      else if (status === 'waiting_for_authorization') log(`请在目标 Cardbush 会话的“连接服务”中选择“${name}”；CLI 用户输入 /webhook 后刷新并选择。`);
      else log('等待 Cardbush 启动，无需填写地址或令牌。');
    } });
}
