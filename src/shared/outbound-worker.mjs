/** Durable transport state. No model calls or content-based routing. */
export function deliverySnapshot(item) {
  return { deliveryId: item.eventId, status: item.done ? 'delivered' : item.status ?? 'queued', deliveryConfirmed: !!item.done,
    textPartsSent: item.textSent, filesSent: item.filesSent,
    ...Object.fromEntries(['phase', 'attempts', 'createdAt', 'startedAt', 'updatedAt', 'completedAt', 'nextAttemptAt', 'lastError', 'timings']
      .filter(key => item[key] !== undefined).map(key => [key, item[key]])) };
}
export function deliveryReceipt(bridge, item) {
  return { ...deliverySnapshot(item), completion: bridge.deliveryEvents && item.sourceRef && bridge.outbound?.notify
    ? { mode: 'event', recipient: 'assistant', eventType: 'bridge_delivery_result' } : { mode: 'query' } };
}
const permanent = new Set(['unknown_message', 'outbound_file_changed', 'invalid_file', 'media_type_mismatch', 'untrusted_upload_host', 'ENOENT']);
const errorCode = error => /^[a-z][a-z0-9_-]{0,99}$/i.test(error?.message ?? '') ? error.message
  : /^[A-Z_]+$/.test(error?.code ?? '') ? error.code
  : /^[A-Z_]+$/.test(error?.cause?.code ?? '') ? error.cause.code
    : ['TimeoutError', 'AbortError'].includes(error?.name) ? 'transport_timeout' : 'connection_failed';
export class OutboundWorker {
  constructor(bridge, send, { now = Date.now } = {}) { this.bridge = bridge; this.send = send; this.now = now; this.revision = 0; }
  wake() { this.revision++; this.wakeWait?.(); }
  eligible(item) { return !item.done && item.status !== 'failed'; }
  process() {
    if (!this.processing) this.processing = this.drain().finally(() => { this.processing = undefined; });
    return this.processing;
  }
  async update(id, change) {
    await this.bridge.write(state => { const item = state.outbound.find(value => value.eventId === id); item.updatedAt = this.now(); change(item); });
  }
  async drain() {
    for (const item of this.bridge.state.outbound.filter(item => this.eligible(item) && (item.nextAttemptAt ?? 0) <= this.now())) {
      if (this.bridge.abort.signal.aborted) return;
      const id = item.eventId;
      try {
        await this.update(id, current => {
          current.attempts = (current.attempts ?? 0) + 1; current.startedAt ??= this.now();
          current.status = 'sending'; delete current.nextAttemptAt;
          current.timings ??= { queueMs: Math.max(0, current.startedAt - (current.createdAt ?? current.startedAt)), uploadMs: 0, sendMs: 0 };
        });
        const stage = async (phase, action) => {
          this.bridge.abort.signal.throwIfAborted();
          await this.update(id, current => { current.phase = phase; current.status = phase === 'uploading' ? 'uploading' : 'sending'; });
          const started = this.now();
          try { return await action(); }
          finally { await this.update(id, current => { current.timings[phase === 'uploading' ? 'uploadMs' : 'sendMs'] += Math.max(0, this.now() - started); }); }
        };
        await this.send(item, stage);
        await this.update(id, current => { current.done = true; current.status = 'delivered'; current.phase = 'completed';
          current.completedAt = this.now(); delete current.nextAttemptAt; current.notificationResult = deliverySnapshot(current); });
        await this.bridge.releaseOutbound?.(item).catch(() => {});
      } catch (error) {
        if (this.bridge.abort.signal.aborted) return;
        const code = errorCode(error), failed = permanent.has(code);
        await this.update(id, current => {
          current.lastError = { code, at: this.now(), phase: current.phase ?? 'sending',
            ...(error.transportDetails ? { details: error.transportDetails } : {}) };
          current.status = failed ? 'failed' : 'retrying';
          if (failed) { current.completedAt = this.now(); current.notificationResult = deliverySnapshot(current); }
          else current.nextAttemptAt = this.now() + Math.min(30000, 1000 * 2 ** Math.min(5, (current.attempts ?? 1) - 1));
        });
        this.bridge.log('Outbound ' + (failed ? 'failed: ' : 'retry: ') + code);
      }
    }
  }
  async wait(revision) {
    if (this.bridge.abort.signal.aborted || revision !== this.revision) return;
    const pending = this.bridge.state.outbound.filter(item => this.eligible(item));
    const next = pending.length ? Math.min(...pending.map(item => item.nextAttemptAt ?? this.now())) : undefined;
    await new Promise(resolve => {
      let timer;
      const finish = () => { clearTimeout(timer); this.bridge.abort.signal.removeEventListener('abort', finish); this.wakeWait = undefined; resolve(); };
      this.wakeWait = finish; this.bridge.abort.signal.addEventListener('abort', finish, { once: true });
      if (next !== undefined) timer = setTimeout(finish, Math.min(30000, Math.max(1, next - this.now())));
      if (this.bridge.abort.signal.aborted || revision !== this.revision) finish();
    });
  }
  async run() {
    while (!this.bridge.abort.signal.aborted) {
      const revision = this.revision;
      await this.process();
      await this.wait(revision);
    }
  }
  async notify() {
    if (!this.bridge.deliveryEvents || this.notifying) return this.notifying;
    return this.notifying = this.publish().finally(() => { this.notifying = undefined; });
  }
  async publish() {
    for (const item of this.bridge.state.outbound.filter(item => item.sourceRef && (item.done || item.status === 'failed') && !item.notified && (item.notifyAfter ?? 0) <= this.now())) {
      if (this.bridge.abort.signal.aborted) return;
      try {
        const response = await this.bridge.fetch(this.bridge.config.cardbush.url.replace(/\/messages$/, '/deliveries'), {
          method: 'POST', redirect: 'error', signal: AbortSignal.any([this.bridge.abort.signal, AbortSignal.timeout(5000)]),
          headers: { Authorization: 'Bearer ' + this.bridge.config.cardbush.token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ protocol: 'cardbush.webhook.v1', eventId: item.eventId, sourceRef: item.sourceRef,
            messageId: item.messageId, result: item.notificationResult ?? deliverySnapshot(item) }),
        });
        const ack = await response.json();
        if (!response.ok || ack.eventId !== item.eventId || ack.status !== 'accepted') throw Error('delivery_notification_failed');
        await this.update(item.eventId, current => { current.notified = true; delete current.notifyAfter; });
      } catch (error) {
        if (this.bridge.abort.signal.aborted) return;
        await this.update(item.eventId, current => { current.notifyAfter = this.now() + 5000; });
        this.bridge.log('Delivery notification retry: ' + errorCode(error));
      }
    }
  }
}
