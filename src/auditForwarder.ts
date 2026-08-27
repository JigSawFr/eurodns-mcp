import type { AuditForwardConfig } from './config.js';
import type { MetricsRegistry } from './metrics.js';

/**
 * Ships audit lines to a collector as they are written.
 *
 * This is **additive**, not a fourth `EURODNS_AUDIT_DESTINATION`. Two reasons, and the
 * second is the one that made it worth building:
 *
 * 1. `AuditLogger.write` is synchronous. A network send is not, and making the write path
 *    asynchronous would put a tool call behind a collector's latency.
 * 2. `EURODNS_AUDIT_QUERY` requires the `file` destination, because the history tool can
 *    only read a file. Before this, shipping the log off the host meant `stdout` and a
 *    platform log drain — which is still the simplest answer where it fits, but it costs
 *    the history tool. A forwarder alongside the file keeps both.
 *
 * What arrives at the collector is the line **exactly as written**, with its `seq` and
 * `prev`, so the hash chain can be re-verified downstream. Reformatting it here would throw
 * away the only property that makes the log worth trusting.
 *
 * Nothing in here may throw into the caller, block it, or grow without bound: an audit
 * transport that takes the server down with it is worse than no transport.
 */
export class AuditForwarder {
  private readonly config: AuditForwardConfig;
  private readonly metrics: MetricsRegistry | undefined;
  private readonly fetchImpl: typeof fetch;

  private readonly pending: string[] = [];
  private timer: NodeJS.Timeout | undefined;
  /** One request at a time, so lines reach the collector in the order they were written. */
  private inFlight: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    config: AuditForwardConfig,
    metrics?: MetricsRegistry,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.config = config;
    this.metrics = metrics;
    this.fetchImpl = fetchImpl;
  }

  /**
   * Queues one line, already serialized and newline-terminated.
   *
   * Synchronous and total: it returns before anything touches the network, and no failure
   * mode here reaches the caller.
   */
  enqueue(serialized: string): void {
    if (this.closed) return;

    this.pending.push(serialized);

    // A bounded queue turns a collector outage into lost lines; an unbounded one turns it
    // into a leak that eventually takes the process down, taking the local log with it.
    // The oldest go first: on a chain, the newest lines are the ones still worth having.
    while (this.pending.length > this.config.queue) {
      this.pending.shift();
      this.metrics?.recordAuditForwardDrop();
    }

    if (this.pending.length >= this.config.batch) {
      this.schedule(0);
      return;
    }
    this.schedule(this.config.intervalMs);
  }

  /** Sends everything queued, waiting for any send already under way. */
  async flush(): Promise<void> {
    this.clearTimer();
    while (this.pending.length > 0) {
      await this.send();
    }
    await this.inFlight;
  }

  /**
   * Stops accepting lines and makes a final attempt to drain, under a deadline.
   *
   * The deadline matters more than it looks: a platform that stops idle machines sends
   * SIGTERM often, and a shutdown that hangs on an unreachable collector would be killed
   * anyway — after a delay that helps nobody.
   */
  async close(timeoutMs: number): Promise<void> {
    this.clearTimer();
    const drained = this.flush().catch(() => undefined);
    await Promise.race([
      drained,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref()),
    ]);
    this.closed = true;
  }

  private schedule(delayMs: number): void {
    // A full batch takes priority over a timer already waiting out the interval. Without
    // this the cap never fires early: the first line arms the long timer, and every later
    // one finds it set and returns.
    if (delayMs === 0) this.clearTimer();
    else if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.send();
    }, delayMs);
    // Never a reason for the queue to hold the process open — on stdio the parent decides
    // when this exits, and in tests a live handle would keep the runner from finishing.
    this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Chains onto the in-flight request so batches never overlap. */
  private send(): Promise<void> {
    const batch = this.pending.splice(0, this.config.batch);
    if (batch.length === 0) return this.inFlight;

    this.inFlight = this.inFlight.then(() => this.post(batch));
    return this.inFlight;
  }

  private async post(batch: string[]): Promise<void> {
    // The lines already end in a newline, so concatenation alone yields NDJSON — the format
    // a generic collector, Splunk HEC in raw mode, Loki or Elastic all accept as-is.
    const body = batch.join('');
    const headers: Record<string, string> = { 'Content-Type': 'application/x-ndjson' };
    if (this.config.token) headers.Authorization = `Bearer ${this.config.token}`;

    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await this.fetchImpl(this.config.url, {
          method: 'POST',
          headers,
          body,
        });
        if (response.ok) return;
        // A 4xx will not become a 2xx by being sent again — that is a misconfiguration, and
        // retrying it only delays the report.
        if (response.status < 500 && response.status !== 429) {
          this.giveUp(batch.length, `collector answered ${response.status}`);
          return;
        }
        if (attempt >= this.config.maxRetries) {
          this.giveUp(batch.length, `collector answered ${response.status}`);
          return;
        }
      } catch (cause) {
        if (attempt >= this.config.maxRetries) {
          this.giveUp(batch.length, cause instanceof Error ? cause.message : String(cause));
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, this.config.backoffMs * 2 ** attempt));
    }
  }

  /**
   * Drops a batch, loudly.
   *
   * Dropping is acceptable only because the local destination already holds these lines —
   * the forwarder is a second copy, not the record. It must still be visible: a collector
   * that has silently stopped receiving looks exactly like one with nothing to report.
   */
  private giveUp(lines: number, detail: string): void {
    for (let i = 0; i < lines; i += 1) this.metrics?.recordAuditForwardFailure();
    process.stderr.write(
      `${JSON.stringify({
        level: 'error',
        message: 'audit forward failed',
        lines,
        detail,
      })}\n`,
    );
  }
}
