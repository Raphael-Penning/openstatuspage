// @vitest-environment jsdom
/**
 * The DNS records of the bundled mail server on the settings page: one copy
 * field per record with a labelled input, nothing without a bundled server.
 */
import type { MailDnsRecords } from '@openstatuspage/shared';
import i18next from 'i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { beforeAll, describe, expect, it } from 'vitest';
import adminEn from '../../locales/en/admin.json';
import commonEn from '../../locales/en/common.json';
import { MailDnsRecordsSection } from './NotificationStatusPanel';
import { ToastProvider } from './Toast';

const DNS: MailDnsRecords = {
  domain: 'example.com',
  selector: 'osp',
  records: [
    { kind: 'spf', type: 'TXT', name: 'example.com', value: 'v=spf1 ip4:<server-ipv4> ip6:<server-ipv6> -all' },
    { kind: 'dkim', type: 'TXT', name: 'osp._domainkey.example.com', value: 'v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA' },
    { kind: 'dmarc', type: 'TXT', name: '_dmarc.example.com', value: 'v=DMARC1; p=quarantine; adkim=s; aspf=s' },
  ],
};

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { common: commonEn, admin: adminEn } },
    ns: ['common', 'admin'],
    defaultNS: 'common',
    interpolation: { escapeValue: false },
  });
});

function render(dns: MailDnsRecords | null): HTMLElement {
  const html = renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ToastProvider>
        <MailDnsRecordsSection dns={dns} />
      </ToastProvider>
    </I18nextProvider>,
  );
  const root = new DOMParser().parseFromString(`<div id="root">${html}</div>`, 'text/html').getElementById('root');
  if (!root) throw new Error('no root');
  return root;
}

describe('MailDnsRecordsSection', () => {
  it('shows SPF, DKIM and DMARC with a labelled read-only field and a copy button each', () => {
    const root = render(DNS);
    const section = root.querySelector('section');
    expect(section).not.toBeNull();
    const heading = root.querySelector(`#${section!.getAttribute('aria-labelledby')}`);
    expect(heading?.textContent).toBe('DNS records for the bundled mail server');
    expect(root.textContent).toContain('example.com');

    const inputs = [...root.querySelectorAll('input')];
    expect(inputs.map((i) => i.getAttribute('value'))).toEqual(DNS.records.map((r) => r.value));
    for (const input of inputs) {
      expect(input.hasAttribute('readonly')).toBe(true);
      const label = root.querySelector(`label[for="${input.id}"]`);
      expect(label).not.toBeNull();
    }
    expect([...root.querySelectorAll('label')].map((l) => l.textContent)).toEqual([
      'SPF (example.com)',
      'DKIM (osp._domainkey.example.com)',
      'DMARC (_dmarc.example.com)',
    ]);

    const buttons = [...root.querySelectorAll('button')];
    expect(buttons).toHaveLength(3);
    // Inside the settings form: the copy buttons must never submit it.
    for (const button of buttons) expect(button.getAttribute('type')).toBe('button');
    expect(buttons[1]?.getAttribute('aria-label')).toBe('Copy DKIM (osp._domainkey.example.com)');
  });

  it('renders nothing without a bundled mail server', () => {
    const root = render(null);
    expect(root.querySelector('section')).toBeNull();
    expect(root.querySelector('input')).toBeNull();
    expect(root.textContent).toBe('');
  });
});
