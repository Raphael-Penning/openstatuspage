# Search engines, AI agents and the public page

The public status page is meant to be found, read and used by everybody: search
engines, link previews, AI assistants and visitors whose browser runs no
scripts. This chapter explains what the page tells these visitors and what you
need to set for it to work.

## What you need to set

Only one setting matters for search engines: **`PUBLIC_BASE_URL`** (default
`BASE_URL`). Its value appears in every canonical link, `hreflang` alternate,
sitemap entry, the `Sitemap:` line of `robots.txt`, the links in `llms.txt` and
in the structured data. Set it to the address your visitors type, with
`https://` and without a trailing slash, for example `https://status.example.com`.

- A wrong value makes search engines index another host or treat the pages as
  duplicates. Check it once after installation by opening `/robots.txt` and
  `/sitemap.xml` in the browser.
- In a [split deployment](02-installation.md#split-deployment) set it on the
  admin and worker instances as well, to the public domain. The admin domain is
  not the status page and tells search engines so (see below).

See [Configuration](../../configuration.md#server) for the variable itself.

## What the page tells search engines

Every public page describes itself:

- **Title and description.** Each page has its own title in the form
  "Page · Site". The description is taken from the page content (a service's
  description, the latest incident update, a maintenance description), at most
  160 characters.
- **Canonical link and languages.** Each page names its canonical address, in
  lower case and without a trailing slash; other spellings such as `/Services/`
  are redirected to it (`301`). The language versions (`?lang=de`, `?lang=en`)
  are pages of their own and list each other as alternates; the plain address is
  the `x-default` version. `?lang=` always shows that language, whatever the
  visitor chose before.
- **Structured data (JSON-LD).** The overview describes the site and its
  organization. Other pages have breadcrumbs. Incident and maintenance pages are
  described as articles with their start and last update.
- **Link previews.** Open Graph and Twitter card tags carry the site name, the
  title, the description and the logo (when you set one), so a shared link shows
  the right preview.

Pages that do not exist (`404`) and the personal subscription links (confirm,
manage and unsubscribe) carry `noindex`. Subscription links are personal and
have no canonical address, so they are never listed in a sitemap. Filtered,
searched and later pages (for example `/history?type=incident` or
`/history?page=2`) carry `noindex, follow`: search engines follow their links to
the incidents but list only the plain page.

## robots.txt

`/robots.txt` is generated; you do not edit it. On the public status page it
reads like this (with your own host name):

```text
# Public status page. A summary for language models: https://status.example.com/llms.txt
User-agent: *
Allow: /
Allow: /api/public/
Disallow: /api/public/subscriptions
Disallow: /api/
Disallow: /admin
Disallow: /subscription/
Disallow: /preferences/

Sitemap: https://status.example.com/sitemap.xml
```

- The management UI, the personal subscription links and the API are not
  crawled, except the read-only public API that `llms.txt` points agents to.
  The public pages, feeds and the files for AI agents are crawled.
- An instance with `APP_ROLE=admin` (the management side of a split deployment)
  answers with `Disallow: /` and marks every page `noindex`, so search engines
  leave it alone. That is the
  right behavior: the admin domain is not the status page.
- `Disallow` stops crawling, not necessarily indexing. The `noindex` header and
  meta tag are what keep a page out of search results, which is why the pages
  that must stay out carry both.

If you need rules for particular crawlers (for example to block AI training
bots), serve your own `robots.txt` at the reverse proxy instead; the app's file is
then not reached. Keep the `Sitemap:` line.

## Sitemaps

`/sitemap.xml` is a sitemap index. It lists these sitemaps, each with its own
`lastmod` and the public pages only:

| Sitemap | Content |
| --- | --- |
| `/sitemap-pages.xml` | The overview, services, history and locations pages, and subscribe when email subscriptions are offered. |
| `/sitemap-incidents-1.xml`, ... | Public incidents, then public maintenance windows. More numbered files appear when there are more than 5,000 URLs. |
| `/sitemap-services-1.xml`, ... | One entry per public service page. Hidden services are never listed. |

Each file holds at most 5,000 URLs, so a long history is split into several
numbered files that the index lists for you. A service or an incident appears
with the time of its last change, so search engines re-crawl what changed. Your
sitemaps update on their own: you never maintain them.

## Submitting the sitemap to Google Search Console

Google does not need a submission, but submitting the sitemap shows you what it
found and speeds up discovery. You need a Google account.

1. In [Search Console](https://search.google.com/search-console) add a property
   for your status page. Prefer a **domain property** (`example.com`); verify it
   with a DNS `TXT` record that your DNS provider's panel lets you create. A
   URL-prefix property asks for an HTML tag or file on the site, and the status
   page has no setting for a verification tag. If you can only use a URL prefix,
   add the tag through your reverse proxy.
2. Open **Sitemaps** in the property, enter `sitemap.xml` (the full address is
   `https://status.example.com/sitemap.xml`) and submit it.
3. Wait a few minutes and reload. The status should say that the sitemap was read
   successfully and show the number of discovered pages. Google reads the sub-sitemaps
   of the index by itself; you do not submit them one by one.
4. Optional: with **URL inspection** check the overview page. It should show the
   canonical address you expect and that it is indexable.

Indexing can take days. Search Console reports errors such as "Couldn't fetch"
when the address does not answer with the sitemap: check that the proxy passes
`/sitemap.xml` through and that `PUBLIC_BASE_URL` is correct. Bing Webmaster Tools
accepts the same address.

## noindex rules

| Page | Indexed | Note |
| --- | --- | --- |
| Overview, services, service, history, incident, maintenance, locations | yes | Listed in the sitemaps. |
| Subscribe | yes, when email subscriptions are offered | Listed in the pages sitemap. |
| Filtered, searched or later pages, "sent" and error states of the subscribe page | no | `noindex, follow`, no canonical address. |
| Not found (404), also a history page beyond the last one | no | `noindex`. |
| Confirm, manage, unsubscribe links | no | `noindex`, not in a sitemap, disallowed in `robots.txt`. |
| `/admin` on an instance that serves it | no | The response carries `X-Robots-Tag: noindex, nofollow`. |
| Every page of an `admin` instance | no | `Disallow: /` in `robots.txt` and `X-Robots-Tag: noindex, nofollow`. |

You do not need to set any of this. Hidden services and internal checks are
never published, so they cannot appear in a search result.

## llms.txt and AI agents

Language models and agents find the page through these files, all generated:

- **`/llms.txt`** is a short summary in the [llms.txt](https://llmstxt.org)
  format: your site name and description, the public pages with a short
  explanation each, the JSON:API status endpoint and the feeds. It changes when
  your settings or services change.
- **`/llms-full.txt`** is the current status as Markdown: the overall status,
  active incidents, scheduled maintenance and every public service. It is
  refreshed about every minute.
- **`/api/public/status`** is the same status as a JSON:API document for
  programs, and **`/feed.rss`** and **`/feed.atom`** carry incidents and
  maintenance.

The text of these files comes from your settings and your public incidents, and
it is escaped so that an incident title cannot inject headings or links into
them.

## Using the status page without JavaScript

The public pages work in a browser without JavaScript, for example with
script blocking, on old devices or in text-only tools. Scripts only make the page
more comfortable. Without them:

- **Everything is shown.** The overview, the services with their uptime, the
  incident and maintenance pages and the history are rendered on the server.
- **Filters are forms and links.** The history filters (type, service, location,
  month) are a form with an **Apply** button, and its pages are links. The
  service search and the status filter are a form and links as well.
- **Language and theme are links and forms.** The language menu links to the
  page in each language (on the personal subscription pages it is a form, so
  their link never ends up in a log); the theme choice is a form. `system` follows the
  dark-mode setting of the device.
- **Disclosures open with a click.** The subscribe menu, the language menu and
  the service groups open and close on their own, without scripts.
- **Maps and bars have text equivalents.** The world map is drawn by the server
  as a picture of the countries with its markers. The day-by-day uptime bars have
  a table with the same days on the service page.
- **Times are in UTC.** The server shows times in UTC. A browser with JavaScript
  switches them to the visitor's own time zone and local format after loading.
- **Subscriptions work with forms.** Subscribing, confirming and managing
  a subscription are plain forms, with error messages at the top of the page when
  something is wrong.

What needs JavaScript: the live update of the status every 60 seconds, the
interactive map, the time zone switch and the closing of menus by a click outside
or the Escape key.

## Troubleshooting

- **The old title or description is still shown in search results.** Search
  engines update their copy after a crawl. Check the page's title in the browser
  first; if it is right, request indexing in Search Console.
- **A page shows a different address than the one in the browser.** `PUBLIC_BASE_URL`
  is not what visitors use. Correct it and restart the app.
- **Search Console reports a sitemap that cannot be read.** Open
  `https://status.example.com/sitemap.xml` in a browser. If it does not show an
  XML index, the proxy does not pass the path through.
- **`/robots.txt` or a sitemap is cached for a long time.** Crawlers and proxies
  cache them for an hour (robots), 15 minutes (sitemaps) and a few minutes
  (`llms.txt`). Wait, or purge the cache of your proxy.
