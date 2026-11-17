import * as lark from '@larksuiteoapi/node-sdk';

export function connectFeishu(config, bridge, { sdk = lark, log = console.log, signal, network } = {}) {
  signal?.throwIfAborted();
  // Never pass SDK error/request objects to logs: they may contain credentials.
  const logger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
  const client = new sdk.WSClient({ appId: config.appId, appSecret: config.appSecret, domain: sdk.Domain.Feishu,
    ...(network ? { agent: network.agent, httpInstance: network.httpInstance } : {}),
    logger, loggerLevel: sdk.LoggerLevel.error, autoReconnect: true, handshakeTimeoutMs: 15000,
    onReady: () => log('飞书长连接已建立。可以在开放平台保存“使用长连接接收事件”，并订阅 im.message.receive_v1。'),
    onReconnecting: () => log('飞书连接中断，正在自动重连。'), onReconnected: () => log('飞书连接已恢复。'),
    onError: () => { log('飞书连接失败，请检查应用凭据、机器人能力和网络。'); bridge.abort.abort(Error('feishu_connection_failed')); },
  });
  const dispatcher = new sdk.EventDispatcher({ logger, loggerLevel: sdk.LoggerLevel.error }).register({
    'im.message.receive_v1': async data => {
      // Persist before acknowledging the platform. Throwing asks the platform to retry.
      const result = await bridge.ingest(data);
      if (result?.paired) log('飞书用户配对成功，可以开始对话。');
      return {};
    },
  });
  const close = () => client.close({ force: true });
  signal?.addEventListener('abort', close, { once: true });
  const started = client.start({ eventDispatcher: dispatcher });
  return { client, started, close() { signal?.removeEventListener('abort', close); close(); } };
}
