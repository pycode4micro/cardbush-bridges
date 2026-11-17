import { readFile } from 'node:fs/promises';
import { bridges } from './registry.mjs';
import { prepareData, configurationState, dataDirectory } from './data.mjs';
import { terminalAsk } from './shared/terminal.mjs';
import { CLI_NAME, parseInvocation, helpText, usageError } from './arguments.mjs';

const errors = {
  windows_network_unavailable: 'Windows direct/system networking is unavailable. Direct mode requires an active physical IPv4 uplink and DNS. Check the network or choose --proxy system / --proxy <url>.',
  windows_network_timeout: 'Windows network initialization timed out. Check the network or choose --proxy system / --proxy <url>.',
  system_proxy_pac_unsupported: 'macOS PAC is not supported by this bridge. Use --proxy <url> to select an explicit proxy.',
  legacy_bridge_running: '旧桥仍在运行，请先在原终端按 Ctrl+C；登录及待发队列会在下次启动时自动导入。',
  service_already_running: '这个平台已在运行，请先停止原进程。',
  credentials_required_noninteractive: `首次配置需要交互终端，请单独运行 ${CLI_NAME} start <platform>。`,
  no_configured_bridges: `尚无可启动的已配置平台。用 ${CLI_NAME} status 查看状态，首次使用请单独启动一个平台。`,
};
export function reportError(error) {
  if (error?.name === 'AbortError') return;
  const message = error?.userMessage || errors[error?.message] || (/^[a-z0-9_]+$/i.test(error?.message || '') ? error.message : 'bridge_failed');
  console.error(`${CLI_NAME}: error: ${message}`);
  process.exitCode = error?.exitCode === 2 ? 2 : 1;
  if (process.exitCode === 2) console.error(`运行 '${CLI_NAME} --help' 查看用法。`);
}
async function choosePlatform(command, interactive) {
  if (!interactive) throw usageError('platform_required', `请指定平台，例如 ${CLI_NAME} ${command} feishu。`);
  const choices = bridges.filter(b => b.commands.includes(command));
  console.log(choices.map((bridge, index) => `${index + 1}. ${bridge.name}`).join('\n') + (command === 'start' ? '\nall. 全部已配置平台' : '') + '\n0. 返回');
  const terminal = terminalAsk();
  let selected;
  try { selected = (await terminal.ask('选择平台：')).trim(); } finally { terminal.close(); }
  if (!selected || selected === '0') return;
  return choices[Number(selected) - 1]?.id || selected;
}
async function startAll(network) {
  const configured = [];
  for (const bridge of bridges) {
    const root = await prepareData(bridge), state = await configurationState(bridge, root);
    if (state.configured && !state.running) configured.push({ bridge, root });
    else console.log(`${bridge.name}：${state.running ? '已运行，跳过' : '尚未配置，先单独启动此平台'}`);
  }
  if (!configured.length) throw Error('no_configured_bridges');
  await Promise.all(configured.map(async ({ bridge, root }) => {
    try { const adapter = await bridge.load(); await adapter.main('start', { root, interactive: false, args: [], network }); }
    catch (error) { if (error.name !== 'AbortError') { console.error(`${bridge.name}服务停止。`); reportError(error); } }
  }));
}
export async function main(args = process.argv.slice(2)) {
  const invocation = parseInvocation(args);
  if (invocation.action === 'help') { console.log(helpText(invocation.command)); return; }
  if (invocation.action === 'version') {
    const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    console.log(version); return;
  }
  const { command, json } = invocation;
  if (command === 'status') {
    const selected = bridges.filter(bridge => !invocation.platform || bridge.id === invocation.platform), states = [];
    for (const bridge of selected) {
      const state = await configurationState(bridge, dataDirectory(bridge));
      states.push({ platform: bridge.id, ...state });
      if (!json) console.log(`${bridge.name}：${state.running ? '正在运行' : '已停止'}，${state.configured ? '已配置' : '待配置'}，回复端口 ${state.port}`);
    }
    if (json) console.log(JSON.stringify({ bridges: states }));
    return;
  }
  if (invocation.all) return startAll(invocation.network);
  const interactive = invocation.interactive && !!process.stdin.isTTY;
  const platform = invocation.platform || await choosePlatform(command, interactive);
  if (!platform) return;
  if (platform === 'all' && command === 'start') return startAll(invocation.network);
  const bridge = bridges.find(item => item.id === platform);
  if (!bridge) throw usageError('unknown_platform', '请选择列表中的平台。');
  if (!bridge.commands.includes(command)) throw usageError('unsupported_command', '该平台不支持此命令。');
  const root = await prepareData(bridge), adapter = await bridge.load();
  await adapter.main(command, { root, args: invocation.args, interactive, network: invocation.network });
}
