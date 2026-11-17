/**
 * Accessible form controls. Every control renders a <label>, optional help
 * text and a field error linked via aria-describedby.
 */
import { clsx } from 'clsx';
import { Search } from 'lucide-react';
import {
  useId,
  useMemo,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { useTranslation } from 'react-i18next';
import { timeZoneLabel } from '../lib/datetime';

export const inputClass = clsx(
  'block w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg placeholder:text-muted/70',
  'focus:border-accent focus:outline-2 focus:outline-offset-0 focus:outline-accent/30',
  'disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-status-major-outage',
);

interface FieldShellProps {
  id: string;
  label: ReactNode;
  help?: ReactNode;
  error?: string;
  required?: boolean;
  className?: string;
  children: ReactNode;
}

export function FieldShell({ id, label, help, error, required, className, children }: FieldShellProps) {
  return (
    <div className={clsx('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
        {required && (
          <span aria-hidden className="ml-0.5 text-status-major-outage">
            *
          </span>
        )}
      </label>
      {children}
      {help && !error && (
        <p id={`${id}-help`} className="text-xs text-muted">
          {help}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-xs text-status-major-outage">
          {error}
        </p>
      )}
    </div>
  );
}

function describedBy(id: string, help?: ReactNode, error?: string) {
  return [error ? `${id}-error` : null, help && !error ? `${id}-help` : null].filter(Boolean).join(' ') || undefined;
}

type Common = { label: ReactNode; help?: ReactNode; error?: string; className?: string };

export function TextField({
  label,
  help,
  error,
  className,
  value,
  onValue,
  ...rest
}: Common & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & { value: string; onValue: (v: string) => void }) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} help={help} error={error} required={rest.required} className={className}>
      <input
        id={id}
        className={inputClass}
        value={value}
        onChange={(e) => onValue(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, help, error)}
        {...rest}
      />
    </FieldShell>
  );
}

export function TextAreaField({
  label,
  help,
  error,
  className,
  value,
  onValue,
  rows = 4,
  ...rest
}: Common & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & { value: string; onValue: (v: string) => void }) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} help={help} error={error} required={rest.required} className={className}>
      <textarea
        id={id}
        rows={rows}
        className={inputClass}
        value={value}
        onChange={(e) => onValue(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, help, error)}
        {...rest}
      />
    </FieldShell>
  );
}

export interface Option<T extends string = string> {
  value: T;
  label: string;
}

export function SelectField<T extends string>({
  label,
  help,
  error,
  className,
  value,
  onValue,
  options,
  ...rest
}: Common &
  Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange'> & {
    value: T;
    onValue: (v: T) => void;
    options: Option<T>[];
  }) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} help={help} error={error} required={rest.required} className={className}>
      <select
        id={id}
        className={inputClass}
        value={value}
        onChange={(e) => onValue(e.target.value as T)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, help, error)}
        {...rest}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

/** Plain select without a visible label (label via aria-label), for table rows. */
export function InlineSelect<T extends string>({
  value,
  onValue,
  options,
  label,
  className,
  disabled,
}: {
  value: T;
  onValue: (v: T) => void;
  options: Option<T>[];
  label: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <select
      aria-label={label}
      title={label}
      className={clsx(inputClass, 'py-1.5', className)}
      value={value}
      disabled={disabled}
      onChange={(e) => onValue(e.target.value as T)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function CheckboxField({
  label,
  help,
  checked,
  onChecked,
  disabled,
  className,
}: {
  label: ReactNode;
  help?: ReactNode;
  checked: boolean;
  onChecked: (v: boolean) => void;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={clsx('flex items-start gap-2.5', className)}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChecked(e.target.checked)}
        aria-describedby={help ? `${id}-help` : undefined}
        className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]"
      />
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        {help && (
          <p id={`${id}-help`} className="text-xs text-muted">
            {help}
          </p>
        )}
      </div>
    </div>
  );
}

/** datetime-local input that labels the browser time zone (values are converted to UTC by the caller). */
export function DateTimeField({
  label,
  help,
  error,
  className,
  value,
  onValue,
  required,
  disabled,
}: Common & { value: string; onValue: (v: string) => void; required?: boolean; disabled?: boolean }) {
  const { t } = useTranslation('admin');
  const zone = useMemo(() => timeZoneLabel(), []);
  const id = useId();
  const helpText = (
    <>
      {t('form.timeZone', { zone })}
      {help && <> · {help}</>}
    </>
  );
  return (
    <FieldShell id={id} label={label} help={helpText} error={error} required={required} className={className}>
      <input
        id={id}
        type="datetime-local"
        className={inputClass}
        value={value}
        required={required}
        disabled={disabled}
        onChange={(e) => onValue(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, helpText, error)}
      />
    </FieldShell>
  );
}

/** Searchable checkbox list for selecting multiple entities (services, locations). */
export function MultiSelect({
  label,
  help,
  error,
  options,
  selected,
  onChange,
  disabled,
  className,
  renderExtra,
}: {
  label: string;
  help?: ReactNode;
  error?: string;
  options: { value: string; label: string; hint?: string }[];
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  className?: string;
  /** Extra content rendered next to a selected option (e.g. an impact picker). */
  renderExtra?: (value: string) => ReactNode;
}) {
  const { t } = useTranslation('admin');
  const [query, setQuery] = useState('');
  const groupId = useId();
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => `${o.label} ${o.hint ?? ''}`.toLowerCase().includes(q)) : options;
  }, [options, query]);
  const set = new Set(selected);
  const toggle = (value: string, on: boolean) =>
    onChange(on ? [...selected, value] : selected.filter((v) => v !== value));

  return (
    <fieldset className={clsx('flex flex-col gap-1.5', className)} aria-describedby={error ? `${groupId}-error` : undefined}>
      <legend className="mb-1.5 text-sm font-medium">
        {label}{' '}
        <span className="font-normal text-muted">({t('form.selectedCount', { count: selected.length })})</span>
      </legend>
      {options.length > 6 && (
        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('form.filter')}
            aria-label={t('form.filterLabel', { label })}
            className={clsx(inputClass, 'pl-8')}
            disabled={disabled}
          />
        </div>
      )}
      <div className="max-h-64 overflow-y-auto rounded-lg border border-border">
        {filtered.length === 0 && <p className="p-3 text-sm text-muted">{t('form.noOptions')}</p>}
        {filtered.map((o) => {
          const checked = set.has(o.value);
          const id = `${groupId}-${o.value}`;
          return (
            <div key={o.value} className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 last:border-b-0">
              <input
                id={id}
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={(e) => toggle(o.value, e.target.checked)}
                className="size-4 shrink-0 accent-[var(--accent)]"
              />
              <label htmlFor={id} className="min-w-0 flex-1 text-sm">
                {o.label}
                {o.hint && <span className="ml-1.5 text-xs text-muted">{o.hint}</span>}
              </label>
              {checked && renderExtra?.(o.value)}
            </div>
          );
        })}
      </div>
      {help && !error && <p className="text-xs text-muted">{help}</p>}
      {error && (
        <p id={`${groupId}-error`} className="text-xs text-status-major-outage">
          {error}
        </p>
      )}
    </fieldset>
  );
}

/** Form-level error summary shown above the submit button. */
export function FormErrorSummary({ errors }: { errors: Record<string, unknown> }) {
  const { t } = useTranslation('admin');
  if (Object.keys(errors).length === 0) return null;
  return (
    <p role="alert" className="rounded-lg bg-status-major-outage/10 px-3 py-2 text-sm text-status-major-outage">
      {t('form.fixErrors')}
    </p>
  );
}
