import { parseArgs } from 'node:util';
import { bridges } from './registry.mjs';

export const CLI_NAME = 'cardbush-bridge';
const descriptions = {
  start: '启动平台桥服务；不指定平台时进入选择菜单',
  connect: '重新绑定 Cardbush 会话',
  setup: '配置平台账号或高级连接参数',
  login: '重新登录平台账号',
  doctor: '检查平台鉴权和配置',
  status: '查看本机状态，不启动服务',
  init: '生成高级连接配置',
  'login-start': '生成微信登录二维码',
  'login-check': '检查微信扫码结果',
};
export function usageError(code, message) {
  return Object.assign(new Error(code), { exitCode: 2, userMessage: message });
}
export function helpText(command) {
  if (command) {
    const usage = command === 'status' ? '[platform] [--json]' : command === 'start' ? '[platform] [--all] [--no-interactive]'
      : command === 'login-check' ? '<platform> [verification-code]' : '<platform> [--no-interactive]';
    const platforms = bridges.filter(b => command === 'status' || b.commands.includes(command)).map(b => b.id).join(', ');
    return `Usage: ${CLI_NAME} ${command} ${usage}\n\n${descriptions[command] || command}\n\nPlatforms: ${platforms}\n\nOptions:\n  -h, --help          显示帮助\n${command === 'start' ? '  --all               同时启动所有已配置平台\n' : ''}${command === 'status' ? '  --json              输出 JSON\n' : '  --no-interactive    不询问终端输入，使用已保存或环境变量配置\n'}`;
  }
  return `Usage: ${CLI_NAME} <command> [platform] [options]

Commands:
  start [platform]    启动桥服务；省略平台时选择
  connect <platform>  重新绑定 Cardbush 会话
  setup <platform>    配置账号或高级连接参数
  login <platform>    重新登录（微信）
  doctor <platform>   检查鉴权和配置（飞书）
  status [platform]   查看本机状态，不启动服务
  help [command]     查看命令帮助

Platforms:
${bridges.map(b => `  ${b.id.padEnd(19)} ${b.name}`).join('\n')}

Options:
  -h, --help          显示帮助
  -v, --version       显示版本
  --all               start：启动所有已配置平台
  --json              status：输出 JSON
  --no-interactive    不询问终端输入

Examples:
  ${CLI_NAME} start feishu
  ${CLI_NAME} start weixin
  ${CLI_NAME} start --all
  ${CLI_NAME} connect feishu
  ${CLI_NAME} status --json

Ctrl+C 停止本次启动的服务。`;
}

/** Parse and validate everything before touching configuration or starting a service. */
export function parseInvocation(args) {
  let parsed;
  try { parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
    all: { type: 'boolean' }, json: { type: 'boolean' }, 'no-interactive': { type: 'boolean' },
  } }); } catch { throw usageError('invalid_option', `未知选项或选项格式错误。用 ${CLI_NAME} --help 查看支持的参数。`); }
  const { values } = parsed;
  let [command, platform, ...rest] = parsed.positionals;
  const requestedHelp = values.help || command === 'help';
  if (command === 'help') { [command, platform, ...rest] = parsed.positionals.slice(1); }
  if (values.version) {
    if (parsed.positionals.length || Object.keys(values).length !== 1) throw usageError('invalid_version_usage', `用 ${CLI_NAME} --version 查看版本。`);
    return { action: 'version' };
  }
  if (!command) {
    if (Object.keys(values).some(key => key !== 'help')) throw usageError('command_required', `请指定命令，例如 ${CLI_NAME} start feishu。`);
    return { action: 'help' };
  }
  const known = command === 'status' || bridges.some(b => b.commands.includes(command));
  if (!known) throw usageError('unknown_command', '未知命令。');
  if (values.all && command !== 'start') throw usageError('invalid_all_usage', '--all 只用于 start 命令。');
  if (values.json && command !== 'status') throw usageError('invalid_json_usage', '--json 只用于 status 命令。');
  if (platform === 'all' && command === 'start') { values.all = true; platform = undefined; }
  if (values.all && platform) throw usageError('conflicting_platform', '不能同时指定一个平台和 --all。');
  if (platform) {
    const bridge = bridges.find(b => b.id === platform);
    if (!bridge) throw usageError('unknown_platform', `未知平台。支持：${bridges.map(b => b.id).join(', ')}。`);
    if (command !== 'status' && !bridge.commands.includes(command)) throw usageError('unsupported_command', '该平台不支持此命令。');
  }
  if (rest.length > (command === 'login-check' ? 1 : 0)) throw usageError('unexpected_argument', '位置参数过多。');
  if (requestedHelp) return { action: 'help', command };
  return { action: 'run', command, platform, args: rest, all: !!values.all, json: !!values.json, interactive: !values['no-interactive'] };
}
