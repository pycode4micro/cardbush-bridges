/** Bounded external diagnostics. Credentials and media URLs never enter receipts. */
export function platformError(code, facts, secrets = []) {
  const details = {};
  if (typeof facts.operation === 'string' && /^[a-z_]{1,40}$/.test(facts.operation)) details.operation = facts.operation;
  for (const key of ['httpStatus', 'ret', 'errcode']) if (Number.isSafeInteger(facts[key])) details[key] = facts[key];
  if (typeof facts.message === 'string') {
    let message = facts.message;
    for (const secret of secrets.filter(s => typeof s === 'string' && s.length).sort((a, b) => b.length - a.length)) message = message.replaceAll(secret, '[redacted]');
    details.message = message.replace(/https?:\/\/[^\s<>"']+/gi, '[url]')
      .replace(/\b(Bearer\s+)\S+/gi, '$1[redacted]')
      .replace(/\b(?:token|context_token|aes_key|aeskey|encrypt_query_param|upload_param|authorization)\s*[:=]\s*[^\s,;]+/gi, '[credential]')
      .replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 512);
  }
  return Object.assign(Error(code), { transportDetails: details });
}

export function requestSecrets(value) {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) => /token|aes_?key|encrypt.*param|upload.*param/i.test(key) && typeof item === 'string'
    ? [item] : item && typeof item === 'object' ? requestSecrets(item) : []);
}
