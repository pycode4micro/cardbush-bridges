/** Configuration tickets and lifecycle are bridge internals, never model arguments. */
export class WeixinPresence {
  constructor(api, { now = Date.now, log = () => {} } = {}) {
    this.api = api; this.now = now; this.log = log; this.cache = new Map(); this.typing = new Map();
  }
  warn(error) { this.log('Weixin presence: ' + (/^[a-z0-9_]+$/i.test(error?.message ?? '') ? error.message : 'connection_failed')); }
  remember(key, value) {
    this.cache.delete(key);
    if (this.cache.size >= 256) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(key, value);
  }
  async start(signal) {
    if (this.started) return; this.started = true;
    try { await this.api.notifyStart?.(signal); } catch (error) { this.warn(error); }
  }
  async ticket(record, signal) {
    const key = record.sender + ':' + record.context, cached = this.cache.get(key);
    if (cached?.until > this.now()) return cached.ticket;
    try {
      const result = await this.api.getConfig?.(record.sender, record.context, signal);
      const ticket = typeof result?.typing_ticket === 'string' && result.typing_ticket.length <= 4096 ? result.typing_ticket : undefined;
      this.remember(key, { ticket, until: this.now() + (ticket ? 300000 : 30000) }); return ticket;
    } catch (error) { this.remember(key, { until: this.now() + 30000 }); this.warn(error); }
  }
  async sync(records, signal) {
    if (!this.api.sendTyping) return;
    const busy = new Map(records.filter(record => record.accepted && !record.terminal).map(record => [record.sender, record]));
    for (const [sender, previous] of this.typing) if (!busy.has(sender)) {
      if (previous.cancelRetryAt > this.now()) continue;
      try { await this.api.sendTyping(sender, previous.ticket, 2, signal); this.typing.delete(sender); }
      catch (error) { previous.cancelRetryAt = this.now() + 30000; this.warn(error); }
    }
    for (const record of busy.values()) {
      if ((this.typing.get(record.sender)?.at ?? -Infinity) + 8000 > this.now()) continue;
      const ticket = await this.ticket(record, signal); if (!ticket) continue;
      try { await this.api.sendTyping(record.sender, ticket, 1, signal); this.typing.set(record.sender, { ticket, at: this.now() }); }
      catch (error) {
        this.remember(record.sender + ':' + record.context, { until: this.now() + 30000 });
        // The server may have accepted a request whose response was lost; retain its cancellation ticket.
        this.typing.set(record.sender, { ticket, at: this.now() }); this.warn(error);
      }
    }
  }
  async stop(signal) {
    await this.sync([], signal);
    if (!this.started || this.stopped) return; this.stopped = true;
    try { await this.api.notifyStop?.(signal); } catch (error) { this.warn(error); }
    this.cache.clear(); this.typing.clear();
  }
}
