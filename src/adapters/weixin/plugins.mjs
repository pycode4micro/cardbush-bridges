import { messagingHandlers } from '../../shared/plugins.mjs';

export function createPlugins(bridge) {
  return [{ manifest: {
    id: 'weixin', name: '微信 Weixin', version: '1.0.0', description: '微信对话与文件发送，使用当前来信的微信用户和会话。',
    tools: [
      { name: 'send_text', description: '通过微信 Weixin WeChat 发送用户要求的文字到当前来信会话。',
        inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 32000 } }, required: ['text'], additionalProperties: false } },
      { name: 'send_file', description: '通过微信 Weixin WeChat 发送一个文件，可附说明。Cardbush 读取获准的本地文件；微信桥负责加密上传和发送。', fileArguments: ['file'],
        inputSchema: { type: 'object', properties: { file: { type: 'string', minLength: 1, description: 'Local file path.' }, caption: { type: 'string', maxLength: 32000 } }, required: ['file'], additionalProperties: false } },
      { name: 'delivery_status', description: '查询本次来信触发的微信文件或文字发送状态。delivered 表示微信接口成功，不表示用户已打开。', readOnly: true,
        inputSchema: { type: 'object', properties: { delivery_id: { type: 'string', minLength: 1 } }, required: ['delivery_id'], additionalProperties: false } },
    ],
  }, handlers: messagingHandlers(bridge, event => bridge.state.records.some(record => record.id === event.messageId && record.sender === event.senderId
    && event.conversationId === bridge.account.id + ':' + record.sender)) }];
}
