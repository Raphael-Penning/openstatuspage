import { describe, expect, it } from 'vitest';
import adminDe from '../../locales/de/admin.json';
import adminEn from '../../locales/en/admin.json';
import { testResultMessage } from './notifications';

describe('testResultMessage', () => {
  it('localizes a successful SMTP delivery with the recipient', () => {
    expect(testResultMessage({ ok: true, message: 'Test email sent' }, 'smtp', 'admin@example.com')).toEqual({
      key: 'notifications.testSentTo',
      values: { to: 'admin@example.com' },
    });
  });

  it('localizes a test email written to the server log', () => {
    expect(
      testResultMessage({ ok: true, message: 'Test email written to the server log' }, 'log', 'admin@example.com'),
    ).toEqual({ key: 'notifications.testWrittenToLog' });
  });

  it('keeps the server message on failure (SMTP error)', () => {
    const message = '535 5.7.8 Authentication failed';
    expect(testResultMessage({ ok: false, message }, 'smtp', 'admin@example.com')).toEqual({ text: message });
    expect(testResultMessage({ ok: false, message }, 'log', 'admin@example.com')).toEqual({ text: message });
  });

  it('has the success messages in English and German', () => {
    expect(adminEn.notifications.testSentTo).toContain('{{to}}');
    expect(adminDe.notifications.testSentTo).toContain('{{to}}');
    expect(adminEn.notifications.testWrittenToLog).toBeTruthy();
    expect(adminDe.notifications.testWrittenToLog).toBeTruthy();
  });
});
