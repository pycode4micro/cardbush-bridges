import { readFile } from 'node:fs/promises';
import { createCipheriv, createHash } from 'node:crypto';

export const samples = {
  image: await readFile(new URL('./fixtures/sample.png', import.meta.url)),
  video: await readFile(new URL('./fixtures/sample.mp4', import.meta.url)),
  file: Buffer.from('实际文件字节\nWeixin attachment round trip.\n'),
};
export const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
export function encrypt(bytes) { const cipher = createCipheriv('aes-128-ecb', key, null); return Buffer.concat([cipher.update(bytes), cipher.final()]); }
export function mediaItem(kind, { encoding = 'hex', fullUrl = false, plaintext = false } = {}) {
  const bytes = samples[kind], wire = plaintext ? bytes : encrypt(bytes);
  const media = { ...(fullUrl ? { full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/download?sample=' + kind } : { encrypt_query_param: 'sample-' + kind }),
    ...(!plaintext ? { aes_key: encoding === 'raw' ? key.toString('base64') : Buffer.from(key.toString('hex')).toString('base64') } : {}) };
  return kind === 'image' ? { type: 2, image_item: { media, mid_size: wire.length } }
    : kind === 'video' ? { type: 5, video_item: { media, video_size: wire.length, video_md5: createHash('md5').update(bytes).digest('hex') } }
      : { type: 4, file_item: { media, file_name: '测试文件.txt', len: String(bytes.length), md5: createHash('md5').update(bytes).digest('hex') } };
}
export const config = { port: 4792, callbackToken: 'b'.repeat(64), cardbush: { url: 'http://127.0.0.1:1/api/webhooks/v1/test/messages', token: 'a'.repeat(64) } };
export const account = { id: 'bot', userId: 'owner', token: 'test-account-secret' };
export const update = (items, id = '1', sender = 'owner') => ({ get_updates_buf: 'cursor-' + id,
  msgs: [{ message_type: 1, message_id: id, from_user_id: sender, context_token: 'context-' + id, item_list: items }] });
export const toolEvent = (bridge, record, tool, args, eventId = 'tool-' + tool) => ({ protocol: 'cardbush.webhook.v1', type: 'tool.call',
  eventId, pluginId: 'weixin', pluginVersion: bridge.plugins[0].manifest.version, tool, arguments: args, sourceRef: 'opaque',
  messageId: record.id, senderId: record.sender, conversationId: account.id + ':' + record.sender, files: [] });
