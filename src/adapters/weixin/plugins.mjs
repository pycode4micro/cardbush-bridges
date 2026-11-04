import { messagingHandlers } from '../../shared/plugins.mjs';

export function createPlugins(bridge) {
  const handlers = messagingHandlers(bridge, event => bridge.state.records.some(record => record.id === event.messageId && record.sender === event.senderId
    && event.conversationId === bridge.account.id + ':' + record.sender));
  for (const kind of ['image', 'video']) handlers['send_' + kind] = async (event, files) => {
    if (Object.keys(event.arguments).some(key => !['file', 'caption'].includes(key)) || files.length !== 1
      || !event.arguments.file || Object.keys(event.arguments.file).join() !== 'part' || event.arguments.file.part !== event.files[0].part
      || event.arguments.caption !== undefined && (typeof event.arguments.caption !== 'string' || event.arguments.caption.length > 32000)) throw Error('invalid_tool_arguments');
    await bridge.receiveSend({ ...event, type: 'message.send', text: event.arguments.caption ?? '' }, files, kind);
    return { deliveryId: event.eventId, status: 'queued', deliveryConfirmed: false };
  };
  handlers.list_attachments = async (event, files) => {
    if (files.length || Object.keys(event.arguments).some(key => !['cursor', 'limit'].includes(key))) throw Error('invalid_tool_arguments');
    return bridge.attachments.list(event, event.arguments);
  };
  handlers.download_attachment = async (event, files) => {
    if (files.length || Object.keys(event.arguments).join() !== 'attachment_id') throw Error('invalid_tool_arguments');
    return bridge.attachments.download(event, event.arguments.attachment_id);
  };
  const mediaInput = { type: 'object', properties: { file: { type: 'string', minLength: 1, description: 'Local file path.' },
    caption: { type: 'string', maxLength: 32000 } }, required: ['file'], additionalProperties: false };
  return [{ manifest: {
    id: 'weixin', name: '微信 Weixin', version: '1.1.0', description: '微信文字、原生图片/视频、文件收发与来信附件读取，使用当前来信的微信用户和会话。',
    tools: [
      { name: 'send_text', description: '通过微信 Weixin WeChat 发送用户要求的文字到当前来信会话。',
        inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 32000 } }, required: ['text'], additionalProperties: false } },
      { name: 'send_file', description: '通过微信 Weixin WeChat 发送一个文件，可附说明。Cardbush 读取获准的本地文件；微信桥负责加密上传和发送。', fileArguments: ['file'],
        inputSchema: mediaInput },
      { name: 'send_image', description: '通过微信 Weixin 发送可直接查看的原生图片消息，支持 PNG、JPEG、GIF、WebP；参数是获准的本机文件。可附文字说明。', fileArguments: ['file'], inputSchema: mediaInput },
      { name: 'send_video', description: '通过微信 Weixin 发送原生 MP4 视频消息，可附文字说明。不转码；其他格式请先转换或使用 send_file。', fileArguments: ['file'], inputSchema: mediaInput },
      { name: 'list_attachments', description: '列出当前微信用户最近发来的图片、视频、文件元数据（含 attachment_id 与原消息 ID），按新到旧分页；不会读取其他用户附件或泄露下载凭据。', readOnly: true,
        inputSchema: { type: 'object', properties: { cursor: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 10 } }, additionalProperties: false } },
      { name: 'download_attachment', description: '根据微信来信或 list_attachments 中的 attachment_id 下载并解密附件，返回 localPath、类型和 SHA256。桥与 Cardbush 需同机；图片随后用 inject_image_input 查看，视频和文件用现有读取工具处理。只允许当前用户的附件，无任意 URL 或保存路径参数。',
        inputSchema: { type: 'object', properties: { attachment_id: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, required: ['attachment_id'], additionalProperties: false } },
      { name: 'delivery_status', description: '查询本次来信触发的微信文字、图片、视频或文件发送状态。delivered 表示微信接口成功，不表示用户已打开。', readOnly: true,
        inputSchema: { type: 'object', properties: { delivery_id: { type: 'string', minLength: 1 } }, required: ['delivery_id'], additionalProperties: false } },
    ],
  }, handlers }];
}
