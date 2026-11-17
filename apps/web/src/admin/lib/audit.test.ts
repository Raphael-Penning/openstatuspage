import { describe, expect, it } from 'vitest';
import adminDe from '../../locales/de/admin.json';
import adminEn from '../../locales/en/admin.json';
import { AUDIT_ENTITY_TYPES } from './audit';

describe('AUDIT_ENTITY_TYPES', () => {
  it('offers every labelled entity type, including the email notifications', () => {
    expect(AUDIT_ENTITY_TYPES).toContain('notifications');
    expect([...AUDIT_ENTITY_TYPES].sort()).toEqual(Object.keys(adminEn.audit.entities).sort());
  });

  it('has a label for every entity type in English and German', () => {
    for (const type of AUDIT_ENTITY_TYPES) {
      expect(adminEn.audit.entities[type]).toBeTruthy();
      expect(adminDe.audit.entities[type]).toBeTruthy();
    }
  });
});
