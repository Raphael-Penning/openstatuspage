import { describe, expect, it } from 'vitest';
import { SecretBox } from '../src/lib/crypto.js';

describe('SecretBox', () => {
  const box = new SecretBox('test-secret-key-that-is-long-enough-1234567890');

  it('round-trips values and rejects other keys', () => {
    const sealed = box.encryptJson({ password: 'secret' });
    expect(sealed).toMatch(/^v1\./);
    expect(box.decryptJson(sealed)).toEqual({ password: 'secret' });
    expect(() => new SecretBox('another-secret-key-that-is-long-enough-123').decrypt(sealed)).toThrow();
  });

  it('only accepts full 16-byte authentication tags', () => {
    const [version, iv, tag, data] = box.encrypt('secret').split('.') as [string, string, string, string];
    const full = Buffer.from(tag, 'base64url');
    expect(full).toHaveLength(16);
    for (const length of [4, 8, 12, 15]) {
      const truncated = [version, iv, full.subarray(0, length).toString('base64url'), data].join('.');
      expect(() => box.decrypt(truncated), `${length} bytes`).toThrow('Unsupported secret format');
    }
  });
});
