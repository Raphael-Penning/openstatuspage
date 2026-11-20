/**
 * Translations of the management UI (admin, help namespaces), added to the
 * shared i18next instance (lib/i18n.ts) when the management UI loads. The public
 * pages never load this module, so their bundle stays without these strings.
 * Add a language here as well as in lib/i18n.ts.
 */
import adminDe from '../locales/de/admin.json';
import helpDe from '../locales/de/help.json';
import adminEn from '../locales/en/admin.json';
import helpEn from '../locales/en/help.json';
import i18n from './i18n';

const bundles = {
  en: { admin: adminEn, help: helpEn },
  de: { admin: adminDe, help: helpDe },
};

for (const [lng, namespaces] of Object.entries(bundles)) {
  for (const [ns, resources] of Object.entries(namespaces)) i18n.addResourceBundle(lng, ns, resources, true, true);
}

export default i18n;
