import { createServer } from 'node:http';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { readJson, writeJson } from '../../shared/storage.mjs';
import { validateConfig } from './config.mjs';
import { localServiceFetch } from '../../shared/local-http.mjs';
import { readBotCallback, validateBotSend, digest } from '../../shared/bot-outbound.mjs';
import { normalizeMessage } from './events.mjs';
import { MAX_FILE_BYTES, MAX_TOTAL_BYTES } from './feishu.mjs';
import { createPlugins } from './plugins.mjs';
import { bridgeInstance, advertisePlugins, withdrawPlugins, invokePlugin } from '../../shared/plugins.mjs';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const sendId = value => hash(value).slice(0, 32);
export const safeError = error => /^[a-z0-9_]+$/i.test(error?.message ?? '') ? error.message : 'connection_failed';
export function splitText(text, limit = 12000) {
  const parts = []; let part = '', size = 0;
  for (const char of text) { const bytes = Buffer.byteLength(JSON.stringify(char)) - 2; if (size + bytes > limit) { parts.push(part); part = ''; size = 0; } part += char; size += bytes; }
  if (part) parts.push(part); return parts;
}
export class Bridge {
  constructor(root, config, api, { fetcher = localServiceFetch, log = console.log, botOpenId = '', now = Date.now } = {}) {
    this.root = root; this.config = validateConfig(config); this.api = api; this.fetch = fetcher; this.log = log; this.botOpenId = botOpenId; this.now = now;
    this.state = { version: 1, appId: config.feishu.appId, records: [], outbound: [] };
    this.writes = Promise.resolve(); this.abort = new AbortController(); this.ready = false;
    this.instanceId = bridgeInstance(); this.plugins = createPlugins(this);
  }
  async load() {
    this.state = await readJson(join(this.root, 'queue.json'), this.state);
    if (this.state.version !== 1 || !Array.isArray(this.state.records) || !Array.isArray(this.state.outbound)) throw Error('invalid_queue');
    if (this.state.appId !== this.config.feishu.appId) throw Error('queue_app_mismatch');
    return this;
  }
  write(change) {
    const result = this.writes.then(async () => { const next = structuredClone(this.state); const value = await change(next);
      await writeJson(join(this.root, 'queue.json'), next); this.state = next; return value; });
    this.writes = result.catch(() => {}); return result;
  }
  pairingCode() {
    if (this.state.owner || this.config.allowedSenders?.length) return;
    if (!this.pair || this.pair.expiresAt <= this.now()) this.pair = { code: String(randomInt(10_000_000, 100_000_000)), expiresAt: this.now() + 600000 };
    return this.pair.code;
  }
  async ingest(event) {
    const message = normalizeMessage(event, this.botOpenId, this.config.allowedChats);
    if (!message) return { ignored: true };
    return this.write(state => {
      const id = 'feishu-' + hash(state.appId + ':' + message.id);
      if (state.records.some(r => r.id === id)) return { duplicate: true };
      const allowed = this.config.allowedSenders?.length ? this.config.allowedSenders : state.owner ? [state.owner] : [];
      let notice;
      if (!allowed.includes(message.senderId)) {
        if (allowed.length || message.chatType !== 'p2p' || !this.pair || this.pair.expiresAt <= this.now() || message.text !== '连接 ' + this.pair.code) return { ignored: true };
        state.owner = message.senderId;
        notice = '已连接你的 Cardbush。现在可以发消息，也可以让我把生成的文件发回来。';
      } else if (message.unsupported) notice = '目前接收文字和富文本消息。图片、语音及文件暂不自动读取；可以要求 Agent 把本机文件发送给你。';
      if (state.records.filter(r => !r.terminal).length >= 256) throw Error('inbox_full');
      state.records.push({ ...message, id, originalMessageId: message.id, text: notice ? '' : message.text, accepted: !!notice, terminal: !!notice,
        sequence: 0, deliveredText: '', ...(notice ? { outgoing: { sequence: 0, text: notice, parts: splitText(notice), sent: 0 } } : {}) });
      return { accepted: true, ...(notice && !message.unsupported ? { paired: true } : {}) };
    });
  }
  async cardbush(record, query = false) {
    const response = await this.fetch(this.config.cardbush.url + (query ? '/' + encodeURIComponent(record.id) : ''), {
      method: query ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15000)]),
      headers: { Authorization: 'Bearer ' + this.config.cardbush.token, 'Content-Type': 'application/json' },
      body: query ? undefined : JSON.stringify({ messageId: record.id, senderId: record.senderId, conversationId: record.conversationId, text: record.text }),
    });
    if (!response.ok) { await response.body?.cancel(); throw Error('cardbush_http_' + response.status); }
    const result = await response.json();
    if (result.protocol !== 'cardbush.webhook.v1' || result.messageId !== record.id) throw Error('receipt_mismatch');
    return result;
  }
  async receive(event, files = []) {
    if (event.protocol !== 'cardbush.webhook.v1') throw Error('invalid_protocol');
    if (event.type === 'connection.test') return;
    if (event.type === 'tool.call') return invokePlugin(this, event, files);
    if (event.type === 'message.send') return this.receiveSend(event, files);
    if (!['message.updated', 'message.completed'].includes(event.type) || !Number.isSafeInteger(event.sequence) || event.sequence < 1
      || typeof event.reply !== 'string' || event.reply.length > 128000 || !['completed', 'failed', 'stopped', 'interrupted', 'accepted', 'running'].includes(event.status)) throw Error('invalid_receipt');
    await this.write(state => {
      const record = state.records.find(r => r.id === event.messageId);
      if (!record || record.senderId !== event.senderId || record.conversationId !== event.conversationId) throw Error('unknown_message');
      if (event.sequence <= record.sequence || ['accepted', 'running'].includes(event.status)) return;
      record.next = { sequence: event.sequence, text: event.reply || 'Cardbush 未完成本次处理，请在应用中查看该会话并重试。' };
      record.sequence = event.sequence; record.accepted = true; record.terminal = true;
    });
  }
  outboundFile(eventId, index) { return join(this.root, 'outbound-files', hash(eventId) + '-' + index); }
  async receiveSend(event, files) {
    validateBotSend(event, files);
    if (files.some(file => !file.length || file.length > MAX_FILE_BYTES) || files.reduce((total, file) => total + file.length, 0) > MAX_TOTAL_BYTES) throw Error('file_size_unsupported');
    const fingerprint = digest(JSON.stringify({ messageId: event.messageId, senderId: event.senderId, conversationId: event.conversationId, text: event.text, files: event.files }));
    await this.write(async state => {
      const record = state.records.find(r => r.id === event.messageId);
      if (!record || record.senderId !== event.senderId || record.conversationId !== event.conversationId) throw Error('unknown_message');
      const prior = state.outbound.find(item => item.eventId === event.eventId);
      if (prior) { if (prior.fingerprint !== fingerprint) throw Error('event_id_conflict'); return; }
      if (state.outbound.filter(item => !item.done).length >= 128) throw Error('outbound_queue_full');
      await mkdir(join(this.root, 'outbound-files'), { recursive: true, mode: 0o700 });
      for (const [index, bytes] of files.entries()) {
        const path = this.outboundFile(event.eventId, index);
        try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600, flush: true }); }
        catch (error) { if (error.code !== 'EEXIST' || digest(await readFile(path)) !== event.files[index].sha256) throw error; }
      }
      state.outbound.push({ eventId: event.eventId, fingerprint, messageId: event.messageId, parts: splitText(event.text), files: event.files,
        uploaded: {}, textSent: 0, filesSent: 0, done: false });
    });
    return { protocol: 'cardbush.webhook.v1', eventId: event.eventId, status: 'accepted' };
  }
  async advertise() {
    return advertisePlugins(this, { text: true, files: true, maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_TOTAL_BYTES });
  }
  async sendOutbound() {
    for (const item of this.state.outbound.filter(item => !item.done)) {
      if (this.abort.signal.aborted) return;
      try {
        const record = this.state.records.find(r => r.id === item.messageId);
        if (!record) throw Error('unknown_message');
        for (let index = item.textSent; index < item.parts.length; index++) {
          await this.api.text(record.conversationId, item.parts[index], sendId(item.eventId + ':text:' + index), this.abort.signal);
          await this.write(state => { state.outbound.find(o => o.eventId === item.eventId).textSent = index + 1; });
        }
        for (let index = item.filesSent; index < item.files.length; index++) {
          const file = item.files[index]; let key = item.uploaded[index];
          if (!key) {
            const bytes = await readFile(this.outboundFile(item.eventId, index));
            if (bytes.length !== file.size || digest(bytes) !== file.sha256) throw Error('outbound_file_changed');
            key = await this.api.upload({ ...file, bytes }, this.abort.signal);
            await this.write(state => { state.outbound.find(o => o.eventId === item.eventId).uploaded[index] = key; });
          }
          await this.api.file(record.conversationId, key, sendId(item.eventId + ':file:' + index), this.abort.signal);
          await this.write(state => { state.outbound.find(o => o.eventId === item.eventId).filesSent = index + 1; });
        }
        await this.write(state => { state.outbound.find(o => o.eventId === item.eventId).done = true; });
        for (let i = 0; i < item.files.length; i++) await unlink(this.outboundFile(item.eventId, i)).catch(() => {});
      } catch (error) { if (!this.abort.signal.aborted) this.log('文件发送等待重试：' + safeError(error)); }
    }
  }
  processOnce() {
    return this.processing ??= this.processRecords().finally(() => { this.processing = undefined; });
  }
  async processRecords() {
    for (const record of this.state.records) {
      if (this.abort.signal.aborted) return;
      try {
        if (this.ready && !record.accepted) {
          const result = await this.cardbush(record); await this.write(state => { state.records.find(r => r.id === record.id).accepted = true; }); await this.receive(result);
        }
        let current = this.state.records.find(r => r.id === record.id);
        if (this.ready && current.accepted && !current.terminal) await this.receive(await this.cardbush(current, true));
        current = this.state.records.find(r => r.id === record.id);
        if (!current.outgoing && current.next) await this.write(state => {
          const r = state.records.find(r => r.id === record.id), next = r.next; delete r.next;
          const text = next.text.startsWith(r.deliveredText) ? next.text.slice(r.deliveredText.length).trim() : next.text;
          r.outgoing = { ...next, parts: splitText(text), sent: 0 };
        });
        current = this.state.records.find(r => r.id === record.id);
        if (current.outgoing) {
          const out = current.outgoing;
          for (let i = out.sent; i < out.parts.length; i++) {
            await this.api.text(current.conversationId, out.parts[i], sendId(current.id + ':' + out.sequence + ':' + i), this.abort.signal);
            await this.write(state => { state.records.find(r => r.id === record.id).outgoing.sent = i + 1; });
          }
          await this.write(state => { const r = state.records.find(r => r.id === record.id); r.deliveredText = out.text; delete r.outgoing; });
        }
      } catch (error) { if (!this.abort.signal.aborted) this.log('消息等待重试：' + safeError(error)); }
    }
    await this.sendOutbound();
  }
  async listen(port = this.config.port) {
    this.server = createServer((req, res) => {
      const respond = (code, body) => { if (!res.destroyed) res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body)); };
      void (async () => {
        if (req.url !== '/reply' || req.method !== 'POST' || req.headers.origin !== undefined) { respond(404, {}); return; }
        const given = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from('Bearer ' + this.config.callbackToken);
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) { respond(401, {}); return; }
        const { event, files } = await readBotCallback(req);
        respond(202, await this.receive(event, files) ?? { accepted: true });
      })().catch(() => { respond(400, { error: 'invalid_callback' }); req.resume(); });
    });
    this.server.requestTimeout = 120000; this.server.headersTimeout = 10000;
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(port, '127.0.0.1', resolve); });
    return this.server.address().port;
  }
  async run() {
    const heartbeat = async () => { while (!this.abort.signal.aborted) {
      try { await this.advertise(); } catch (error) { if (!this.abort.signal.aborted) this.log('等待 Cardbush 服务：' + safeError(error)); }
      await delay(this.ready ? 15000 : 5000, null, { signal: this.abort.signal });
    } };
    const work = async () => { while (!this.abort.signal.aborted) { await this.processOnce(); await delay(1000, null, { signal: this.abort.signal }); } };
    try { await Promise.all([heartbeat(), work()]); }
    catch (error) { throw this.abort.signal.aborted ? this.abort.signal.reason : error; }
    finally { await this.close(); }
  }
  async close() {
    if (this.closing) return this.closing;
    return this.closing = (async () => { this.abort.abort(); await withdrawPlugins(this); if (this.server) { this.server.closeAllConnections(); await new Promise(r => this.server.close(r)); }
      await this.processing?.catch(() => {}); await this.writes; })();
  }
}
