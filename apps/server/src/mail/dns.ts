/**
 * DNS records for the bundled send-only mail server (docs/guide: "Bundled mail
 * server"). The mail server (the postfix service of the Compose files, or the
 * local Postfix of scripts/install.sh) generates a DKIM key pair and writes only
 * the PUBLIC part as a zone-file snippet into a directory that the app reads
 * (MAIL_DKIM_DIR, mounted read-only). The private key never reaches the app.
 *
 * File format (rspamadm dkim_keygen and opendkim-genkey write the same shape):
 *
 *   mail._domainkey IN TXT ( "v=DKIM1; k=rsa; "
 *       "p=MIIBIjANBg..." ) ;
 *
 * Files are named `<domain>.<selector>.txt` or `<domain>.txt`; the selector is
 * taken from the record name, the domain from the file name.
 */
import type { MailDnsRecord, MailDnsRecords } from '@openstatuspage/shared';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Upper bound of one key file: a 4096 bit RSA key is about 1 KB. */
const MAX_FILE_BYTES = 16 * 1024;
/** Most key files read (one per sender domain). */
const MAX_FILES = 20;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const SELECTOR = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export interface DkimPublicKey {
  domain: string;
  selector: string;
  /** TXT value, e.g. `v=DKIM1; k=rsa; p=...`. */
  value: string;
}

/**
 * Parses one zone-file snippet. Returns null for anything that is not exactly a
 * DKIM TXT record with an RSA or Ed25519 public key (base64 only).
 */
export function parseDkimTxt(text: string, fileDomain: string): DkimPublicKey | null {
  if (!DOMAIN.test(fileDomain)) return null;
  const name = /^\s*([A-Za-z0-9-]+)\._domainkey(?:\.[A-Za-z0-9.-]+)?\s/m.exec(text);
  if (!name || !SELECTOR.test(name[1]!)) return null;
  // Concatenate the quoted strings of the record ("..." "...").
  const parts = [...text.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
  const value = parts
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  const tags = new Map(
    value
      .split(';')
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => {
        const i = t.indexOf('=');
        if (i < 0) return ['', ''] as const;
        return [t.slice(0, i).trim().toLowerCase(), t.slice(i + 1).replace(/\s+/g, '')] as const;
      }),
  );
  const p = tags.get('p');
  if (tags.get('v') !== 'DKIM1' || !p || !/^[A-Za-z0-9+/]+={0,2}$/.test(p)) return null;
  const k = tags.get('k') ?? 'rsa';
  if (k !== 'rsa' && k !== 'ed25519') return null;
  // Normalised value: only the tags DNS needs.
  const h = tags.get('h');
  const normalised = [`v=DKIM1`, ...(h && /^[a-z0-9:]+$/.test(h) ? [`h=${h}`] : []), `k=${k}`, `p=${p}`].join('; ');
  return { domain: fileDomain.toLowerCase(), selector: name[1]!.toLowerCase(), value: normalised };
}

/** Reads every `*.txt` DKIM public key of `dir`. Missing or unreadable directory: []. */
export async function readDkimPublicKeys(dir: string): Promise<DkimPublicKey[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.txt')).sort().slice(0, MAX_FILES);
  } catch {
    return [];
  }
  const keys: DkimPublicKey[] = [];
  for (const name of names) {
    const file = join(dir, name);
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) continue;
      const base = name.slice(0, -'.txt'.length);
      const text = await readFile(file, 'utf8');
      // <domain>.<selector>.txt (rspamd) or <domain>.txt (opendkim): the selector
      // comes from the record name, so strip it from the file name when it is there.
      const selector = /^\s*([A-Za-z0-9-]+)\._domainkey/m.exec(text)?.[1]?.toLowerCase();
      const domain = selector && base.toLowerCase().endsWith(`.${selector}`) ? base.slice(0, -selector.length - 1) : base;
      const key = parseDkimTxt(text, domain);
      if (key) keys.push(key);
    } catch {
      // A file that disappears or cannot be read is skipped.
    }
  }
  return keys;
}

/** Domain of the sender address, e.g. `Example <status@example.com>` -> example.com. */
export function senderDomain(from: string | null | undefined): string | null {
  const m = from ? /@([^\s@>]+)>?\s*$/.exec(from) : null;
  const domain = m?.[1]?.toLowerCase() ?? null;
  return domain && DOMAIN.test(domain) ? domain : null;
}

/**
 * The records to publish for the sender domain: SPF (the server's address is not
 * known to the app, so it is a placeholder to replace), the DKIM key and a DMARC
 * suggestion. Null when no key for the sender domain is available.
 */
export async function mailDnsRecords(dir: string | undefined, from: string | null): Promise<MailDnsRecords | null> {
  if (!dir) return null;
  const domain = senderDomain(from);
  if (!domain) return null;
  const key = (await readDkimPublicKeys(dir)).find((k) => k.domain === domain);
  if (!key) return null;
  const records: MailDnsRecord[] = [
    { kind: 'spf', type: 'TXT', name: domain, value: 'v=spf1 ip4:<server-ipv4> ip6:<server-ipv6> -all' },
    { kind: 'dkim', type: 'TXT', name: `${key.selector}._domainkey.${domain}`, value: key.value },
    { kind: 'dmarc', type: 'TXT', name: `_dmarc.${domain}`, value: 'v=DMARC1; p=quarantine; adkim=s; aspf=s' },
  ];
  return { domain, selector: key.selector, records };
}
