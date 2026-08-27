/**
 * Draining on a termination signal.
 *
 * Extracted from the two entry points rather than written twice: the logic is identical,
 * and inside `main()` it is unreachable from a test — which is how the audit forwarder
 * could have shipped with its most important path, the final flush, never exercised.
 *
 * The contract is deliberately small. Stop accepting work, flush what is buffered, exit.
 * Nothing here decides *what* is buffered; that belongs to the caller.
 */
export interface ShutdownOptions {
  /** Stops accepting new work. Omitted on stdio, where the parent owns the stream. */
  stopAccepting?: () => void;
  /** Flushes anything held in memory. Must resolve even when its destination is gone. */
  drain: () => Promise<void>;
  /** Called once, with the signal that started this. */
  onSignal?: (signal: string) => void;
  /** Overridden by tests, which must not end their own process. */
  exit?: (code: number) => void;
}

/**
 * Builds the handler, without registering it.
 *
 * Idempotent by construction: a second signal while the first is still draining is
 * ignored rather than starting a second drain. Two SIGTERMs in quick succession is a
 * normal thing for an orchestrator to do.
 */
export function createShutdown(options: ShutdownOptions): (signal: string) => void {
  let shuttingDown = false;

  return (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;

    options.onSignal?.(signal);
    options.stopAccepting?.();

    const exit = options.exit ?? ((code: number) => process.exit(code));
    // A drain that rejects must still let the process go. Exiting late is survivable;
    // hanging until the platform sends SIGKILL is what this exists to avoid.
    void options.drain().then(
      () => exit(0),
      () => exit(0),
    );
  };
}

/** Registers the handler for the two signals a platform actually sends. */
export function installShutdown(options: ShutdownOptions): (signal: string) => void {
  const shutdown = createShutdown(options);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return shutdown;
}
