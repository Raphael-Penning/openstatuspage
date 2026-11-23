/**
 * Shape check of the JSON-LD of the public pages (tests only, seo.test.tsx):
 * every object and nested object uses a known schema.org type, only properties
 * schema.org defines for that type (https://schema.org/<Type>), and the
 * properties Google requires or recommends for its rich results
 * (developers.google.com/search/docs/appearance/structured-data). Values are
 * checked where their form is fixed: ISO 8601 dates, absolute https URLs,
 * schema.org enumeration members, consecutive list positions.
 */

type Obj = Record<string, unknown>;

/** Properties schema.org defines for each type we emit (a subset: the ones we may use). */
const THING = ['@context', '@type', '@id', 'name', 'description', 'url', 'image', 'sameAs'];
const CREATIVE_WORK = [...THING, 'inLanguage', 'datePublished', 'dateModified', 'author', 'publisher', 'about', 'isPartOf', 'mainEntityOfPage', 'headline'];
const WEB_PAGE = [...CREATIVE_WORK, 'breadcrumb', 'significantLink', 'lastReviewed'];

const ALLOWED: Record<string, string[]> = {
  WebSite: [...CREATIVE_WORK],
  Organization: [...THING, 'logo'],
  BreadcrumbList: ['@context', '@type', 'itemListElement'],
  ListItem: ['@type', 'position', 'name', 'item'],
  Article: [...CREATIVE_WORK],
  ImageObject: ['@type', 'url'],
  Event: [...THING, 'startDate', 'endDate', 'eventStatus', 'eventAttendanceMode', 'location', 'organizer', 'inLanguage'],
  VirtualLocation: ['@type', 'url', 'name'],
  Service: [...THING, 'provider', 'serviceType', 'areaServed'],
  WebPage: WEB_PAGE,
  AboutPage: WEB_PAGE,
  ContactPage: WEB_PAGE,
};

/** Required (schema.org sense or Google's rich result requirements) per type, at the top level. */
const REQUIRED: Record<string, string[]> = {
  WebSite: ['name', 'url'],
  Organization: ['name', 'url'],
  BreadcrumbList: ['itemListElement'],
  Article: ['headline', 'datePublished', 'author', 'publisher'],
  Event: ['name', 'startDate', 'location', 'eventStatus', 'eventAttendanceMode'],
  Service: ['name', 'provider', 'url'],
  WebPage: ['name', 'url'],
  AboutPage: ['name', 'url'],
  ContactPage: ['name', 'url'],
};

const EVENT_STATUS = ['EventScheduled', 'EventCancelled', 'EventPostponed', 'EventRescheduled', 'EventMovedOnline'].map((s) => `https://schema.org/${s}`);
const ATTENDANCE = ['OfflineEventAttendanceMode', 'OnlineEventAttendanceMode', 'MixedEventAttendanceMode'].map((s) => `https://schema.org/${s}`);
const DATE_PROPS = ['datePublished', 'dateModified', 'startDate', 'endDate'];
const URL_PROPS = ['url', 'item', 'logo', 'image', 'mainEntityOfPage', '@id'];

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isIsoDate = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(v);
const isAbsoluteUrl = (v: unknown) => typeof v === 'string' && /^https:\/\/[^\s]+$/.test(v);

/** Problems of one JSON-LD object (empty: it passes). */
export function validateJsonLd(root: unknown): string[] {
  const problems: string[] = [];
  if (!isObj(root)) return ['not an object'];
  if (root['@context'] !== 'https://schema.org') problems.push('@context must be https://schema.org');

  const visit = (node: Obj, path: string, top: boolean) => {
    // A reference to a node defined elsewhere: `{ "@id": "<absolute URL>" }`.
    if (!top && Object.keys(node).length === 1 && '@id' in node) {
      if (!isAbsoluteUrl(node['@id'])) problems.push(`${path}.@id: not an absolute https URL`);
      return;
    }
    const type = node['@type'];
    if (typeof type !== 'string' || !(type in ALLOWED)) {
      problems.push(`${path}: unknown @type ${String(type)}`);
      return;
    }
    for (const key of Object.keys(node)) {
      if (!ALLOWED[type]!.includes(key)) problems.push(`${path}: ${type} has no property ${key}`);
    }
    if (top) {
      for (const key of REQUIRED[type] ?? []) {
        if (node[key] === undefined || node[key] === '') problems.push(`${path}: ${type} needs ${key}`);
      }
    }
    for (const key of DATE_PROPS) {
      if (node[key] !== undefined && !isIsoDate(node[key])) problems.push(`${path}.${key}: not an ISO 8601 date-time`);
    }
    for (const key of URL_PROPS) {
      const value = node[key];
      if (value !== undefined && !isObj(value) && !isAbsoluteUrl(value)) problems.push(`${path}.${key}: not an absolute https URL`);
    }
    if (type === 'Event') {
      if (!EVENT_STATUS.includes(String(node.eventStatus))) problems.push(`${path}.eventStatus: not an EventStatusType`);
      if (!ATTENDANCE.includes(String(node.eventAttendanceMode))) problems.push(`${path}.eventAttendanceMode: not an EventAttendanceModeEnumeration`);
      if (typeof node.startDate === 'string' && typeof node.endDate === 'string' && node.endDate < node.startDate) {
        problems.push(`${path}: endDate before startDate`);
      }
    }
    if (type === 'BreadcrumbList') {
      const items = node.itemListElement;
      if (!Array.isArray(items) || items.length === 0) problems.push(`${path}.itemListElement: empty`);
      else {
        items.forEach((item, i) => {
          if (!isObj(item) || item.position !== i + 1 || typeof item.name !== 'string' || !item.name) {
            problems.push(`${path}.itemListElement[${i}]: needs position ${i + 1} and a name`);
          }
        });
      }
    }
    if (type === 'Article' && typeof node.headline === 'string' && node.headline.length > 110) problems.push(`${path}.headline: longer than 110`);
    for (const [key, value] of Object.entries(node)) {
      const children = Array.isArray(value) ? value : [value];
      children.forEach((child, i) => {
        if (isObj(child)) visit(child, `${path}.${key}${Array.isArray(value) ? `[${i}]` : ''}`, false);
      });
    }
  };
  visit(root, '$', true);
  return problems;
}
