import { randomUUID } from 'node:crypto';
import { validateBotFiles } from './bot-outbound.mjs';
import { deliverySnapshot } from './outbound-worker.mjs';

export const bridgeInstance = () => randomUUID();
export async function advertisePlugins(bridge, capabilities) {
  bridge.ready = false;
  const response = await bridge.fetch(bridge.config.cardbush.url.replace(/\/messages$/, '/capabilities'), {
    method: 'POST', redirect: 'error', signal: AbortSignal.any([bridge.abort.signal, AbortSignal.timeout(5000)]),
    headers: { Authorization: 'Bearer ' + bridge.config.cardbush.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocol: 'cardbush.webhook.v1', instanceId: bridge.instanceId, capabilities,
      plugins: bridge.plugins.map(plugin => plugin.manifest) }),
  });
  const body = await response.json();
  if (!response.ok || body.protocol !== 'cardbush.webhook.v1' || body.status !== 'connected' || !body.features?.includes('bridge_plugins')) throw Error('cardbush_plugins_upgrade_required');
  bridge.ready = true;
  bridge.deliveryEvents = body.features.includes('delivery_events');
}
export async function withdrawPlugins(bridge) {
  bridge.ready = false;
  await bridge.fetch(bridge.config.cardbush.url.replace(/\/messages$/, '/capabilities'), {
    method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(3000),
    headers: { Authorization: 'Bearer ' + bridge.config.cardbush.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocol: 'cardbush.webhook.v1', instanceId: bridge.instanceId }),
  }).then(response => response.body?.cancel()).catch(() => {});
}
export async function invokePlugin(bridge, event, files) {
  bridge.abort.signal.throwIfAborted();
  if (event.protocol !== 'cardbush.webhook.v1' || event.type !== 'tool.call' || typeof event.eventId !== 'string'
    || typeof event.messageId !== 'string' || typeof event.sourceRef !== 'string'
    || !event.arguments || typeof event.arguments !== 'object' || Array.isArray(event.arguments)) throw Error('invalid_tool_call');
  const plugin = bridge.plugins.find(plugin => plugin.manifest.id === event.pluginId && plugin.manifest.version === event.pluginVersion);
  const handler = plugin?.handlers[event.tool];
  if (typeof handler !== 'function' || !plugin.manifest.tools.some(tool => tool.name === event.tool)) throw Error('plugin_tool_unavailable');
  validateBotFiles(event, files);
  const result = await handler(event, files);
  return { protocol: 'cardbush.webhook.v1', eventId: event.eventId, status: 'accepted', result };
}
const fields = (args, allowed) => { if (Object.keys(args).some(key => !allowed.includes(key))) throw Error('invalid_tool_arguments'); };
export function messagingHandlers(bridge, ownsMessage) {
  return {
    async send_text(event, files) {
      fields(event.arguments, ['text']);
      if (files.length || typeof event.arguments.text !== 'string' || !event.arguments.text.trim() || event.arguments.text.length > 32000) throw Error('invalid_tool_arguments');
      await bridge.receiveSend({ ...event, type: 'message.send', text: event.arguments.text }, files);
      return deliverySnapshot(bridge.state.outbound.find(item => item.eventId === event.eventId));
    },
    async send_file(event, files) {
      fields(event.arguments, ['file', 'caption']);
      if (files.length !== 1 || !event.arguments.file || Object.keys(event.arguments.file).join() !== 'part'
        || event.arguments.file.part !== event.files[0].part || event.arguments.caption !== undefined && typeof event.arguments.caption !== 'string') throw Error('invalid_tool_arguments');
      await bridge.receiveSend({ ...event, type: 'message.send', text: event.arguments.caption ?? '' }, files);
      return deliverySnapshot(bridge.state.outbound.find(item => item.eventId === event.eventId));
    },
    async delivery_status(event, files) {
      fields(event.arguments, ['delivery_id']);
      if (files.length || typeof event.arguments.delivery_id !== 'string' || !ownsMessage(event)) throw Error('invalid_tool_arguments');
      const item = bridge.state.outbound.find(item => item.eventId === event.arguments.delivery_id && item.messageId === event.messageId);
      return item ? deliverySnapshot(item) : { status: 'not_found' };
    },
  };
}
