import { bridges } from './registry.mjs';
import { prepareData, configurationState } from './data.mjs';
import { terminalAsk } from './shared/terminal.mjs';

const help = `Cardbush Bridges — 微信、飞书与后续平台的统一桥服务
npm start                     选择一个平台
npm start -- feishu            启动飞书（首次先发现服务，再配置账号）
npm start -- weixin            启动微信
npm start -- all               同时启动已经完成配置的平台
npm run connect -- feishu      重新绑定 Cardbush 当前会话
npm run setup -- feishu        修改飞书凭据
npm run login -- weixin        微信重新扫码
npm run doctor -- feishu       检查飞书账号
npm run status                查看各平台本机状态
Ctrl+C 停止当前启动的服务。各平台的账号、队列和回调端口分别保存。`;

const errors = {
  legacy_bridge_running: '旧桥仍在运行，请先在原终端按 Ctrl+C，再启动统一桥；登录及待发队列会自动导入。',
  service_already_running: '这个平台已在运行，请先停止原进程。',
  credentials_required_noninteractive: '首次配置需要交互终端，请单独运行 npm start -- 平台名。',
  platform_required: '请指定平台，例如 npm start -- feishu。',
  unknown_platform: '未知平台。运行 npm start 选择微信或飞书。',
  unsupported_command: '该平台不支持此命令，请运行 node bin/cardbush-bridges.mjs help。',
  no_configured_bridges: '尚无已配置平台。先分别运行 npm start -- weixin 或 npm start -- feishu 完成接入。',
};
export function reportError(error) {
  if (error?.name === 'AbortError') return;
  console.error(error?.userMessage || errors[error?.message] || '操作未完成：' + (/^[a-z0-9_]+$/i.test(error?.message || '') ? error.message : 'bridge_failed'));
  process.exitCode = 1;
}
export async function main(args = process.argv.slice(2)) {
  const [command = 'start', selected, ...rest] = args;
  if (['help', '--help', '-h'].includes(command)) { console.log(help); return; }
  if (command === 'status') {
    for (const bridge of bridges) {
      const root = await prepareData(bridge), state = await configurationState(bridge, root);
      console.log(`${bridge.name}：${state.running ? '正在运行' : '已停止'}，${state.configured ? '已配置' : '待配置'}，回复端口 ${state.port}`);
    }
    return;
  }
  let platform = selected;
  if (!platform) {
    if (!process.stdin.isTTY) throw Error('platform_required');
    console.log(bridges.map((bridge, index) => `${index + 1}. ${bridge.name}`).join('\n') + (command === 'start' ? '\nall. 全部已配置平台' : '') + '\n0. 返回');
    const terminal = terminalAsk();
    try { platform = (await terminal.ask('选择平台：')).trim(); } finally { terminal.close(); }
    if (!platform || platform === '0') return;
    platform = bridges[Number(platform) - 1]?.id || platform;
  }
  if (platform === 'all') {
    if (command !== 'start' || rest.length) throw Error('unsupported_command');
    const configured = [];
    for (const bridge of bridges) {
      const root = await prepareData(bridge), state = await configurationState(bridge, root);
      if (state.configured && !state.running) configured.push({ bridge, root });
      else console.log(`${bridge.name}：${state.running ? '已运行，跳过' : '尚未配置，先单独启动此平台'}`);
    }
    if (!configured.length) throw Error('no_configured_bridges');
    await Promise.all(configured.map(async ({ bridge, root }) => {
      try { const adapter = await bridge.load(); await adapter.main('start', { root, interactive: false, args: [] }); }
      catch (error) { if (error.name !== 'AbortError') { console.error(`${bridge.name}服务停止。`); reportError(error); } }
    }));
    return;
  }
  const bridge = bridges.find(item => item.id === platform);
  if (!bridge) throw Error('unknown_platform');
  if (!bridge.commands.includes(command) || rest.length && command !== 'login-check') throw Error('unsupported_command');
  const root = await prepareData(bridge), adapter = await bridge.load();
  await adapter.main(command, { root, args: rest, interactive: !!process.stdin.isTTY });
}
