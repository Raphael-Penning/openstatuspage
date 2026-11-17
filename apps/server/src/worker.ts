/**
 * Minimal in-process task runner for periodic background jobs.
 * Each task runs at most once at a time; errors are logged and the task keeps running.
 */
import type { FastifyBaseLogger } from 'fastify';

interface Task {
  name: string;
  intervalMs: number;
  run: (signal: AbortSignal) => Promise<void>;
  timer?: NodeJS.Timeout;
  running: boolean;
}

export class Worker {
  private readonly tasks = new Map<string, Task>();
  private readonly abort = new AbortController();
  private started = false;

  constructor(private readonly log: FastifyBaseLogger) {}

  /** Registers (or replaces) a periodic task. */
  schedule(name: string, intervalMs: number, run: (signal: AbortSignal) => Promise<void>): void {
    this.unschedule(name);
    const task: Task = { name, intervalMs, run, running: false };
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

  /** Runs a task immediately (outside its schedule), e.g. after a config change. */
  async runNow(name: string): Promise<void> {
    const task = this.tasks.get(name);
    if (task) await this.exec(task);
  }

  private arm(task: Task, runImmediately: boolean): void {
    task.timer = setInterval(() => void this.exec(task), task.intervalMs);
    task.timer.unref();
    if (runImmediately) void this.exec(task);
  }

  private async exec(task: Task): Promise<void> {
    if (task.running || this.abort.signal.aborted) return;
    task.running = true;
    try {
      await task.run(this.abort.signal);
    } catch (err) {
      this.log.error({ err, task: task.name }, 'background task failed');
    } finally {
      task.running = false;
    }
  }
}
