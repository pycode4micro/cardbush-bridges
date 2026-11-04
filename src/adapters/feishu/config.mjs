export { normalizeCardbushUrl, validateConfig } from '../../shared/config.mjs';
export function credentials(value) {
  if (!/^cli_[a-zA-Z0-9]+$/.test(value?.appId ?? '')) throw Error('invalid_app_id');
  if (typeof value.appSecret !== 'string' || value.appSecret.trim().length < 8 || /\s/.test(value.appSecret)) throw Error('invalid_app_secret');
  return { appId: value.appId, appSecret: value.appSecret };
}
export async function configure(previous, { ask, env = process.env }) {
  const input = { appId: env.FEISHU_APP_ID || previous?.appId, appSecret: env.FEISHU_APP_SECRET || previous?.appSecret };
  if (!input.appId) input.appId = (await ask('飞书 App ID：')).trim();
  if (!input.appSecret) input.appSecret = (await ask('飞书 App Secret（输入不显示）：', true)).trim();
  return credentials(input);
}
