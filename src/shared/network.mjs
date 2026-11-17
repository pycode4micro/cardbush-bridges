import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { Agent, ProxyAgent } from 'undici';
import { Agent as BaseAgent } from 'agent-base';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { localServiceFetch } from './local-http.mjs';

const exec = promisify(execFile);
export const loopback = url => url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
export function proxyUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw Error('invalid_proxy_url'); }
  if (!['http:', 'https:', 'socks:', 'socks5:'].includes(url.protocol) || !url.hostname || url.pathname !== '/' && url.pathname !== '' || url.search || url.hash) throw Error('invalid_proxy_url');
  try { decodeURIComponent(url.username); decodeURIComponent(url.password); } catch { throw Error('invalid_proxy_url'); }
  return url.href;
}
export function networkOptions(value = 'direct') {
  if (['direct', 'system'].includes(value)) return { mode: value };
  return { mode: 'custom', url: proxyUrl(value) };
}

function windowsHelper(mode) {
  const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    fileURLToPath(new URL('./windows-network.ps1', import.meta.url)), '-Mode', mode], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  let pending, closed = false;
  const fail = () => { closed = true; pending?.reject(Error('windows_network_unavailable')); pending = undefined; };
  child.on('error', fail); child.on('exit', fail); child.stdin.on('error', fail); child.stderr.on('data', () => {});
  lines.on('line', line => {
    if (!pending) return;
    try { const result = JSON.parse(line.trim().replace(/^\uFEFF/, '')); if (result.error) throw Error(); pending.resolve(result); }
    catch { pending.reject(Error('windows_network_unavailable')); }
    pending = undefined;
  });
  let serial = Promise.resolve();
  const ask = input => serial = serial.catch(() => {}).then(() => new Promise((resolve, reject) => {
    if (closed) { reject(Error('windows_network_unavailable')); return; }
    const timer = setTimeout(() => { child.kill(); reject(Error('windows_network_timeout')); }, 20000);
    pending = { resolve(value) { clearTimeout(timer); resolve(value); }, reject(error) { clearTimeout(timer); reject(error); } };
    child.stdin.write(input + '\n');
  }));
  return { ask, alive: () => !closed, close() { closed = true; pending?.reject(Error('network_closed')); pending = undefined; child.stdin.end(); child.kill(); lines.close(); } };
}

export function environmentProxy(url, env = process.env) {
  const bypass = env.no_proxy ?? env.NO_PROXY ?? '';
  for (const item of bypass.split(/[\s,]+/).filter(Boolean)) {
    if (item === '*') return '';
    const [host, port] = item.toLowerCase().split(':');
    if (port && port !== (url.port || (url.protocol === 'https:' ? '443' : '80'))) continue;
    const suffix = host.replace(/^\*?\./, '');
    if (url.hostname === suffix || host.startsWith('.') && url.hostname.endsWith('.' + suffix) || host.startsWith('*.') && url.hostname.endsWith('.' + suffix)) return '';
  }
  const protocol = url.protocol === 'https:' ? 'https_proxy' : 'http_proxy';
  const value = env[protocol] ?? env[protocol.toUpperCase()] ?? env.all_proxy ?? env.ALL_PROXY;
  return value ? proxyUrl(value.includes('://') ? value : 'http://' + value) : '';
}

