import { describe, expect, it, vi } from 'vitest';
import { createShutdown } from '../src/shutdown.js';

describe('draining on a signal', () => {
  it('stops accepting, drains, then exits', async () => {
    const order: string[] = [];
    const shutdown = createShutdown({
      onSignal: (signal) => order.push(`signal:${signal}`),
      stopAccepting: () => order.push('stopAccepting'),
      drain: async () => {
        order.push('drain');
      },
      exit: (code) => order.push(`exit:${code}`),
    });

    shutdown('SIGTERM');
    await vi.waitUntil(() => order.includes('exit:0'));

    // The order is the point: draining before the listener closes would let a request in
    // after the flush, and exiting before the drain is what this exists to prevent.
    expect(order).toEqual(['signal:SIGTERM', 'stopAccepting', 'drain', 'exit:0']);
  });

  it('ignores a second signal while the first is still draining', async () => {
    let drains = 0;
    const exits: number[] = [];
    const shutdown = createShutdown({
      drain: async () => {
        drains += 1;
      },
      exit: (code) => exits.push(code),
    });

    // An orchestrator sending SIGTERM twice in quick succession is ordinary.
    shutdown('SIGTERM');
    shutdown('SIGINT');
    await vi.waitUntil(() => exits.length > 0);

    expect(drains).toBe(1);
    expect(exits).toEqual([0]);
  });

  it('still exits when the drain rejects', async () => {
    const exits: number[] = [];
    const shutdown = createShutdown({
      drain: () => Promise.reject(new Error('collector unreachable')),
      exit: (code) => exits.push(code),
    });

    shutdown('SIGTERM');
    await vi.waitUntil(() => exits.length > 0);

    // Exiting late is survivable. Hanging until the platform sends SIGKILL is not, and a
    // failing audit transport must never be what keeps a process alive.
    expect(exits).toEqual([0]);
  });

  it('works with nothing to stop, which is the stdio case', async () => {
    const exits: number[] = [];
    const shutdown = createShutdown({
      drain: () => Promise.resolve(),
      exit: (code) => exits.push(code),
    });

    shutdown('SIGINT');
    await vi.waitUntil(() => exits.length > 0);

    expect(exits).toEqual([0]);
  });
});
