import { messagingHandlers } from '../../shared/plugins.mjs';

export function createPlugins(bridge) {
  return [{ manifest: {
    id: 'feishu', name: '飞书 Feishu', version: '1.0.0', description: '飞书消息与文件能力，使用当前来信的飞书会话。',
    tools: [
      { name: 'send_text', description: '通过飞书 Feishu Lark 发送用户要求的文字到当前来信的群聊或私聊。',
        inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 32000 } }, required: ['text'], additionalProperties: false } },
      { name: 'send_file', description: '通过飞书 Feishu Lark 上传并发送文件，可附说明；上传凭据和平台 file_key 由飞书桥管理。', fileArguments: ['file'],
        inputSchema: { type: 'object', properties: { file: { type: 'string', minLength: 1, description: 'Local file path.' }, caption: { type: 'string', maxLength: 32000 } }, required: ['file'], additionalProperties: false } },
      { name: 'delivery_status', description: '查询本次来信触发的飞书文件或文字发送状态。delivered 表示飞书接口成功，不表示用户已打开。', readOnly: true,
        inputSchema: { type: 'object', properties: { delivery_id: { type: 'string', minLength: 1 } }, required: ['delivery_id'], additionalProperties: false } },
    ],
  }, handlers: messagingHandlers(bridge, event => bridge.state.records.some(record => record.id === event.messageId && record.senderId === event.senderId
    && record.conversationId === event.conversationId)) }];
}
