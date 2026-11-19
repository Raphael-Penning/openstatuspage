/**
 * Worker and task leases without a database server: SQLite keeps the single
 * instance behaviour, a coordinator decides which runs happen.
 * The PostgreSQL side is covered by multi-instance.pg.test.ts.
 */
import type { FastifyBaseLogger } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { scheduleSlackMs, withLease, type ClaimOptions, type TaskCoordinator } from '../src/lib/task-leases.js';
import { startBackgroundTasks, LEASE_CLEANUP_TASK, POLLER_SYNC_TASK } from '../src/startup.js';
import { Worker } from '../src/worker.js';
import { createTestApp, type TestApp } from './helpers.js';

const log = { error: () => undefined, warn: () => undefined } as unknown as FastifyBaseLogger;

class FakeCoordinator implements TaskCoordinator {
  readonly owner = 'fake';
  readonly renewEveryMs = 10;
  claims: { name: string; options: ClaimOptions }[] = [];
  released: string[] = [];
  renewals = 0;
  grant = true;
  held = true;

  async claim(name: string, options: ClaimOptions = {}): Promise<boolean> {
    this.claims.push({ name, options });
    return this.grant;
  }
  async renew(): Promise<boolean> {
    this.renewals++;
    return this.held;
  }
  async release(name: string): Promise<void> {
    this.released.push(name);
  }
}

describe('Worker with a coordinator', () => {
  it('runs a task only when the lease is granted and releases it afterwards', async () => {
    const coordinator = new FakeCoordinator();
    const worker = new Worker(log, coordinator);
    let runs = 0;
    worker.schedule('job', 60_000, async () => {
      runs++;
    });
    await worker.runScheduled('job');
    expect(runs).toBe(1);
    expect(coordinator.claims).toEqual([{ name: 'job', options: { intervalMs: 60_000, changedAt: undefined } }]);
    expect(coordinator.released).toEqual(['job']);

    coordinator.grant = false;
    await worker.runScheduled('job');
    expect(runs).toBe(1);
    expect(coordinator.released).toEqual(['job']);
  });

  it('claims without interval for run-now and passes changedAt to the first scheduled run only', async () => {
    const coordinator = new FakeCoordinator();
    const worker = new Worker(log, coordinator);
    worker.schedule('job', 30_000, async () => undefined, { changedAt: 1234 });
    await worker.runNow('job');
    await worker.runScheduled('job');
    await worker.runScheduled('job');
    expect(coordinator.claims.map((c) => [c.options.intervalMs, c.options.changedAt])).toEqual([
      [null, undefined],
      [30_000, undefined],
      [30_000, undefined],
    ]);

    const fresh = new FakeCoordinator();
    const w2 = new Worker(log, fresh);
    w2.schedule('job', 30_000, async () => undefined, { changedAt: 1234 });
    await w2.runScheduled('job');
    await w2.runScheduled('job');
    expect(fresh.claims.map((c) => c.options.changedAt)).toEqual([1234, undefined]);
  });

  it('runs local tasks without a lease', async () => {
    const coordinator = new FakeCoordinator();
    coordinator.grant = false;
    const worker = new Worker(log, coordinator);
    let runs = 0;
    worker.schedule('sync', 30_000, async () => void runs++, { local: true });
    await worker.runScheduled('sync');
    expect(runs).toBe(1);
    expect(coordinator.claims).toEqual([]);
  });

  it('renews the lease while a task runs and reports a lost lease', async () => {
    const coordinator = new FakeCoordinator();
    coordinator.held = false;
    let lost = 0;
    const result = await withLease(coordinator, 'slow', { onLost: () => lost++ }, async () => {
      await new Promise((r) => setTimeout(r, 60));
      return 'done';
    });
    expect(result).toEqual({ ran: true, value: 'done' });
    expect(coordinator.renewals).toBeGreaterThan(1);
    expect(lost).toBe(1);
  });

  it('counts a scheduled run as due slightly before the full interval', () => {
    expect(scheduleSlackMs(10_000)).toBe(1000);
    expect(scheduleSlackMs(60_000)).toBe(2000);
    expect(scheduleSlackMs(100)).toBe(10);
  });
});

describe('SQLite (single instance)', () => {
  let t: TestApp | undefined;
  afterEach(async () => {
    t?.app.ctx.worker.stop();
    await t?.close();
    t = undefined;
  });

  it('runs every task locally without leases', async () => {
    t = await createTestApp();
    const { ctx } = t.app;
    expect(ctx.leases).toBeNull();
    expect(ctx.worker.coordinator).toBeNull();
    expect(await startBackgroundTasks(ctx)).toBe(true);
    expect(ctx.worker.taskNames()).toContain(POLLER_SYNC_TASK);
    expect(ctx.worker.taskNames()).not.toContain(LEASE_CLEANUP_TASK);
    let runs = 0;
    ctx.worker.schedule('job', 60_000, async () => void runs++);
    await new Promise((r) => setImmediate(r));
    await ctx.worker.runScheduled('job');
    await ctx.worker.runScheduled('job');
    expect(runs).toBe(3); // started worker: immediate run + two scheduled runs
  });
});
