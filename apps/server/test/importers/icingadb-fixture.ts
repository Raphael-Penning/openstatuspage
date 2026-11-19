/**
 * An in-memory database with the Icinga DB tables the importer reads (columns
 * as in the official schema: binary sha1 ids, event_time in ms), so the real
 * SQL of the importer runs in tests. SQLite accepts the same `?` placeholders as MySQL.
 */
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import type { SqlRunner } from '../../src/importers/icingadb.js';

const sha1 = (s: string) => createHash('sha1').update(s).digest();
const ENV = sha1('default');

export class IcingaDbImporterFixture {
  readonly db = new Database(':memory:');
  closed = false;

  constructor() {
    this.db.exec(`
      CREATE TABLE host (id BLOB PRIMARY KEY, environment_id BLOB NOT NULL, name TEXT NOT NULL, display_name TEXT NOT NULL);
      CREATE TABLE service (id BLOB PRIMARY KEY, environment_id BLOB NOT NULL, host_id BLOB NOT NULL, name TEXT NOT NULL, display_name TEXT NOT NULL);
      CREATE TABLE state_history (
        id BLOB PRIMARY KEY, environment_id BLOB NOT NULL, endpoint_id BLOB,
        object_type TEXT NOT NULL CHECK (object_type IN ('host', 'service')),
        host_id BLOB NOT NULL, service_id BLOB,
        event_time INTEGER NOT NULL, state_type TEXT NOT NULL,
        soft_state INTEGER NOT NULL, hard_state INTEGER NOT NULL,
        previous_soft_state INTEGER NOT NULL, previous_hard_state INTEGER NOT NULL,
        check_attempt INTEGER NOT NULL, output TEXT, long_output TEXT, max_check_attempts INTEGER NOT NULL
      );
      CREATE TABLE host_state (id BLOB PRIMARY KEY, host_id BLOB NOT NULL, environment_id BLOB NOT NULL,
        state_type TEXT NOT NULL, soft_state INTEGER NOT NULL, hard_state INTEGER NOT NULL, last_state_change INTEGER NOT NULL);
      CREATE TABLE service_state (id BLOB PRIMARY KEY, host_id BLOB NOT NULL, service_id BLOB NOT NULL, environment_id BLOB NOT NULL,
        state_type TEXT NOT NULL, soft_state INTEGER NOT NULL, hard_state INTEGER NOT NULL, last_state_change INTEGER NOT NULL);
    `);
  }

  private host(name: string): Buffer {
    const id = sha1(`host:${name}`);
    this.db.prepare('INSERT OR IGNORE INTO host VALUES (?, ?, ?, ?)').run(id, ENV, name, name);
    return id;
  }

  private service(host: string, name: string): { hostId: Buffer; serviceId: Buffer } {
    const hostId = this.host(host);
    const serviceId = sha1(`service:${host}!${name}`);
    this.db.prepare('INSERT OR IGNORE INTO service VALUES (?, ?, ?, ?, ?)').run(serviceId, ENV, hostId, name, name);
    return { hostId, serviceId };
  }

  /** A state_history row. `service` null = host event. */
  event(host: string, service: string | null, at: number, hardState: number, stateType: 'hard' | 'soft' = 'hard', softState = hardState): void {
    const ids = service ? this.service(host, service) : { hostId: this.host(host), serviceId: null };
    this.db
      .prepare(
        `INSERT INTO state_history VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 0, 0, 1, 'output', NULL, 3)`,
      )
      .run(sha1(`${host}!${service}!${at}`), ENV, service ? 'service' : 'host', ids.hostId, ids.serviceId, at, stateType, softState, hardState);
  }

  serviceState(host: string, service: string, hardState: number, lastStateChange: number): void {
    const { hostId, serviceId } = this.service(host, service);
    this.db
      .prepare(`INSERT INTO service_state VALUES (?, ?, ?, ?, 'hard', ?, ?, ?)`)
      .run(serviceId, hostId, serviceId, ENV, hardState, hardState, lastStateChange);
  }

  hostState(host: string, hardState: number, lastStateChange: number): void {
    const hostId = this.host(host);
    this.db.prepare(`INSERT INTO host_state VALUES (?, ?, ?, 'hard', ?, ?, ?)`).run(hostId, hostId, ENV, hardState, hardState, lastStateChange);
  }

  runner(): SqlRunner {
    return {
      query: async (sql, params) => this.db.prepare(sql).all(...(params as unknown[])) as Record<string, unknown>[],
      close: async () => {
        this.closed = true;
      },
    };
  }
}
