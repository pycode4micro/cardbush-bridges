// Add a descriptor and an isolated adapter to support another platform.
// Cardbush discovery, credentials storage and file callback parsing stay shared.
export const bridges = [
  { id: 'weixin', name: '微信', serviceName: '微信服务', port: 4792, dataEnv: 'CARDBUSH_WEIXIN_DATA',
    legacyDirectory: 'cardbush-weixin-bridge', commands: ['start', 'connect', 'setup', 'login', 'login-start', 'login-check', 'init'],
    configured: (config, account) => Boolean(config?.cardbush?.url && config.cardbush.token && account?.token),
    load: () => import('./adapters/weixin/cli.mjs') },
  { id: 'feishu', name: '飞书', serviceName: '飞书服务', port: 4793, dataEnv: 'CARDBUSH_FEISHU_DATA',
    legacyDirectory: 'cardbush-feishu-bridge', commands: ['start', 'connect', 'setup', 'doctor'],
    configured: config => Boolean(config?.cardbush?.url && config.cardbush.token && config.feishu?.appId && config.feishu.appSecret),
    load: () => import('./adapters/feishu/cli.mjs') },
];
