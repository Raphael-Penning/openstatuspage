import { LocationInput, MaintenanceCreateInput, MonitorSourceInput, ServiceInput } from '@openstatuspage/shared';
import { describe, expect, it } from 'vitest';
import { errorFor, issueMessage, issuesToFieldErrors } from './validation';

describe('issuesToFieldErrors', () => {
  it('maps client-side zod issues to fields', () => {
    const res = LocationInput.safeParse({ name: '', slug: 'Bad Slug', region: 'europe', country: 'de', latitude: 200 });
    expect(res.success).toBe(false);
    const errors = issuesToFieldErrors(res.error!.issues);
    expect(errors.name).toEqual({ key: 'validation.required' });
    expect(errors.slug).toEqual({ key: 'validation.format' });
    expect(errors.country).toEqual({ key: 'validation.format' });
    expect(errors.latitude).toEqual({ key: 'validation.max', values: { max: 90 } });
  });

  it('maps nested paths and missing values', () => {
    const res = MonitorSourceInput.safeParse({ type: 'icinga2', name: 'x', config: { baseUrl: 'nope' } });
    const errors = issuesToFieldErrors(res.error!.issues);
    expect(errors['config.baseUrl']).toEqual({ key: 'validation.url' });
    expect(errors['config.username']).toEqual({ key: 'validation.required' });
    expect(errorFor(errors, 'config')).toEqual({ key: 'validation.url' });
  });

  it('maps refinements (end after start)', () => {
    const res = MaintenanceCreateInput.safeParse({
      title: 'Window',
      scheduledStart: '2026-01-02T00:00:00Z',
      scheduledEnd: '2026-01-01T00:00:00Z',
    });
    expect(issuesToFieldErrors(res.error!.issues).scheduledEnd).toEqual({ key: 'validation.endAfterStart' });
  });

  it('maps serialized server issues (JSON, no input field)', () => {
    const serverIssues = [
      { origin: 'string', code: 'too_small', minimum: 1, inclusive: true, path: ['name'], message: 'Too small' },
      {
        expected: 'string',
        code: 'invalid_type',
        path: ['config', 'password'],
        message: 'Invalid input: expected string, received undefined',
      },
      { code: 'invalid_format', format: 'email', path: ['email'], message: 'Invalid email' },
      { origin: 'string', code: 'too_small', minimum: 10, path: ['password'], message: 'Too small' },
    ];
    expect(issuesToFieldErrors(serverIssues)).toEqual({
      name: { key: 'validation.required' },
      'config.password': { key: 'validation.required' },
      email: { key: 'validation.email' },
      password: { key: 'validation.minLength', values: { min: 10 } },
    });
  });

  it('keeps only the first issue per field and tolerates garbage', () => {
    const errors = issuesToFieldErrors([
      { code: 'too_small', origin: 'string', minimum: 1, path: ['name'] },
      { code: 'too_big', origin: 'string', maximum: 5, path: ['name'] },
      null,
      'oops',
    ]);
    expect(Object.keys(errors)).toEqual(['name']);
    expect(errors.name?.key).toBe('validation.required');
    expect(issuesToFieldErrors(undefined)).toEqual({});
  });

  it('maps array item paths of the service builder', () => {
    const res = ServiceInput.safeParse({ name: 'Svc', checks: [{ checkId: '' }] });
    expect(Object.keys(issuesToFieldErrors(res.error!.issues))).toEqual(['checks.0.checkId']);
  });
});

describe('issueMessage', () => {
  it('handles numbers and unknown codes', () => {
    expect(issueMessage({ code: 'too_small', origin: 'number', minimum: 10 })).toEqual({
      key: 'validation.min',
      values: { min: 10 },
    });
    expect(issueMessage({ code: 'invalid_type', expected: 'number', input: 'x' })).toEqual({ key: 'validation.number' });
    expect(issueMessage({ code: 'something_new' })).toEqual({ key: 'validation.invalid' });
  });
});
