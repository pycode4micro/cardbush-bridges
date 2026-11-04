export function normalizeCardbushUrl(input) {
  if (typeof input !== 'string' || !input.trim()) throw Error('cardbush_url_required');
  let value = input.trim();
  const link = /^\[[^\]\r\n]*\]\((https?:\/\/[^\s)]+)\)$/.exec(value);
  if (link) value = link[1];
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1).trim();
  let url;
  try { url = new URL(value); } catch { throw Error('invalid_cardbush_url'); }
  if (url.pathname.replace(/\/+$/, '') === '/reply') throw Error('cardbush_reply_url_used');
  if (url.protocol === 'http:' && url.hostname === '0.0.0.0') url.hostname = '127.0.0.1';
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!['https:', 'http:'].includes(url.protocol) || url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.hash || url.search || !/^\/api\/webhooks\/v1\/[\w-]+\/messages$/.test(url.pathname)) throw Error('invalid_cardbush_url');
  return url.href;
}
export function normalizeCardbushToken(input) {
  const token = typeof input === 'string' ? input.trim().replace(/^Bearer\s+/i, '') : '';
  if (token.length < 32 || /\s/.test(token)) throw Error('cardbush_token_required');
  return token;
}
export function validateConfig(config) {
  const url = normalizeCardbushUrl(config?.cardbush?.url), token = normalizeCardbushToken(config?.cardbush?.token);
  if (typeof config.callbackToken !== 'string' || config.callbackToken.length < 32 || /\s/.test(config.callbackToken)) throw Error('invalid_callback_token');
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw Error('invalid_port');
  for (const key of ['allowedSenders', 'allowedChats']) if (config[key] !== undefined && (!Array.isArray(config[key]) || !config[key].every(v => typeof v === 'string' && v.length > 0))) throw Error('invalid_access_list');
  return { ...config, cardbush: { ...config.cardbush, url, token } };
}
