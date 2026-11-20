/**
 * Shared Intl formatters. Creating one is expensive (ICU data, native memory
 * that the garbage collector does not see), and a page formats hundreds of
 * values (every day of every uptime bar), in the browser and in the server
 * render alike. Formatters are reused per locale and options.
 */
const formatters = new Map<string, Intl.DateTimeFormat | Intl.NumberFormat | Intl.RelativeTimeFormat>();
/** Locales × option sets in use are few; the bound only guards against surprises. */
const MAX_FORMATTERS = 200;

function cached<T extends Intl.DateTimeFormat | Intl.NumberFormat | Intl.RelativeTimeFormat>(
  kind: string,
  locale: string,
  options: object,
  create: () => T,
): T {
  const key = `${kind}\u0000${locale}\u0000${JSON.stringify(options)}`;
  let formatter = formatters.get(key) as T | undefined;
  if (!formatter) {
    if (formatters.size >= MAX_FORMATTERS) formatters.clear();
    formatter = create();
    formatters.set(key, formatter);
  }
  return formatter;
}

export function dateTimeFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return cached('dt', locale, options, () => new Intl.DateTimeFormat(locale, options));
}

export function numberFormat(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  return cached('nf', locale, options, () => new Intl.NumberFormat(locale, options));
}

export function relativeTimeFormat(locale: string, options: Intl.RelativeTimeFormatOptions): Intl.RelativeTimeFormat {
  return cached('rtf', locale, options, () => new Intl.RelativeTimeFormat(locale, options));
}
