import type { NotificationStatus } from '@openstatuspage/shared';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mailDnsRecords, parseDkimTxt, readDkimPublicKeys, senderDomain } from '../src/mail/dns.js';
import { MemoryMailer } from '../src/mail/mailer.js';
import { adminClient, createTestApp, data } from './helpers.js';

const KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAx1example2key3data4AB+/w==';
/** As written by `rspamadm dkim_keygen` (bundled Postfix) and opendkim-genkey (scripts/install.sh). */
const RSPAMD = `mail._domainkey IN TXT ( "v=DKIM1; k=rsa; "\n\t"p=${KEY.slice(0, 30)}"\n\t"${KEY.slice(30)}" ) ;\n`;
const OPENDKIM = `osp._domainkey\tIN\tTXT\t( "v=DKIM1; h=sha256; k=rsa; "\n\t  "p=${KEY}" )  ; ----- DKIM key osp for example.org\n`;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'osp-dkim-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('DKIM public keys', () => {
  it('parses rspamd and opendkim output', () => {
    expect(parseDkimTxt(RSPAMD, 'example.com')).toEqual({ domain: 'example.com', selector: 'mail', value: `v=DKIM1; k=rsa; p=${KEY}` });
    expect(parseDkimTxt(OPENDKIM, 'example.org')).toEqual({
      domain: 'example.org',
      selector: 'osp',
      value: `v=DKIM1; h=sha256; k=rsa; p=${KEY}`,
    });
  });

  it('rejects anything that is not a DKIM public key', () => {
    expect(parseDkimTxt('-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----', 'example.com')).toBeNull();
    expect(parseDkimTxt(RSPAMD.replace('p=', 'p=<script>'), 'example.com')).toBeNull();
    expect(parseDkimTxt(RSPAMD.replace('DKIM1', 'spf1'), 'example.com')).toBeNull();
    expect(parseDkimTxt(RSPAMD, 'not a domain')).toBeNull();
  });

  it('reads <domain>.<selector>.txt and <domain>.txt files and ignores private keys', async () => {
    await writeFile(join(dir, 'example.com.mail.txt'), RSPAMD);
    await writeFile(join(dir, 'example.org.txt'), OPENDKIM);
    await writeFile(join(dir, 'example.com.mail.key'), '-----BEGIN PRIVATE KEY-----');
    expect((await readDkimPublicKeys(dir)).map((k) => [k.domain, k.selector])).toEqual([
      ['example.com', 'mail'],
      ['example.org', 'osp'],
    ]);
    expect(await readDkimPublicKeys(join(dir, 'missing'))).toEqual([]);
  });

  it('builds the records of the sender domain', async () => {
    await writeFile(join(dir, 'example.com.mail.txt'), RSPAMD);
    expect(senderDomain('Example Status <status@example.com>')).toBe('example.com');
    expect(await mailDnsRecords(dir, 'Example Status <status@example.org>')).toBeNull();
    expect(await mailDnsRecords(undefined, 'status@example.com')).toBeNull();
    const dns = await mailDnsRecords(dir, 'Example Status <status@example.com>');
    expect(dns).toMatchObject({ domain: 'example.com', selector: 'mail' });
    expect(dns!.records.map((r) => [r.kind, r.name])).toEqual([
      ['spf', 'example.com'],
      ['dkim', 'mail._domainkey.example.com'],
      ['dmarc', '_dmarc.example.com'],
    ]);
    expect(dns!.records[1]!.value).toBe(`v=DKIM1; k=rsa; p=${KEY}`);
  });

  it('shows the records in the notification status of admins', async () => {
    await writeFile(join(dir, 'example.com.mail.txt'), RSPAMD);
    const t = await createTestApp({ MAIL_DKIM_DIR: dir }, { mailer: new MemoryMailer() });
    try {
      const admin = await adminClient(t);
      const status = data<NotificationStatus>(await admin.get('/api/admin/notifications/status'));
      expect(status.dns?.records.find((r) => r.kind === 'dkim')?.name).toBe('mail._domainkey.example.com');
    } finally {
      await t.close();
    }
  });
});
