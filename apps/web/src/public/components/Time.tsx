import { useFormat } from '../hooks/preferences';

/** Relative time ("2 hours ago") with the absolute time on hover. */
export function RelativeTime({ value, className }: { value: string; className?: string }) {
  const f = useFormat();
  return (
    <time dateTime={value} title={f.dateTime(value)} className={className}>
      {f.relative(value)}
    </time>
  );
}

/** Absolute date and time in the selected time zone, relative time on hover. */
export function DateTime({ value, className }: { value: string; className?: string }) {
  const f = useFormat();
  return (
    <time dateTime={value} title={f.relative(value)} className={className}>
      {f.dateTime(value)}
    </time>
  );
}

/** Time window, shortened when both ends are on the same day. */
export function TimeRange({ start, end, className }: { start: string; end: string; className?: string }) {
  const f = useFormat();
  return (
    <span className={className}>
      <time dateTime={start} className="sr-only">
        {f.dateTime(start)}
      </time>
      <span aria-hidden>{f.range(start, end)}</span>
      <time dateTime={end} className="sr-only">
        {` – ${f.dateTime(end)}`}
      </time>
    </span>
  );
}
