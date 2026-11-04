import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '../../src/adapters/feishu/bridge.mjs';
import { digest } from '../../src/shared/bot-outbound.mjs';

export const app = { appId: 'cli_fixture', appSecret: 'fixture-secret' };
export const config = () => ({ port: 4793, callbackToken: 'b'.repeat(64), feishu: app,
  cardbush: { url: 'http://127.0.0.1:4791/api/webhooks/v1/fixture/messages', token: 'c'.repeat(64) } });
export const message = (id = 'om_one', text = '你好', sender = 'ou_owner', chat = 'oc_origin', extra = {}) => ({
  sender: { sender_type: 'user', sender_id: { open_id: sender } },
  message: { message_id: id, chat_id: chat, chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }), create_time: '1000', ...extra },
});
export async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'feishu-unit-'));
  const sent = [], logs = [];
  const api = { text: async (...args) => sent.push(['text', ...args]), file: async (...args) => sent.push(['file', ...args]), upload: async () => 'file_key_fixture', ...options.api };
  const bridge = await new Bridge(root, { ...config(), allowedSenders: ['ou_owner'], ...options.config }, api,
    { botOpenId: 'ou_bot', log: text => logs.push(text), ...options.options }).load();
  t.after(async () => { await bridge.close(); await rm(root, { recursive: true, force: true }); });
  return { root, bridge, sent, api, logs };
}
export function outbound(record, bytes = Buffer.from('附件内容\n'), eventId = 'event-file-1') {
  return { protocol: 'cardbush.webhook.v1', type: 'message.send', eventId, sourceRef: 'opaque', messageId: record.id,
    senderId: record.senderId, conversationId: record.conversationId, text: '', files: [
      { part: 'file_0', name: '测试附件.txt', mimeType: 'text/plain', size: bytes.length, sha256: digest(bytes) },
    ] };
}
