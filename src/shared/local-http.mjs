import { Agent, request } from 'node:http';

// Loopback service traffic must not follow inherited HTTP_PROXY settings.
// Remote HTTPS connections keep the user's normal fetch/network policy.
const direct = new Agent({ proxyEnv: {} });
export function localServiceFetch(input, options = {}) {
  const url = new URL(input);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return fetch(input, options);
  return new Promise((resolve, reject) => {
    const req = request(url, { agent: direct, method: options.method, signal: options.signal,
      headers: Object.fromEntries(new Headers(options.headers)) }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400) { res.resume(); reject(Error('unexpected_redirect')); return; }
      const chunks = []; let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 1024 * 1024) res.destroy(Error('response_too_large'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => resolve(new Response(chunks.length ? Buffer.concat(chunks) : null, { status: res.statusCode,
        headers: Object.fromEntries(Object.entries(res.headers).filter(([, value]) => typeof value === 'string')) })));
    });
    req.on('error', reject); req.end(options.body);
  });
}
