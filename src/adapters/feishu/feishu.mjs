import { credentials } from './config.mjs';

export const MAX_FILE_BYTES = 30_000_000;
export const MAX_TOTAL_BYTES = 120_000_000;
const BASE = 'https://open.feishu.cn';
export class FeishuApi {
  constructor(config, fetcher = fetch) { this.config = credentials(config); this.fetch = fetcher; }
  async json(path, options = {}, signal) {
    const response = await this.fetch(BASE + path, { ...options, redirect: 'error', signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60000)]) });
    if (!response.ok) { await response.body?.cancel(); throw Error('feishu_http_' + response.status); }
    const value = await response.json();
    if (value.code !== 0) throw Error('feishu_error_' + (Number.isInteger(value.code) ? value.code : 'invalid_response'));
    return value;
  }
  async token(signal) {
    if (this.cached && this.cached.expiresAt > Date.now()) return this.cached.value;
    if (!this.loading) this.loading = (async () => {
      const result = await this.json('/open-apis/auth/v3/tenant_access_token/internal', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: this.config.appId, app_secret: this.config.appSecret }) }, signal);
      if (typeof result.tenant_access_token !== 'string' || !result.tenant_access_token || !Number.isFinite(result.expire)) throw Error('feishu_invalid_token');
      this.cached = { value: result.tenant_access_token, expiresAt: Date.now() + Math.max(1, result.expire - 60) * 1000 };
      return this.cached.value;
    })().finally(() => { this.loading = undefined; });
    return this.loading;
  }
  async request(path, data, signal) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = { Authorization: 'Bearer ' + await this.token(signal) };
      const form = data instanceof FormData;
      if (data !== undefined && !form) headers['Content-Type'] = 'application/json';
      try { return await this.json('/open-apis' + path, { method: data === undefined ? 'GET' : 'POST', headers, body: data === undefined ? undefined : form ? data : JSON.stringify(data) }, signal); }
      catch (error) { if (!attempt && ['feishu_http_401', 'feishu_error_99991663', 'feishu_error_99991664'].includes(error.message)) { this.cached = undefined; continue; } throw error; }
    }
  }
  async identity(signal) {
    const result = await this.request('/bot/v3/info', undefined, signal), bot = result.bot ?? result.data?.bot;
    if (typeof bot?.open_id !== 'string' || !bot.open_id) throw Error('feishu_bot_not_enabled');
    return { openId: bot.open_id, name: bot.app_name || '飞书服务' };
  }
  async send(chatId, type, content, id, signal) {
    if (typeof chatId !== 'string' || !chatId.startsWith('oc_')) throw Error('invalid_chat_id');
    const result = await this.request('/im/v1/messages?receive_id_type=chat_id', { receive_id: chatId, msg_type: type, content: JSON.stringify(content), uuid: id }, signal);
    if (!result.data?.message_id) throw Error('feishu_message_receipt_missing');
    return result.data.message_id;
  }
  text(chatId, text, id, signal) { return this.send(chatId, 'text', { text }, id, signal); }
  async upload(file, signal) {
    if (!Buffer.isBuffer(file.bytes) || !file.bytes.length || file.bytes.length > MAX_FILE_BYTES) throw Error('invalid_file_size');
    const form = new FormData(); form.set('file_type', 'stream'); form.set('file_name', file.name);
    form.set('file', new Blob([file.bytes], { type: file.mimeType || 'application/octet-stream' }), file.name);
    const result = await this.request('/im/v1/files', form, signal);
    if (typeof result.data?.file_key !== 'string' || !result.data.file_key) throw Error('feishu_file_key_missing');
    return result.data.file_key;
  }
  file(chatId, fileKey, id, signal) { return this.send(chatId, 'file', { file_key: fileKey }, id, signal); }
}
