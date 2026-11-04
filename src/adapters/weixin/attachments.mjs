import { mkdir, realpath, lstat, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256 } from './media.mjs';

export function attachmentInfo(attachment, record) {
  return { attachment_id: attachment.id, message_id: record.id, kind: attachment.kind, name: attachment.name,
    ...(attachment.cached?.size !== undefined || attachment.size !== undefined ? { size: attachment.cached?.size ?? attachment.size } : {}),
    status: attachment.error ? 'unavailable' : attachment.cached ? 'downloaded' : 'available',
    ...(attachment.error || attachment.lastError ? { code: attachment.error || attachment.lastError } : {}) };
}
export class WeixinAttachments {
  constructor(bridge) { this.bridge = bridge; this.pending = new Map(); }
  source(event) {
    const record = this.bridge.state.records.find(record => record.id === event.messageId);
    if (!record || record.sender !== event.senderId || event.conversationId !== this.bridge.account.id + ':' + record.sender) throw Error('unknown_message');
    return record;
  }
  list(event, { cursor = 0, limit = 8 } = {}) {
    const source = this.source(event);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1 || limit > 10) throw Error('invalid_tool_arguments');
    const all = [...this.bridge.state.records].reverse().filter(record => record.sender === source.sender)
      .flatMap(record => (record.attachments ?? []).map(attachment => attachmentInfo(attachment, record)));
    return { attachments: all.slice(cursor, cursor + limit), ...(cursor + limit < all.length ? { next_cursor: cursor + limit } : {}) };
  }
  async directory() {
    const root = await realpath(this.bridge.root), directory = join(root, 'inbound-files');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (await realpath(directory) !== directory) throw Error('attachment_path_changed');
    return directory;
  }
  async download(event, id) {
    const source = this.source(event);
    if (typeof id !== 'string' || !/^[a-f\d]{64}$/.test(id)) throw Error('invalid_tool_arguments');
    const record = this.bridge.state.records.find(record => record.sender === source.sender && record.attachments?.some(attachment => attachment.id === id));
    if (!record) throw Error('attachment_not_found');
    if (this.pending.has(id)) return this.pending.get(id);
    const operation = this.fetch(record.id, id).finally(() => this.pending.delete(id));
    this.pending.set(id, operation); return operation;
  }
  async fetch(messageId, id) {
    const bridge = this.bridge, attachment = bridge.state.records.find(record => record.id === messageId).attachments.find(attachment => attachment.id === id);
    if (attachment.error) return { status: 'unavailable', code: attachment.error, attachment_id: id };
    try {
      bridge.abort.signal.throwIfAborted();
      const directory = await this.directory();
      let cached = attachment.cached;
      if (cached) {
        const file = join(directory, id + cached.extension);
        if (!/^\.[a-z0-9]{1,10}$/i.test(cached.extension)) throw Error('attachment_path_changed');
        try {
          const info = await lstat(file);
          if (!info.isFile() || info.nlink !== 1 || await realpath(file) !== file) throw Error('attachment_path_changed');
          const bytes = await readFile(file);
          if (bytes.length !== cached.size || sha256(bytes) !== cached.sha256) throw Error('attachment_file_changed');
        } catch (error) { if (error.code !== 'ENOENT') throw error; cached = undefined; }
      }
      if (!cached) {
        const downloaded = await bridge.api.download(attachment, bridge.abort.signal);
        bridge.abort.signal.throwIfAborted();
        const suffix = extname(attachment.name);
        const extension = attachment.kind === 'file' && /^\.[a-z0-9]{1,10}$/i.test(suffix) ? suffix : downloaded.extension;
        const file = join(directory, id + extension), temp = join(directory, id + '.' + randomUUID() + '.tmp');
        try { await writeFile(temp, downloaded.bytes, { mode: 0o600, flag: 'wx', flush: true }); await rename(temp, file); }
        finally { await unlink(temp).catch(() => {}); }
        cached = { extension, size: downloaded.bytes.length, mimeType: downloaded.mimeType, sha256: downloaded.sha256 };
        await bridge.write(state => { const item = state.records.find(record => record.id === messageId).attachments.find(item => item.id === id);
          item.cached = cached; delete item.lastError; });
      }
      return { status: 'downloaded', attachment_id: id, name: attachment.name, kind: attachment.kind,
        localPath: join(directory, id + cached.extension), size: cached.size, mimeType: cached.mimeType, sha256: cached.sha256,
        usage: attachment.kind === 'image' ? 'Use inject_image_input with localPath to inspect the actual image.'
          : 'Use existing local file or video tools with localPath. The attachment content has not been interpreted.' };
    } catch (error) {
      if (bridge.abort.signal.aborted) throw error;
      const code = /^[a-z0-9_]+$/i.test(error.message) ? error.message : 'attachment_download_failed';
      await bridge.write(state => { state.records.find(record => record.id === messageId).attachments.find(item => item.id === id).lastError = code; });
      return { status: 'unavailable', attachment_id: id, code, retry: 'Retry download_attachment with a fresh request_id after the cause is resolved.' };
    }
  }
}
