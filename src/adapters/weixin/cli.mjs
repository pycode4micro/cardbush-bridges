import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createInterface } from 'node:readline/promises';
import QRCode from 'qrcode';
import { privateDirectory, readJson, writeJson, acquireLock } from '../../shared/storage.mjs';
import { WeixinApi, API_BASE, apiBase } from './weixin.mjs';
import { Bridge } from './bridge.mjs';
import { configure, configurationError } from './config.mjs';
import { connectBridge } from '../../shared/connect.mjs';

export async function main(command = 'start', { root: directory, args = [], interactive = !!process.stdin.isTTY } = {}) {
const root = await privateDirectory(resolve(directory));
const file = name => join(root, name + '.json');
const release = await acquireLock(root), cancel = new AbortController(); let bridge;
const stop = () => { cancel.abort(); bridge?.abort.abort(); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
async function init() {
  const config = await readJson(file('config'), { cardbush: { url: '', token: '' }, port: 4792, callbackToken: randomBytes(32).toString('hex') });
  await writeJson(file('config'), config);
  await writeJson(file('cardbush-connection'), { url: `http://127.0.0.1:${config.port}/reply`, headers: { Authorization: 'Bearer ' + config.callbackToken } });
  return config;
}
async function loginStart(signal) {
  const qr = await new WeixinApi().qr(signal);
  if (!qr.qrcode || !qr.qrcode_img_content) throw Error('qrcode_missing');
  await writeJson(file('login'), { qrcode: qr.qrcode, base: API_BASE, createdAt: Date.now() });
  await QRCode.toFile(join(root, 'login.png'), qr.qrcode_img_content, { width: 420, margin: 3 });
  console.log('请用微信扫描二维码：' + join(root, 'login.png'));
  console.log(await QRCode.toString(qr.qrcode_img_content, { type: 'terminal', small: true }));
}
async function loginCheck(verifyCode, signal) {
  const login = await readJson(file('login'));
  if (Date.now() - login.createdAt > 300000) throw Error('qr_expired');
  const result = await new WeixinApi().qrStatus(login.qrcode, login.base, verifyCode, signal);
  if (result.status === 'scaned_but_redirect' && result.redirect_host) { login.base = apiBase(result.redirect_host); await writeJson(file('login'), login); }
  if (result.status === 'confirmed') {
    if (![result.bot_token, result.ilink_bot_id, result.ilink_user_id].every(s => typeof s === 'string' && s)) throw Error('incomplete_login');
    await writeJson(file('account'), { id: result.ilink_bot_id, userId: result.ilink_user_id, token: result.bot_token, baseUrl: apiBase(result.baseurl || login.base) });
    console.log('微信登录成功，凭据仅保存在本机私有目录。');
  } else console.log('微信扫码状态：' + result.status);
  if (['expired', 'verify_code_blocked', 'binded_redirect'].includes(result.status)) throw Error('qr_' + result.status);
  return result.status;
}
async function login(signal) {
  await loginStart(signal); let status;
  do {
    let verifyCode;
    if (status === 'need_verifycode') { if (!interactive) throw Error('credentials_required_noninteractive');
      const input = createInterface({ input: process.stdin, output: process.stdout });
      try { verifyCode = await input.question('请输入微信显示的验证码：', { signal }); } finally { input.close(); } }
    try { status = await loginCheck(verifyCode, signal); } catch (e) { if (e.name !== 'TimeoutError') throw e; }
    if (status !== 'confirmed') await delay(1000, undefined, { signal });
  } while (status !== 'confirmed');
}
async function connect(config, signal, force = false) {
  return connectBridge(config, { root, name: '微信服务', signal, force });
}
try {
  if (command === 'init') { await init(); console.log('配置文件：' + file('config')); console.log('Cardbush 回复地址和请求头：' + file('cardbush-connection')); }
  else if (command === 'setup') {
    const config = await init(), input = createInterface({ input: process.stdin, output: process.stdout });
    try { const next = await configure(config, { ask: prompt => input.question(prompt, { signal: cancel.signal }), notify: message => console.error(message) });
      await writeJson(file('config'), next); console.log('配置已保存。现在运行 npm start -- weixin 启动微信服务。'); } finally { input.close(); }
  } else if (command === 'login' || command === 'login-start') {
    // Every user-facing login entry first registers the same generic local service.
    // A QR-only flow otherwise leaves the desktop connection list empty.
    await connect(await init(), cancel.signal);
    if (command === 'login') { await login(cancel.signal); console.log('登录已完成。运行 npm start -- weixin 保持服务在线。'); }
    else await loginStart(cancel.signal);
  } else if (command === 'login-check') await loginCheck(args[0], cancel.signal);
  else if (command === 'connect') await connect(await init(), cancel.signal, true);
  else if (command === 'start') {
      const config = await connect(await init(), cancel.signal);
      if (!await readJson(file('account'), null)) await login(cancel.signal);
      const account = await readJson(file('account'));
      bridge = await new Bridge(root, config, account, new WeixinApi(account)).load();
      await bridge.run();
  } else console.log('Commands: start | connect | init | setup | login | login-start | login-check [verification-code]');
} catch (error) { if (error.name !== 'AbortError') {
  const connectionError = { unsupported_cardbush: '当前 Cardbush 尚不支持自动接入，请启动更新后的版本。',
    connection_revoked: '连接已被停用或移除。需要重新连接时运行 npm run connect，在 Cardbush 中重新选择会话。',
    connection_rejected: '连接请求已被忽略。需要重新申请时运行 npm run connect。',
    pairing_expired: '等待连接已超时。请打开 Cardbush 后重新运行 npm start。' }[error.message];
  error.userMessage = connectionError || configurationError(error); throw error;
} } finally { stop(); await bridge?.close(); await release(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
