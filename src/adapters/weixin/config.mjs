import { normalizeCardbushUrl, normalizeCardbushToken, validateConfig } from '../../shared/config.mjs';
export { normalizeCardbushUrl, normalizeCardbushToken, validateConfig };
export function configurationError(error) {
  return {
    cardbush_url_required: '还没有配置 Cardbush 接收地址。请先在 Cardbush 右上角保存 Webhook 连接，再运行 npm run setup。',
    cardbush_reply_url_used: '这是微信服务的回复地址，应填在 Cardbush 的“回复 Webhook 地址”里。这里请粘贴保存连接后生成的“接收消息地址”（通常为 4791 端口，路径以 /messages 结尾）。',
    invalid_cardbush_url: '接收地址格式不正确。请在 Cardbush 的 Webhook 窗口点击“复制接收地址”，完整粘贴生成的地址，不要填写示例地址或回复地址。',
    cardbush_token_required: '请粘贴 Cardbush Webhook 窗口生成的“接收令牌”，不要粘贴回复请求头或整个 JSON。',
    invalid_callback_token: '本机回复令牌缺失或不完整，请检查私有 config.json 中的 callbackToken。',
    invalid_port: '本机回复端口必须是 1024 到 65535 之间的整数。',
  }[error?.message];
}
/** Validate each field before asking for the next one; never discard an existing configuration on a typo. */
export async function configure(config, { ask, notify }) {
  const read = async (prompt, previous, normalize) => {
    for (;;) {
      const value = await ask(prompt);
      if (value === undefined || value === null) throw Error('setup_cancelled');
      try { return normalize(value.trim() || previous); }
      catch (error) { const message = configurationError(error); if (!message) throw error; notify(message); }
    }
  };
  const url = await read('从 Cardbush 复制的“接收消息地址”（不是 4792/reply；回车保留已保存值）：', config.cardbush?.url, normalizeCardbushUrl);
  const token = await read('从同一连接复制的“接收令牌”（回车保留已保存值）：', config.cardbush?.token, normalizeCardbushToken);
  return validateConfig({ ...config, cardbush: { url, token } });
}
