// Generic Cardbush discovery/pairing client. No platform-specific API or account logic.
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { validateConfig } from './config.mjs';
import { localServiceFetch } from './local-http.mjs';

export const DEFAULT_CARDBUSH_URL = 'http://127.0.0.1:4791';
export async function connectLocalService(config, { name, save, onStatus = () => {}, baseUrl = DEFAULT_CARDBUSH_URL,
  fetcher = localServiceFetch, wait = (ms, signal) => delay(ms, undefined, { signal }), signal, force = false } = {}) {
  signal?.throwIfAborted();
  const base = new URL(baseUrl);
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw Error('invalid_discovery_url');
  const request = async (url, { method = 'GET', token, body } = {}) => {
    const response = await fetcher(url, { method, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
      headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    const result = await response.json().catch(() => { throw Error('unsupported_cardbush'); });
    if (!response.ok) throw Error(result?.error?.code || 'connection_http_' + response.status);
    if (result.protocol !== 'cardbush.webhook.v1') throw Error('unsupported_cardbush');
    return result;
  };
  // Previously authorized connections survive service/app restarts without prompting again.
  if (config.cardbush?.url && config.cardbush?.token && !force) {
    const saved = validateConfig(config);
    try { const info = await request(saved.cardbush.url, { token: saved.cardbush.token });
      if (info.type !== 'connection.info') throw Error('unsupported_cardbush'); onStatus('connected', info.title); return saved; }
    catch (error) { if (signal?.aborted) throw error;
      if (error.message === 'unauthorized') throw Error('connection_revoked');
      if (error.message === 'unsupported_cardbush') throw error;
      // A sleeping/offline app does not invalidate an existing authorized binding.
      onStatus('waiting_for_cardbush'); return saved; }
  }
  let pairing = config.pairing;
  if (!pairing || pairing.baseUrl !== base.origin || force) {
    pairing = { requestId: randomUUID(), secret: randomBytes(32).toString('hex'), baseUrl: base.origin };
    config = { ...config, pairing }; await save(config);
  }
  let announced = '', submitted = false, renewed = false;
  const status = value => { if (announced !== value) { announced = value; onStatus(value); } };
  const deadline = Date.now() + 10 * 60000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      if (!submitted) {
        const discovery = await request(base.origin + '/api/webhooks/v1/discovery').catch(error => {
          if (['unauthorized', 'endpoint_not_found'].includes(error.message)) throw Error('unsupported_cardbush'); throw error;
        });
        if (!discovery.capabilities?.includes('local_pairing')) throw Error('unsupported_cardbush');
      }
      const result = await request(base.origin + '/api/webhooks/v1/pairings' + (submitted ? '/' + pairing.requestId : ''), {
        method: submitted ? 'GET' : 'POST', token: pairing.secret,
        body: submitted ? undefined : { requestId: pairing.requestId, name, replyUrl: `http://127.0.0.1:${config.port}/reply`, replyHeaders: { Authorization: 'Bearer ' + config.callbackToken } },
      });
      submitted = true;
      if (result.status === 'connected') {
        if (result.requestId !== pairing.requestId || !result.connection) throw Error('invalid_pairing_response');
        let next;
        try { next = validateConfig({ ...config, pairing: undefined, cardbush: { url: result.connection.endpoint, token: result.connection.token } }); }
        catch { throw Error('invalid_pairing_response'); }
        const target = new URL(next.cardbush.url);
        if (target.protocol !== base.protocol || target.port !== base.port || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) throw Error('invalid_pairing_response');
        await save(next); onStatus('connected', result.connection.title); return next;
      }
      if (result.status === 'rejected' || result.status === 'revoked') throw Error('connection_' + result.status);
      if (result.status !== 'pending') throw Error('invalid_pairing_response');
      status('waiting_for_authorization');
    } catch (error) {
      if (signal?.aborted) throw error;
      // A saved, unapproved request can expire while the bridge is stopped.
      // Renew that request once; revoked authorized grants still fail above.
      if (error.message === 'pairing_expired' && !renewed) {
        pairing = { requestId: randomUUID(), secret: randomBytes(32).toString('hex'), baseUrl: base.origin };
        config = { ...config, pairing }; await save(config);
        renewed = true; submitted = false; announced = ''; continue;
      }
      if (['unsupported_cardbush', 'invalid_pairing_response', 'connection_rejected', 'connection_revoked', 'pairing_conflict', 'pairing_expired', 'pairing_limit', 'unauthorized', 'invalid_parameters'].includes(error.message)) throw error;
      status('waiting_for_cardbush'); submitted = false;
    }
    await wait(1500, signal);
  }
  throw Error('pairing_expired');
}
