/**
 * Pure helpers of the email delivery panel on the settings page.
 */
import type { MailTransportKind } from '@openstatuspage/shared';

/** Response of POST /api/admin/notifications/test. */
export interface TestEmailResponse {
  ok: boolean;
  /** English text from the server; on failure the SMTP error. */
  message: string;
}

/** A localized message (admin namespace key plus values) or the server text as is. */
export type TestResultMessage = { key: string; values?: Record<string, string> } | { text: string };

/**
 * Message shown after a test email: successes are localized (the server text
 * is English), failures show the server message because it carries the SMTP
 * error.
 */
export function testResultMessage(result: TestEmailResponse, transport: MailTransportKind, to: string): TestResultMessage {
  if (!result.ok) return { text: result.message };
  if (transport === 'log') return { key: 'notifications.testWrittenToLog' };
  return { key: 'notifications.testSentTo', values: { to } };
}