/** One policy for platform HTTP, uploads and SDK WebSockets. Never mutate global networking. */
export function createNetwork(options = { mode: 'direct' }, { platform = process.platform, fetcher = globalThis.fetch,
  helperFactory = windowsHelper, env = process.env } = {}) {
  const dispatchers = new Map(), direct = new Agent(); let native, nativeEndpoint, system, closed = false;
  if (!['direct', 'system', 'custom'].includes(options.mode)) throw Error('invalid_network_mode');
  const configured = options.mode === 'custom' ? proxyUrl(options.url) : '';
  const cache = new Map();
  async function resolveProxy(input) {
    if (closed) throw Error('network_closed');
    const url = new URL(input); if (url.protocol === 'wss:') url.protocol = 'https:'; if (url.protocol === 'ws:') url.protocol = 'http:';
    if (loopback(url)) return '';
    if (options.mode === 'custom') return configured;
    if (options.mode === 'direct') {
      if (platform !== 'win32') return '';
      if (native?.alive && !native.alive()) { native.close(); native = undefined; nativeEndpoint = undefined; }
      if (!nativeEndpoint) {
        native = helperFactory('direct'); const token = randomBytes(32).toString('hex');
        nativeEndpoint = native.ask(token).then(({ port }) => {
          if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('windows_network_unavailable');
          return `http://bridge:${token}@127.0.0.1:${port}`;
        }).catch(error => { native?.close(); native = undefined; nativeEndpoint = undefined; throw error; });
      }
      return nativeEndpoint;
    }
    const previous = cache.get(url.origin); if (previous?.expires > Date.now()) return previous.value;
    let value;
    if (platform === 'win32') {
      if (system?.alive && !system.alive()) { system.close(); system = undefined; }
      system ??= helperFactory('system'); value = (await system.ask(url.origin)).proxy;
    }
    else if (platform === 'darwin') {
      const { stdout } = await exec('/usr/sbin/scutil', ['--proxy'], { timeout: 5000 });
      const setting = key => stdout.match(new RegExp('\\b' + key + '\\s*:\\s*([^\\r\\n]+)'))?.[1]?.trim();
      if (setting('ProxyAutoConfigEnable') === '1' || setting('ProxyAutoDiscoveryEnable') === '1') throw Error('system_proxy_pac_unsupported');
      const type = url.protocol === 'https:' ? 'HTTPS' : 'HTTP';
      value = setting(type + 'Enable') === '1' ? `http://${setting(type + 'Proxy')}:${setting(type + 'Port')}` : environmentProxy(url, env);
      const exceptions = stdout.match(/ExceptionsList\s*:\s*<array>\s*\{([^}]+)\}/)?.[1]?.match(/:\s*([^\r\n]+)/g)?.map(x => x.slice(1).trim()).join(',');
      if (exceptions && !environmentProxy(url, { no_proxy: exceptions, all_proxy: value })) value = '';
    } else value = environmentProxy(url, env);
    value = value ? proxyUrl(value) : '';
    cache.set(url.origin, { value, expires: Date.now() + 30000 }); return value;
  }
  const nodeRoutes = new Map(), httpDirect = new HttpAgent({ proxyEnv: {} }), httpsDirect = new HttpsAgent({ proxyEnv: {} });
  class PlatformAgent extends BaseAgent {
    async connect(request, settings) {
      const url = new URL(request.path, `${settings.secureEndpoint ? 'https' : 'http'}://${request.getHeader('host')}`);
      const endpoint = await resolveProxy(url);
      if (!endpoint) return settings.secureEndpoint ? httpsDirect : httpDirect;
      let agent = nodeRoutes.get(endpoint);
      // Match Undici: the selected SOCKS proxy resolves destinations, never Fake-IP DNS on the host.
      if (!agent) { agent = endpoint.startsWith('socks') ? new SocksProxyAgent(endpoint.replace(/^socks5:/, 'socks5h:')) : new HttpsProxyAgent(endpoint); nodeRoutes.set(endpoint, agent); }
      return agent;
    }
  }
  const nodeAgent = new PlatformAgent();
  const network = {
    mode: options.mode, resolveProxy, agent: nodeAgent,
    async fetch(input, init = {}) {
      const url = new URL(input);
      if (loopback(url) && url.protocol === 'http:') return localServiceFetch(url, init);
      const endpoint = await resolveProxy(url);
      let dispatcher = direct;
      if (endpoint) {
        dispatcher = dispatchers.get(endpoint);
        if (!dispatcher) { dispatcher = new ProxyAgent({ uri: endpoint, proxyTunnel: true }); dispatchers.set(endpoint, dispatcher); }
      }
      return fetcher(input, { ...init, dispatcher });
    },
    async close() {
      closed = true; nodeAgent.destroy(); httpDirect.destroy(); httpsDirect.destroy();
      for (const agent of nodeRoutes.values()) agent.destroy(); native?.close(); system?.close();
      await Promise.allSettled([direct.destroy(), ...[...dispatchers.values()].map(agent => agent.destroy())]);
    },
  };
  network.httpInstance = { async request({ url, method = 'get', data, headers, timeout = 15000 }) {
    const response = await network.fetch(url, { method: method.toUpperCase(), headers: { ...headers, 'Content-Type': 'application/json' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }), redirect: 'error', signal: AbortSignal.timeout(timeout) });
    if (!response.ok) { await response.body?.cancel(); throw Error('platform_http_' + response.status); }
    return response.json();
  } };
  return network;
}
