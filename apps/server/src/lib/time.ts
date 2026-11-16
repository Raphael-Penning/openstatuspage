/** Current time as ISO-8601 UTC string. All timestamps in the DB use this format. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Normalizes any parseable timestamp to ISO-8601 UTC. */
export function toIso(value: string | number | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid timestamp: ${String(value)}`);
  return d.toISOString();
}

export function addSeconds(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}
