import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { connect, createServer as tcpServer } from 'node:net';
import { once } from 'node:events';
import { createNetwork, environmentProxy, networkOptions } from '../src/shared/network.mjs';
import { parseInvocation } from '../src/arguments.mjs';

test('network CLI defaults to direct and supports system/custom for individual and all adapters', () => {
  assert.deepEqual(parseInvocation(['start', 'weixin']).network, { mode: 'direct' });
  assert.deepEqual(parseInvocation(['start', '--all', '--proxy', 'system']).network, { mode: 'system' });
  assert.equal(parseInvocation(['start', 'feishu', '--proxy', 'socks5://127.0.0.1:7897']).network.mode, 'custom');
  assert.equal(parseInvocation(['login', 'weixin', '--no-proxy']).network.mode, 'direct');
  for (const args of [['start', 'weixin', '--proxy', 'system', '--no-proxy'], ['status', '--proxy', 'system'],
    ['start', 'weixin', '--proxy', 'ftp://name:private@host'], ['start', 'weixin', '--proxy', 'http://host/path']]) {
    assert.throws(() => parseInvocation(args), error => error.exitCode === 2 && !error.userMessage.includes('private'));
  }
});

test('direct ignores inherited proxies; system honors protocol and bypass rules; Windows resolves lazily', async () => {
  const env = { HTTPS_PROXY: 'http://127.0.0.1:1', NO_PROXY: '.example.org,private.test:443' };
  assert.equal(environmentProxy(new URL('https://a.example.org'), env), '');
  assert.equal(environmentProxy(new URL('https://private.test'), env), '');
  assert.equal(environmentProxy(new URL('https://public.test'), env), 'http://127.0.0.1:1/');
  const direct = createNetwork(undefined, { platform: 'linux', env });
  const system = createNetwork({ mode: 'system' }, { platform: 'linux', env });
  let calls = 0, closed = 0;
  const windows = createNetwork({ mode: 'system' }, { platform: 'win32', helperFactory: mode => {
    assert.equal(mode, 'system'); return { async ask(url) { calls++; assert.equal(url, 'https://public.test'); return { proxy: 'http://localhost:7897' }; }, close() { closed++; } };
  } });
  try {
    assert.equal(await direct.resolveProxy('https://public.test'), '');
    assert.equal(await system.resolveProxy('https://public.test'), 'http://127.0.0.1:1/');
    assert.equal(await windows.resolveProxy('http://127.0.0.1:4791'), ''); assert.equal(calls, 0);
    assert.equal(await windows.resolveProxy('wss://public.test/path'), 'http://localhost:7897/');
    await windows.resolveProxy('https://public.test/second'); assert.equal(calls, 1);
  } finally { await direct.close(); await system.close(); await windows.close(); }
  assert.equal(closed, 1); await assert.rejects(windows.resolveProxy('https://public.test'), /network_closed/);
});

test('Windows direct binds through one private relay and never falls back to global routing on failure', async () => {
  let started = 0, closed = 0;
  const network = createNetwork(undefined, { platform: 'win32', helperFactory: mode => {
    started++; assert.equal(mode, 'direct'); return { async ask(token) { assert.match(token, /^[a-f0-9]{64}$/); return { port: 12345 }; }, close() { closed++; } };
  } });
  const routes = await Promise.all(Array.from({ length: 5 }, () => network.resolveProxy('https://public.test')));
  assert.equal(new Set(routes).size, 1); assert.equal(started, 1);
  assert.equal(new URL(routes[0]).hostname, '127.0.0.1'); assert.equal(await network.resolveProxy('http://localhost:4791'), '');
  await network.close(); assert.equal(closed, 1);
  const failing = createNetwork(undefined, { platform: 'win32', helperFactory: () => ({ ask: async () => { throw Error('direct_dns_failed'); }, close() {} }) });
  try { await assert.rejects(failing.fetch('https://public.test'), /direct_dns_failed/); } finally { await failing.close(); }
});

test('Windows relay requires its random credential and rejects fake-IP literals without changing system routing',
  { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
  const network = createNetwork();
  try {
    const endpoint = new URL(await network.resolveProxy('https://fixture.invalid'));
    assert.equal(endpoint.hostname, '127.0.0.1');
    async function tunnel(auth) {
      return new Promise((resolve, reject) => {
        const socket = connect(Number(endpoint.port), endpoint.hostname, () => socket.write('CONNECT 198.18.0.10:443 HTTP/1.1\r\nHost: 198.18.0.10:443\r\nProxy-Authorization: ' + auth + '\r\n\r\n'));
        socket.setTimeout(3000, () => socket.destroy(Error('test_timeout'))); socket.on('error', reject);
        socket.once('data', bytes => { socket.destroy(); resolve(bytes.toString()); });
      });
    }
    assert.match(await tunnel('Basic invalid'), /^HTTP\/1.1 407/);
    const credential = 'Basic ' + Buffer.from(decodeURIComponent(endpoint.username) + ':' + decodeURIComponent(endpoint.password)).toString('base64');
    assert.match(await tunnel(credential), /^HTTP\/1.1 502/);
  } finally { await network.close(); }
});

