/**
 * Minimal form state hook: values, field errors from zod issues (client side
 * safeParse and server 400 responses) and translated error lookup.
 */
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../lib/api';
import { errorFor, issuesToFieldErrors, type FieldErrors } from './validation';

interface SafeParser<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false; error: { issues: unknown } };
}

export function useForm<V extends object>(initial: V | (() => V)) {
  const { t } = useTranslation('admin');
  const [values, setValues] = useState<V>(initial);
  const [errors, setErrors] = useState<FieldErrors>({});

  const set = useCallback(<K extends keyof V>(field: K, value: V[K]) => {
    setValues((v) => ({ ...v, [field]: value }));
    setErrors((e) => {
      const key = String(field);
      if (!Object.keys(e).some((k) => k === key || k.startsWith(`${key}.`))) return e;
      const next: FieldErrors = {};
      for (const [k, v] of Object.entries(e)) if (k !== key && !k.startsWith(`${key}.`)) next[k] = v;
      return next;
    });
  }, []);

  /** Validates `payload`; returns the parsed data or null after setting field errors. */
  const validate = useCallback(<T,>(schema: SafeParser<T>, payload: unknown): T | null => {
    const res = schema.safeParse(payload);
    if (res.success) {
      setErrors({});
      return res.data;
    }
    setErrors(issuesToFieldErrors(res.error.issues));
    return null;
  }, []);

  /** Maps a 400 response with zod issues to field errors. Returns true when handled. */
  const applyServerError = useCallback((error: unknown): boolean => {
    if (error instanceof ApiError && error.status === 400 && Array.isArray(error.body?.issues)) {
      const mapped = issuesToFieldErrors(error.body.issues);
      if (Object.keys(mapped).length > 0) {
        setErrors(mapped);
        return false; // still show the generic toast
      }
    }
    if (error instanceof ApiError && error.status === 409 && /slug/i.test(error.body?.message ?? '')) {
      setErrors({ slug: { key: 'validation.slugTaken' } });
    }
    if (error instanceof ApiError && error.status === 409 && /e-mail/i.test(error.body?.message ?? '')) {
      setErrors({ email: { key: 'validation.emailTaken' } });
    }
    return false;
  }, []);

  /** Translated error message for a field (or a nested path below it). */
  const error = useCallback(
    (field: string): string | undefined => {
      const e = errorFor(errors, field);
      return e ? t(e.key, e.values ?? {}) : undefined;
    },
    [errors, t],
  );

  return { values, setValues, set, errors, setErrors, validate, applyServerError, error };
}
