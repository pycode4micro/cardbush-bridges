import { randomBytes, createHash, createCipheriv } from 'node:crypto';
import { CDN_BASE, MAX_MEDIA_BYTES, cdnUrl, downloadMedia, mediaType } from './media.mjs';

export const API_BASE = 'https://ilinkai.weixin.qq.com';
// Wire compatibility reference: Tencent/openclaw-weixin 874637a, protocol 2.4.10.
// This module is an independent implementation; no OpenClaw imports or process calls.
const VERSION = '2.4.10';
export function apiBase(value) {
  const url = new URL(value.includes('://') ? value : 'https://' + value);
  if (url.protocol !== 'https:' || !(url.hostname === 'weixin.qq.com' || url.hostname.endsWith('.weixin.qq.com'))
    || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/') throw Error('untrusted_weixin_host');
  return url.origin;
}
export class WeixinApi {
  constructor(account = {}, fetcher = fetch) { this.account = account; this.fetch = fetcher; this.base = apiBase(account.baseUrl || API_BASE); }
  async request(path, body, { signal, timeout = 40000, authenticated = true, base = this.base } = {}) {
    const headers = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String((2 << 16) | (4 << 8) | 10) };
    if (body !== undefined) {
      Object.assign(headers, { 'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token',
        'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64') });
      if (authenticated) {
        if (!this.account.token) throw Error('login_required');
        headers.Authorization = 'Bearer ' + this.account.token;
        body = { ...body, base_info: { channel_version: VERSION, bot_agent: 'CardbushWeixinBridge/0.4.0' } };
      }
    }
    const response = await this.fetch(new URL(path, apiBase(base) + '/'), { method: body === undefined ? 'GET' : 'POST',
      redirect: 'error', headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) });
    if (!response.ok) { await response.body?.cancel(); throw Error('weixin_http_' + response.status); }
    // message_id is uint64. Preserve the source digits instead of rounded JS numbers.
    const result = JSON.parse((await response.text()) || '{}', (key, value, context) => key === 'message_id' && typeof value === 'number'
      ? context?.source ?? (Number.isSafeInteger(value) ? String(value) : (() => { throw Error('unsafe_message_id'); })()) : value);
    if (result.ret || result.errcode) throw Error(result.ret === -14 || result.errcode === -14 ? 'login_expired' : 'weixin_error_' + (result.errcode || result.ret));
    return result;
  }
  qr(signal) { return this.request('ilink/bot/get_bot_qrcode?bot_type=3', { local_token_list: [] }, { authenticated: false, timeout: 15000, signal }); }
  qrStatus(qrcode, base, verifyCode, signal) {
    const query = new URLSearchParams({ qrcode, ...(verifyCode ? { verify_code: verifyCode } : {}) });
    return this.request('ilink/bot/get_qrcode_status?' + query, undefined, { authenticated: false, base, signal });
  }
  updates(cursor, signal) { return this.request('ilink/bot/getupdates', { get_updates_buf: cursor }, { signal }); }
  async getConfig(user, context, signal) {
    const result = await this.request('ilink/bot/getconfig', { ilink_user_id: user, ...(context ? { context_token: context } : {}) }, { signal, timeout: 5000 });
    if (result.ret !== 0) throw Error('weixin_config_unavailable');
    return result;
  }
  sendTyping(user, ticket, status, signal) {
    if (!ticket || ![1, 2].includes(status)) throw Error('invalid_typing_status');
    return this.request('ilink/bot/sendtyping', { ilink_user_id: user, typing_ticket: ticket, status }, { signal, timeout: 5000 });
  }
  notifyStart(signal) { return this.request('ilink/bot/msg/notifystart', {}, { signal, timeout: 5000 }); }
  notifyStop(signal) { return this.request('ilink/bot/msg/notifystop', {}, { signal, timeout: 3000 }); }
  download(attachment, signal) { return downloadMedia(attachment, this.fetch, signal); }
  send(to, context, text, id, signal) {
    if (!context) throw Error('context_token_missing');
    return this.request('ilink/bot/sendmessage', { msg: { from_user_id: '', to_user_id: to, client_id: id, message_type: 2, message_state: 2,
      context_token: context, item_list: [{ type: 1, text_item: { text } }] } }, { signal, timeout: 15000 });
  }
  async prepareMedia(to, file, kind = 'file', signal) {
    if (!Buffer.isBuffer(file.bytes) || file.bytes.length > MAX_MEDIA_BYTES || !['file', 'image', 'video'].includes(kind)) throw Error('invalid_file');
    if (kind !== 'file' && mediaType(file.bytes).kind !== kind) throw Error('media_type_mismatch');
    const key = randomBytes(16), filekey = randomBytes(16).toString('hex');
    const cipher = createCipheriv('aes-128-ecb', key, null);
    const encrypted = Buffer.concat([cipher.update(file.bytes), cipher.final()]);
    // Independent implementation of Tencent's documented iLink media wire protocol.
    // https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md
    const upload = await this.request('ilink/bot/getuploadurl', { filekey, media_type: { image: 1, video: 2, file: 3 }[kind], to_user_id: to,
      rawsize: file.bytes.length, rawfilemd5: createHash('md5').update(file.bytes).digest('hex'),
      filesize: encrypted.length, no_need_thumb: true, aeskey: key.toString('hex') }, { signal });
    if (!upload.upload_full_url && !upload.upload_param) throw Error('upload_url_missing');
    let url; try { url = cdnUrl(upload.upload_full_url || CDN_BASE + 'upload?' + new URLSearchParams({ encrypted_query_param: upload.upload_param, filekey })); }
    catch { throw Error('untrusted_upload_host'); }
    const response = await this.fetch(url, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/octet-stream' },
      body: encrypted, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000) });
    const parameter = response.headers.get('x-encrypted-param'); await response.body?.cancel();
    if (response.status !== 200 || !parameter) throw Error('file_upload_failed');
    const media = { encrypt_query_param: parameter, aes_key: Buffer.from(key.toString('hex')).toString('base64'), encrypt_type: 1 };
    return kind === 'image' ? { type: 2, image_item: { media, mid_size: encrypted.length } }
      : kind === 'video' ? { type: 5, video_item: { media, video_size: encrypted.length } }
        : { type: 4, file_item: { file_name: file.name, len: String(file.bytes.length), media } };
  }
  sendPrepared(to, context, item, id, signal) {
    if (!context) throw Error('context_token_missing');
    return this.request('ilink/bot/sendmessage', { msg: { from_user_id: '', to_user_id: to, client_id: id,
      message_type: 2, message_state: 2, context_token: context, item_list: [item] } }, { signal, timeout: 15000 });
  }
  async sendMedia(to, context, file, id, kind, signal) {
    if (!context) throw Error('context_token_missing');
    return this.sendPrepared(to, context, await this.prepareMedia(to, file, kind, signal), id, signal);
  }
  sendFile(to, context, file, id, signal) { return this.sendMedia(to, context, file, id, 'file', signal); }
  sendImage(to, context, file, id, signal) { return this.sendMedia(to, context, file, id, 'image', signal); }
  sendVideo(to, context, file, id, signal) { return this.sendMedia(to, context, file, id, 'video', signal); }
}
