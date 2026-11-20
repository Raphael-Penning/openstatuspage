/**
 * Minimal in-process task runner for periodic background jobs and one-off jobs
 * that run after a request has been answered.
 * Each task runs at most once at a time; errors are logged and the task keeps running.
 *
 * With a coordinator (PostgreSQL, see lib/task-leases.ts) a task only runs after
 * claiming its lease: several instances never run the same task at once, and a
 * scheduled run happens once per interval in the whole deployment.
 */
import type { FastifyBaseLogger } from 'fastify';
import { withLease, type TaskCoordinator } from './lib/task-leases.js';

interface Task {
  name: string;
  intervalMs: number;
  run: (signal: AbortSignal) => Promise<void>;
  /** Runs on every instance without a lease (e.g. syncing this instance's own schedule). */
  local: boolean;
  /** See ScheduleOptions.changedAt; used by the first scheduled run only. */
  changedAt?: number;
  timer?: NodeJS.Timeout;
  running: boolean;
}

export interface ScheduleOptions {
  /** Run on every instance, without a lease. Default false (one instance at a time). */
  local?: boolean;
  /**
   * When the task's settings last changed (ms since the epoch). The run right after
   * scheduling is then due if no instance started the task since, even before the
   * interval has passed (an edited monitoring source is polled right away once).
   */
  changedAt?: number;
}

export class Worker {
  private readonly tasks = new Map<string, Task>();
  private readonly detached = new Set<Promise<void>>();
  private readonly abort = new AbortController();
  private started = false;

  constructor(
    private readonly log: FastifyBaseLogger,
    /** Leases shared with other instances; null runs every task locally (SQLite). */
    readonly coordinator: TaskCoordinator | null = null,
  ) {}

  /** Registers (or replaces) a periodic task. */
  schedule(
    name: string,
    intervalMs: number,
    run: (signal: AbortSignal) => Promise<void>,
    options: ScheduleOptions = {},
  ): void {
    this.unschedule(name);
    const task: Task = {
      name,
      intervalMs,
      run,
      local: options.local === true,
      changedAt: options.changedAt,
      running: false,
    };
    this.tasks.set(name, task);
    if (this.started) this.arm(task, true);
  }

  unschedule(name: string): void {
    const task = this.tasks.get(name);
    if (task?.timer) clearInterval(task.timer);
    this.tasks.delete(name);
  }

  has(name: string): boolean {
    return this.tasks.has(name);
  }

  /** Names of the registered periodic tasks. */
  taskNames(): string[] {
    return [...this.tasks.keys()];
  }

  /** Whether start() armed the periodic tasks. */
  get running(): boolean {
    return this.started;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const task of this.tasks.values()) this.arm(task, true);
  }

  stop(): void {
    this.abort.abort();
    for (const task of this.tasks.values()) if (task.timer) clearInterval(task.timer);
    this.started = false;
  }

  /**
   * Runs a task immediately (outside its schedule), e.g. after a config change.
   * With a coordinator it is skipped while another instance runs the task.
   */
  async runNow(name: string): Promise<void> {
    const task = this.tasks.get(name);
    if (task) await this.exec(task, false);
  }

  /** Runs a task as its timer does: with a coordinator only when it is due (tests). */
  async runScheduled(name: string): Promise<void> {
    const task = this.tasks.get(name);
    if (task) await this.exec(task, true);
  }

  /** Runs a one-off job in the background. Errors are logged; idle() waits for it. */
  runDetached(name: string, run: () => Promise<void>): void {
    const job = run()
      .catch((err: unknown) => this.log.error({ err, task: name }, 'background task failed'))
      .finally(() => this.detached.delete(job));
    this.detached.add(job);
  }

  /** Resolves once no one-off job is running (shutdown, tests). */
  async idle(): Promise<void> {
    while (this.detached.size > 0) await Promise.all([...this.detached]);
  }

  private arm(task: Task, runImmediately: boolean): void {
    task.timer = setInterval(() => void this.exec(task, true), task.intervalMs);
    task.timer.unref();
    if (runImmediately) void this.exec(task, true);
  }

  private async exec(task: Task, scheduled: boolean): Promise<void> {
    if (task.running || this.abort.signal.aborted) return;
    task.running = true;
    const changedAt = scheduled ? task.changedAt : undefined;
    task.changedAt = undefined;
    try {
      await withLease(
        task.local ? null : this.coordinator,
        task.name,
        {
          intervalMs: scheduled ? task.intervalMs : null,
          changedAt,
          onLost: () =>
            this.log.warn({ task: task.name }, 'background task lease lost; another instance may run it as well'),
        },
        () => task.run(this.abort.signal),
      );
    } catch (err) {
      this.log.error({ err, task: task.name }, 'background task failed');
    } finally {
      task.running = false;
    }
  }
}