test('HTTP requests and WebSocket upgrade share authenticated explicit proxy; local callbacks stay direct', async t => {
  const destination = createServer((req, res) => { assert.equal(req.headers['proxy-authorization'], undefined); res.end('ok'); });
  const sockets = new Set();
  destination.on('upgrade', (req, socket) => { assert.equal(req.headers['proxy-authorization'], undefined); socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'); });
  let tunnels = 0;
  const proxy = createServer();
  for (const server of [destination, proxy]) {
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
  }
  proxy.on('connect', (req, socket, head) => {
    tunnels++; assert.equal(req.headers['proxy-authorization'], 'Basic ' + Buffer.from('user:secret').toString('base64'));
    const upstream = connect(destination.address().port, '127.0.0.1', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); socket.pipe(upstream).pipe(socket); });
    sockets.add(upstream); upstream.once('close', () => sockets.delete(upstream)); socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy());
  });
  const network = createNetwork(networkOptions(`http://user:secret@127.0.0.1:${proxy.address().port}`));
  t.after(async () => { await network.close(); for (const socket of sockets) socket.destroy(); await Promise.all([destination, proxy].map(server => new Promise(r => server.close(r)))); });
  assert.equal(await (await network.fetch('http://external.invalid/')).text(), 'ok'); assert.equal(tunnels, 1);
  assert.equal(await (await network.fetch(`http://127.0.0.1:${destination.address().port}/`)).text(), 'ok'); assert.equal(tunnels, 1);
  await new Promise((resolve, reject) => {
    const req = request('http://external.invalid/ws', { agent: network.agent, headers: { Connection: 'Upgrade', Upgrade: 'websocket' } });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(); }); req.on('error', reject); req.end();
  });
  assert.equal(tunnels, 2);
});

test('SOCKS HTTP and SDK sockets both resolve the destination at the selected proxy', { timeout: 5000 }, async t => {
  const destination = createServer((req, res) => res.end('socks-ok')), sockets = new Set(), hosts = [];
  destination.listen(0, '127.0.0.1'); await once(destination, 'listening');
  const server = tcpServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket));
    let stage = 0, bytes = Buffer.alloc(0);
    function receive(chunk) {
      bytes = Buffer.concat([bytes, chunk]);
      if (stage === 0 && bytes.length >= 2 && bytes.length >= bytes[1] + 2) { bytes = bytes.subarray(bytes[1] + 2); stage = 1; socket.write(Buffer.from([5, 0])); }
      if (stage !== 1 || bytes.length < 5) return;
      assert.equal(bytes[3], 3, 'destination is a hostname, not locally resolved');
      const length = 7 + bytes[4]; if (bytes.length < length) return;
      hosts.push(bytes.subarray(5, 5 + bytes[4]).toString()); stage = 2; socket.off('data', receive);
      const remaining = bytes.subarray(length);
      const upstream = connect(destination.address().port, '127.0.0.1', () => {
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
        if (remaining.length) upstream.write(remaining); socket.pipe(upstream).pipe(socket);
      });
      sockets.add(upstream); upstream.once('close', () => sockets.delete(upstream)); upstream.on('error', () => socket.destroy());
    }
    socket.on('data', receive);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const network = createNetwork(networkOptions(`socks5://127.0.0.1:${server.address().port}`));
  t.after(async () => { await network.close(); for (const socket of sockets) socket.destroy(); destination.closeAllConnections(); await Promise.all([server, destination].map(s => new Promise(r => s.close(r)))); });
  assert.equal(await (await network.fetch('http://unresolvable.invalid')).text(), 'socks-ok');
  const body = await new Promise((resolve, reject) => {
    const req = request('http://unresolvable.invalid', { agent: network.agent }, res => { let body = ''; res.on('data', b => body += b); res.on('end', () => resolve(body)); });
    req.on('error', reject); req.end();
  });
  assert.equal(body, 'socks-ok'); assert.deepEqual(hosts, ['unresolvable.invalid', 'unresolvable.invalid']);
});
