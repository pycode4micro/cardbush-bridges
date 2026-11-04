import { createHash, createDecipheriv } from 'node:crypto';

export const MAX_MEDIA_BYTES = 64 * 1024 * 1024;
export const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c/';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function cdnUrl(value) {
  let url; try { url = new URL(value); } catch { throw Error('untrusted_media_host'); }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.weixin.qq.com') || url.username || url.password || url.port || url.hash)
    throw Error('untrusted_media_host');
  return url;
}
export async function boundedBytes(response, limit) {
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) { await response.body?.cancel(); throw Error('media_too_large'); }
  const reader = response.body?.getReader(); if (!reader) throw Error('media_empty');
  const chunks = []; let size = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break;
    size += next.value.length; if (size > limit) throw Error('media_too_large'); chunks.push(next.value);
  } } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}
export function mediaType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return { mimeType: 'image/png', extension: '.png', kind: 'image' };
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { mimeType: 'image/jpeg', extension: '.jpg', kind: 'image' };
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())) return { mimeType: 'image/gif', extension: '.gif', kind: 'image' };
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return { mimeType: 'image/webp', extension: '.webp', kind: 'image' };
  // HEIC/AVIF also have an ftyp box; never label every ISO media file as a video.
  if (bytes.length >= 16 && bytes.subarray(4, 8).toString() === 'ftyp'
    && /^(isom|iso[2-9]|mp4[12]|avc1|M4V |MSNV)$/.test(bytes.subarray(8, 12).toString())) return { mimeType: 'video/mp4', extension: '.mp4', kind: 'video' };
  if (bytes.subarray(0, 5).toString() === '%PDF-') return { mimeType: 'application/pdf', extension: '.pdf', kind: 'file' };
  return { mimeType: 'application/octet-stream', extension: '.bin', kind: 'file' };
}
export function mediaKey(attachment) {
  if (attachment.aeskey !== undefined) {
    if (!/^[a-f\d]{32}$/i.test(attachment.aeskey)) throw Error('invalid_media_key');
    return Buffer.from(attachment.aeskey, 'hex');
  }
  const value = attachment.media?.aes_key;
  if (value === undefined || value === '') { if (attachment.kind === 'image') return; throw Error('media_key_missing'); }
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4) throw Error('invalid_media_key');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[a-f\d]{32}$/i.test(decoded.toString())) return Buffer.from(decoded.toString(), 'hex');
  throw Error('invalid_media_key');
}
export async function downloadMedia(attachment, fetcher, signal) {
  const media = attachment.media;
  if (!media || !media.full_url && !media.encrypt_query_param) throw Error('media_reference_missing');
  const key = mediaKey(attachment);
  const url = cdnUrl(media.full_url || CDN_BASE + 'download?' + new URLSearchParams({ encrypted_query_param: media.encrypt_query_param }));
  const response = await fetcher(url, { method: 'GET', redirect: 'error', headers: {},
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(45000)]) });
  if (!response.ok) { await response.body?.cancel(); throw Error('media_http_' + response.status); }
  let bytes = await boundedBytes(response, MAX_MEDIA_BYTES + (key ? 16 : 0));
  if (attachment.cipherSize !== undefined && bytes.length !== attachment.cipherSize) throw Error('media_size_mismatch');
  if (key) {
    try { const decrypt = createDecipheriv('aes-128-ecb', key, null); bytes = Buffer.concat([decrypt.update(bytes), decrypt.final()]); }
    catch { throw Error('media_decryption_failed'); }
  }
  if (!bytes.length && attachment.kind !== 'file' || bytes.length > MAX_MEDIA_BYTES) throw Error('media_size_unsupported');
  if (attachment.size !== undefined && bytes.length !== attachment.size) throw Error('media_size_mismatch');
  if (attachment.md5 && createHash('md5').update(bytes).digest('hex') !== attachment.md5) throw Error('media_hash_mismatch');
  const type = mediaType(bytes);
  if (attachment.kind !== 'file' && type.kind !== attachment.kind) throw Error('media_type_mismatch');
  return { bytes, ...type, sha256: sha256(bytes) };
}
function safeName(value, fallback) {
  const name = typeof value === 'string' ? value.split(/[\\/]/).at(-1).replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_').trim().slice(0, 120) : '';
  return name && !/^\.+$/.test(name) ? name : fallback;
}
/** Keep CDN URLs/keys private; public attachment descriptors are projected separately. */
export function incomingAttachments(items, messageId) {
  const attachments = []; let omitted = 0;
  for (const [index, item] of items.entries()) {
    const kind = { 2: 'image', 4: 'file', 5: 'video' }[item?.type]; if (!kind) continue;
    if (attachments.length >= 8) { omitted++; continue; }
    const source = item[{ image: 'image_item', file: 'file_item', video: 'video_item' }[kind]] ?? {};
    const id = sha256(messageId + ':' + index), fallback = kind + '-' + id.slice(0, 8) + (kind === 'image' ? '.jpg' : kind === 'video' ? '.mp4' : '.bin');
    const attachment = { id, kind, name: safeName(source.file_name, fallback), media: source.media,
      ...(kind === 'image' && source.aeskey ? { aeskey: source.aeskey } : {}) };
    try {
      if (!source.media || JSON.stringify(source.media).length > 16000) throw Error('media_reference_missing');
      cdnUrl(source.media.full_url || CDN_BASE + 'download?' + new URLSearchParams({ encrypted_query_param: source.media.encrypt_query_param || '' }));
      if (!source.media.full_url && (typeof source.media.encrypt_query_param !== 'string' || !source.media.encrypt_query_param)) throw Error('media_reference_missing');
      mediaKey(attachment);
      if (kind === 'file' && source.len !== undefined) {
        if (!/^\d+$/.test(String(source.len)) || !Number.isSafeInteger(Number(source.len)) || Number(source.len) > MAX_MEDIA_BYTES) throw Error('media_too_large');
        attachment.size = Number(source.len);
      }
      const cipherSize = kind === 'image' ? source.mid_size : kind === 'video' ? source.video_size : undefined;
      if (cipherSize !== undefined && cipherSize !== 0) {
        if (!Number.isSafeInteger(cipherSize) || cipherSize < 1 || cipherSize > MAX_MEDIA_BYTES + 16) throw Error('media_too_large');
        attachment.cipherSize = cipherSize;
      }
      const md5 = source.md5 ?? source.video_md5;
      if (md5) { if (!/^[a-f\d]{32}$/i.test(md5)) throw Error('invalid_media_hash'); attachment.md5 = md5.toLowerCase(); }
    } catch (error) { attachment.error = error.message; delete attachment.media; delete attachment.aeskey; }
    attachments.push(attachment);
  }
  return { attachments, omitted };
}
