import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { terminalAsk } from '../../shared/terminal.mjs';
import { privateDirectory, readJson, writeJson, acquireLock } from '../../shared/storage.mjs';
import { configure, credentials } from './config.mjs';
import { connectBridge } from '../../shared/connect.mjs';
import { FeishuApi } from './feishu.mjs';
import { Bridge } from './bridge.mjs';
import { connectFeishu } from './connection.mjs';
import { createNetwork } from '../../shared/network.mjs';

export async function main(command = 'start', { root: directory, interactive = !!process.stdin.isTTY, network: networkSettings } = {}) {
  if (command === 'help' || command === '--help') {
    console.log('首次/日常启动：cardbush-bridge start feishu\n修改凭据：cardbush-bridge setup feishu\n更换 Cardbush 会话：cardbush-bridge connect feishu\n检查配置：cardbush-bridge doctor feishu'); return;
  }
  if (!['start', 'setup', 'connect', 'doctor'].includes(command)) throw Error('unknown_command');
  const root = await privateDirectory(resolve(directory)), file = join(root, 'config.json');
  const release = await acquireLock(root), abort = new AbortController(); let bridge, connection;
  const network = createNetwork(networkSettings);
  const cancel = () => { abort.abort(); bridge?.abort.abort(); connection?.close(); };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    let config = await readJson(file, { port: 4793, callbackToken: randomBytes(32).toString('hex'), cardbush: { url: '', token: '' } });
    if (command === 'doctor' && !config.feishu) throw Error('credentials_required');
    if (command === 'start' || command === 'connect') {
      config = await connectBridge(config, { root, name: '飞书服务', signal: abort.signal, force: command === 'connect', fetcher: network.fetch });
      if (command === 'connect') { console.log('绑定已保存，运行 cardbush-bridge start feishu。'); return; }
    }
    const terminal = terminalAsk({ signal: abort.signal, interactive });
    try { config.feishu = await configure(command === 'setup' ? undefined : config.feishu, { ask: terminal.ask }); }
    finally { terminal.close(); }
    console.log('正在验证飞书应用凭据与机器人能力……');
    console.log('Network mode: ' + network.mode);
    const api = new FeishuApi(config.feishu, network.fetch), identity = await api.identity(abort.signal);
    const queue = await readJson(join(root, 'queue.json'), null);
    if (queue && queue.appId !== config.feishu.appId) throw Error('queue_app_mismatch');
    await writeJson(file, config);
    if (command === 'setup') { console.log('飞书应用凭据已验证并保存在本机。运行 cardbush-bridge start feishu 完成连接。'); return; }
    if (command === 'doctor') {
      console.log('飞书应用鉴权和机器人能力正常。');
      console.log(config.cardbush?.url ? '已有 Cardbush 连接配置。' : '尚未连接 Cardbush，运行 cardbush-bridge start feishu。');
      console.log(queue?.owner || config.allowedSenders?.length ? '已有获准的飞书用户。' : '首次启动后需在飞书发送终端显示的配对码。'); return;
    }
    bridge = await new Bridge(root, config, api, { botOpenId: identity.openId, fetcher: network.fetch }).load();
    await bridge.listen();
    const code = bridge.pairingCode();
    if (code) console.log('首次使用：在飞书私聊这个机器人发送“连接 ' + code + '”（10 分钟有效；过期后重启生成新码）。');
    connection = connectFeishu(credentials(config.feishu), bridge, { signal: bridge.abort.signal, network });
    console.log('飞书服务已启动。保持本窗口运行；Ctrl+C 停止。');
    await connection.started;
    bridge.abort.signal.throwIfAborted();
    await bridge.run();
  } catch (error) { error.userMessage = errors[error.code] || errors[error.message]; throw error; } finally {
    cancel(); await bridge?.close(); await network.close(); await release(); process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  }
}
const errors = {
  invalid_app_id: 'App ID 格式不正确，请使用飞书自建应用的 cli_ 开头标识。', invalid_app_secret: 'App Secret 不正确，请重新复制应用密钥。',
  credentials_required: '尚未填写飞书应用凭据，请运行 cardbush-bridge start feishu。', credentials_required_noninteractive: '首次启动请在终端填写凭据，或设置 FEISHU_APP_ID 和 FEISHU_APP_SECRET。',
  feishu_bot_not_enabled: '请先在飞书开放平台为应用开启机器人能力。', feishu_error_10003: '飞书应用凭据校验失败，请运行 cardbush-bridge setup feishu 重新填写。',
  connection_revoked: 'Cardbush 连接已移除或停用。需要重新连接时，停止服务后运行 cardbush-bridge connect feishu。',
  connection_rejected: '连接申请已被忽略，需要重新申请时运行 cardbush-bridge connect feishu。', pairing_expired: '等待连接超时。请打开 Cardbush 后重新运行 cardbush-bridge start feishu。',
  service_already_running: '飞书桥已经运行，请先停止原进程。', queue_app_mismatch: '队列属于另一个飞书应用。请用 CARDBUSH_FEISHU_DATA 指定新的数据目录，保留旧队列。',
  EADDRINUSE: '回复端口已被占用，请关闭重复进程，或在私有配置中修改 port。',
};
