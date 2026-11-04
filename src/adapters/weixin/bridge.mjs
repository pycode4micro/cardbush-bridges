import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { readJson, writeJson } from '../../shared/storage.mjs';
import { validateConfig } from './config.mjs';
import { localServiceFetch } from '../../shared/local-http.mjs';
import { readBotCallback, validateBotSend, digest, MAX_FILE_BYTES, MAX_TOTAL_BYTES } from '../../shared/bot-outbound.mjs';
export { validateConfig } from './config.mjs';

export const hash = value => createHash('sha256').update(value).digest('hex');
export function splitText(text, limit = 3500) {
  const chunks = []; let part = '', bytes = 0;
  for (const char of text) { const count = Buffer.byteLength(char); if (bytes + count > limit) { chunks.push(part); part = ''; bytes = 0; } part += char; bytes += count; }
  if (part) chunks.push(part); return chunks;
}
export class Bridge {
  constructor(root, config, account, api, { fetcher = localServiceFetch, log = console.log } = {}) {
    this.root = root; this.config = validateConfig(config); this.account = account; this.api = api; this.fetch = fetcher; this.log = log;
    this.state = { version: 1, cursor: '', records: [], outbound: [] }; this.writes = Promise.resolve(); this.abort = new AbortController();
  }
  async load() {
    this.state = await readJson(join(this.root, 'queue.json'), this.state);
    if (this.state.version !== 1 || !Array.isArray(this.state.records)) throw Error('invalid_queue');
    this.state.outbound ??= [];
    if (this.state.accountId && this.state.accountId !== this.account.id) throw Error('queue_account_mismatch');
    await this.write(state => { state.accountId = this.account.id; }); return this;
  }
  write(change) {
    const result = this.writes.then(async () => { const next = structuredClone(this.state); const value = await change(next);
      await writeJson(join(this.root, 'queue.json'), next); this.state = next; return value; });
    this.writes = result.catch(() => {}); return result;
  }
  async ingest(update) {
    const allowed = this.config.allowedSenders?.length ? this.config.allowedSenders : [this.account.userId];
    if (!allowed.every(id => typeof id === 'string' && id)) throw Error('allowed_sender_required');
    await this.write(state => {
      for (const message of update.msgs ?? []) {
        if (message.message_type !== 1 || message.message_state !== undefined && message.message_state !== 2
          || message.group_id || !allowed.includes(message.from_user_id)) continue;
        const originalId = message.message_id;
        if (!originalId || !message.context_token) continue;
        const id = 'weixin-' + hash(this.account.id + ':' + originalId);
        if (state.records.some(r => r.id === id)) continue;
        // Text and server-provided voice transcripts are supported; no media URL fetching.
        const text = (message.item_list ?? []).map(item => item.type === 1 ? item.text_item?.text : item.type === 3 ? item.voice_item?.text : '').filter(Boolean).join('\n').trim();
        const unsupported = !text || text.length > 32000;
        state.records.push({ id, sender: message.from_user_id, context: message.context_token, text, accepted: false, sequence: 0,
          deliveredText: '', createdAt: Date.now(), ...(unsupported ? { accepted: true, terminal: true,
            outgoing: { sequence: 0, text: '目前支持文字和微信已转写的语音，请转成文字后发送。', parts: ['目前支持文字和微信已转写的语音，请转成文字后发送。'], sent: 0 } } : {}) });
      }
      // Commit the inbox before advancing the cursor: a crash cannot drop an accepted batch.
      if (update.get_updates_buf) state.cursor = update.get_updates_buf;
    });
  }
  async cardbush(record, query = false) {
    const response = await this.fetch(this.config.cardbush.url + (query ? '/' + encodeURIComponent(record.id) : ''), {
      method: query ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15000)]),
      headers: { Authorization: 'Bearer ' + this.config.cardbush.token, 'Content-Type': 'application/json' },
      body: query ? undefined : JSON.stringify({ messageId: record.id, senderId: record.sender, conversationId: this.account.id + ':' + record.sender, text: record.text }),
    });
    if (!response.ok) { await response.body?.cancel(); throw Error('cardbush_http_' + response.status); }
    const event = await response.json();
    if (event.messageId !== record.id) throw Error('receipt_mismatch');
    return event;
  }
  async receive(event, files = []) {
    if (event.type === 'connection.test') return;
    if (event.type === 'message.send') return this.receiveSend(event, files);
    if (event.protocol !== 'cardbush.webhook.v1' || !Number.isSafeInteger(event.sequence) || event.sequence < 1
      || typeof event.reply !== 'string' || event.reply.length > 128000 || !['completed', 'failed', 'stopped', 'interrupted', 'accepted', 'running'].includes(event.status)) throw Error('invalid_receipt');
    await this.write(state => {
      const r = state.records.find(r => r.id === event.messageId);
      if (!r || event.senderId !== r.sender || event.conversationId !== this.account.id + ':' + r.sender) throw Error('unknown_message');
      if (event.sequence <= r.sequence) return;
      if (!['completed', 'failed', 'stopped', 'interrupted'].includes(event.status)) return;
      // Preserve an in-flight chunk list until it finishes. Latest snapshot is queued afterwards.
      r.next = { sequence: event.sequence, text: event.reply || 'Cardbush 未完成本次处理，请在应用内查看该会话。' };
      r.sequence = event.sequence; r.terminal = true; r.accepted = true;
    });
  }
  outboundFile(eventId, index) { return join(this.root, 'outbound-files', hash(eventId) + '-' + index); }
  async receiveSend(event, files) {
    validateBotSend(event, files);
    const fingerprint = digest(JSON.stringify({ messageId: event.messageId, senderId: event.senderId, conversationId: event.conversationId, text: event.text, files: event.files }));
    await this.write(async state => {
      const record = state.records.find(r => r.id === event.messageId);
      if (!record || record.sender !== event.senderId || event.conversationId !== this.account.id + ':' + record.sender) throw Error('unknown_message');
      const existing = state.outbound.find(item => item.eventId === event.eventId);
      if (existing) { if (existing.fingerprint !== fingerprint) throw Error('event_id_conflict'); return; }
      if (state.outbound.filter(item => !item.done).length >= 128) throw Error('outbound_queue_full');
      await mkdir(join(this.root, 'outbound-files'), { recursive: true, mode: 0o700 });
      for (const [index, bytes] of files.entries()) {
        const file = this.outboundFile(event.eventId, index);
        try { await writeFile(file, bytes, { flag: 'wx', mode: 0o600, flush: true }); }
        catch (error) { if (error.code !== 'EEXIST' || digest(await readFile(file)) !== event.files[index].sha256) throw error; }
      }
      state.outbound.push({ eventId: event.eventId, fingerprint, messageId: event.messageId, text: event.text,
        parts: splitText(event.text), files: event.files, textSent: 0, filesSent: 0, done: false });
    });
    return { protocol: 'cardbush.webhook.v1', type: 'message.accepted', eventId: event.eventId, status: 'accepted' };
  }
  async advertise() {
    const response = await this.fetch(this.config.cardbush.url.replace(/\/messages$/, '/capabilities'), {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(5000)]),
      headers: { Authorization: 'Bearer ' + this.config.cardbush.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocol: 'cardbush.webhook.v1', capabilities: { text: true, files: true, maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_TOTAL_BYTES } }),
    });
    await response.body?.cancel(); if (!response.ok) throw Error('capability_registration_failed');
  }
  async sendOutbound() {
    for (const item of this.state.outbound.filter(item => !item.done)) {
      if (this.abort.signal.aborted) return;
      try {
        const record = this.state.records.find(r => r.id === item.messageId);
        if (!record?.context) throw Error('unknown_message');
        for (let index = item.textSent; index < item.parts.length; index++) {
          await this.api.send(record.sender, record.context, item.parts[index], 'cb-' + hash(item.eventId + ':text:' + index).slice(0, 40), this.abort.signal);
          await this.write(state => { state.outbound.find(o => o.eventId === item.eventId).textSent = index + 1; });
        }
        for (let index = item.filesSent; index < item.files.length; index++) {
          const file = item.files[index], bytes = await readFile(this.outboundFile(item.eventId, index));
          if (bytes.length !== file.size || digest(bytes) !== file.sha256) throw Error('outbound_file_changed');
          await this.api.sendFile(record.sender, record.context, { ...file, bytes }, 'cb-' + hash(item.eventId + ':file:' + index).slice(0, 40), this.abort.signal);
          await this.write(state => { state.outbound.find(o => o.eventId === item.eventId).filesSent = index + 1; });
        }
        await this.write(state => { state.outbound.find(o => o.eventId === item.eventId).done = true; });
        for (let index = 0; index < item.files.length; index++) await unlink(this.outboundFile(item.eventId, index)).catch(() => {});
      } catch (error) { if (!this.abort.signal.aborted) this.log('File/message retry: ' + safeError(error)); }
    }
  }
  async processOnce() {
    for (const record of this.state.records) {
      if (this.abort.signal.aborted) return;
      try {
        if (!record.accepted) {
          const event = await this.cardbush(record); await this.write(s => { s.records.find(r => r.id === record.id).accepted = true; }); await this.receive(event);
        }
        let current = this.state.records.find(r => r.id === record.id);
        if (current.accepted && !current.terminal) await this.receive(await this.cardbush(current, true));
        current = this.state.records.find(r => r.id === record.id);
        if (!current.outgoing && current.next) await this.write(s => {
          const r = s.records.find(r => r.id === record.id), next = r.next; delete r.next;
          const text = next.text.startsWith(r.deliveredText) ? next.text.slice(r.deliveredText.length).trim() : next.text;
          r.outgoing = { ...next, parts: splitText(text), sent: 0 };
        });
        current = this.state.records.find(r => r.id === record.id);
        if (current.outgoing) {
          const out = current.outgoing;
          for (let i = out.sent; i < out.parts.length; i++) {
            await this.api.send(current.sender, current.context, out.parts[i], 'cb-' + hash(current.id + ':' + out.sequence + ':' + i).slice(0, 40), this.abort.signal);
            await this.write(s => { s.records.find(r => r.id === record.id).outgoing.sent = i + 1; });
          }
          await this.write(s => { const r = s.records.find(r => r.id === record.id); r.deliveredText = out.text; delete r.outgoing; });
        }
      } catch (e) { if (!this.abort.signal.aborted) this.log('Message retry: ' + safeError(e)); }
    }
    await this.sendOutbound();
  }
  async listen(port = this.config.port) {
    this.server = createServer((req, res) => {
      const respond = (code, body) => { if (!res.destroyed) res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body)); };
      void (async () => {
        if (req.url !== '/reply' || req.method !== 'POST' || req.headers.origin) { respond(404, {}); return; }
        const given = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from('Bearer ' + this.config.callbackToken);
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) { respond(401, {}); return; }
        const { event, files } = await readBotCallback(req);
        const acknowledgement = await this.receive(event, files); respond(202, acknowledgement ?? { accepted: true });
      })().catch(() => { respond(400, { error: 'invalid_callback' }); req.resume(); });
    });
    this.server.requestTimeout = 120000; this.server.headersTimeout = 10000;
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(port, '127.0.0.1', resolve); });
    return this.server.address().port;
  }
  async run() {
    await this.listen(); this.log('Weixin bridge ready; callback listening on 127.0.0.1:' + this.config.port + '/reply');
    const advertise = () => this.advertise().catch(error => { if (!this.abort.signal.aborted) this.log('Cardbush capability registration: ' + safeError(error)); });
    await advertise();
    const heartbeat = async () => { while (!this.abort.signal.aborted) { await delay(30000, null, { signal: this.abort.signal }); await advertise(); } };
    const work = async () => { while (!this.abort.signal.aborted) { await this.processOnce(); await delay(1000, null, { signal: this.abort.signal }); } };
    const poll = async () => { while (!this.abort.signal.aborted) {
      try { const update = await this.api.updates(this.state.cursor, this.abort.signal); await this.ingest(update); await delay(200, null, { signal: this.abort.signal }); }
      catch (e) { if (this.abort.signal.aborted) break; if (e.message === 'login_expired') throw e; this.log('Weixin reconnect: ' + safeError(e)); await delay(3000, null, { signal: this.abort.signal }); }
    } };
    try { await Promise.all([work(), poll(), heartbeat()]); } finally { await this.close(); }
  }
  async close() { this.abort.abort(); if (this.server) { this.server.closeAllConnections(); await new Promise(r => this.server.close(r)); this.server = undefined; } await this.writes; }
}
export function safeError(error) { return /^[a-z0-9_]+$/i.test(error?.message ?? '') ? error.message : 'connection_failed'; }
