import { createHash } from 'node:crypto';

export const MAX_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// Generic Cardbush callback parsing, independent of the platform transport.
export async function readBotCallback(req) {
  const contentType = req.headers['content-type'] ?? '';
  const multipart = contentType.startsWith('multipart/form-data;');
  if (!multipart && contentType.split(';')[0].trim() !== 'application/json') throw Error('unsupported_content_type');
  const chunks = []; let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > (multipart ? MAX_TOTAL_BYTES + 512 * 1024 : 256 * 1024)) throw Error('callback_too_large');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (!multipart) return { event: JSON.parse(bytes.toString('utf8')), files: [] };
  const form = await new Response(bytes, { headers: { 'Content-Type': contentType } }).formData();
  if (form.getAll('payload').length !== 1 || typeof form.get('payload') !== 'string' || form.get('payload').length > 64000) throw Error('invalid_payload');
  const event = JSON.parse(form.get('payload'));
  if (!['message.send', 'tool.call'].includes(event.type) || !Array.isArray(event.files) || event.files.length > 8 || [...form.keys()].length !== event.files.length + 1) throw Error('invalid_files');
  const files = [];
  for (const descriptor of event.files) {
    if (form.getAll(descriptor.part).length !== 1) throw Error('invalid_file_part');
    const file = form.get(descriptor.part);
    if (!file || typeof file === 'string' || file.size > MAX_FILE_BYTES) throw Error('invalid_file_part');
    files.push(Buffer.from(await file.arrayBuffer()));
  }
  if (event.type === 'tool.call') validateBotFiles(event, files); else validateBotSend(event, files);
  return { event, files };
}
export function validateBotSend(event, files) {
  const string = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;
  if (event.protocol !== 'cardbush.webhook.v1' || event.type !== 'message.send' || !string(event.eventId, 128)
    || !string(event.messageId, 200) || !string(event.senderId, 200) || !string(event.conversationId, 400)
    || typeof event.text !== 'string' || event.text.length > 32000 || !Array.isArray(event.files) || event.files.length > 8
    || files.length !== event.files.length || !event.text.trim() && !files.length) throw Error('invalid_send');
  validateBotFiles(event, files);
}
export function validateBotFiles(event, files) {
  const string = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;
  if (!Array.isArray(event.files) || event.files.length > 8 || files.length !== event.files.length) throw Error('invalid_files');
  let total = 0; const parts = new Set();
  for (const [index, file] of event.files.entries()) {
    if (!/^file_[0-7]$/.test(file.part) || parts.has(file.part) || !string(file.name, 220) || /[\\/\r\n\0]/.test(file.name)
      || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE_BYTES || file.size !== files[index].length
      || !/^[a-f0-9]{64}$/.test(file.sha256) || digest(files[index]) !== file.sha256
      || !string(file.mimeType, 100) || !/^[\w.+-]+\/[\w.+-]+$/.test(file.mimeType)) throw Error('invalid_file');
    parts.add(file.part); total += file.size;
  }
  if (total > MAX_TOTAL_BYTES) throw Error('files_too_large');
}
