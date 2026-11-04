import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

export function terminalAsk({ input = process.stdin, output = process.stdout, signal, interactive = !!input.isTTY } = {}) {
  let muted = false;
  const sink = new Writable({ write(chunk, _encoding, done) { if (!muted) output.write(chunk); done(); } });
  const reader = createInterface({ input, output: sink, terminal: !!input.isTTY });
  return { async ask(prompt, secret = false) {
    if (!interactive) throw Error('credentials_required_noninteractive');
    signal?.throwIfAborted();
    // Let readline own the prompt: question('') would erase an externally printed prompt.
    muted = false; const answer = reader.question(prompt, { signal }); muted = secret;
    try { return await answer; } finally { muted = false; if (secret) output.write('\n'); }
  }, close() { reader.close(); sink.end(); } };
}
