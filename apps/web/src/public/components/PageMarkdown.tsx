/**
 * Markdown of the content pages (about, legal pages, custom pages), also the
 * preview in the management UI. Rendered safely:
 *
 * - no raw HTML (react-markdown drops it with `skipHtml`; there is no rehype-raw),
 * - link URLs pass react-markdown's defaultUrlTransform (http, https, mailto,
 *   relative; no javascript: or data:), outbound links open in a new tab with
 *   rel="noopener noreferrer",
 * - images only from the uploads of this instance or https URLs, with their
 *   stored width and height (no layout shift), lazily loaded,
 * - headings one level down: the page title is the only h1.
 */
import { isOutboundUrl, type ImageSize } from '@openstatuspage/shared';
import { ExternalLink } from 'lucide-react';
import { useMemo, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import Markdown, { type Components, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const remarkPlugins = [remarkGfm];

/** Image sources the pages show: uploads of this instance and https URLs. */
export function safeImageSrc(src: string | undefined): string | null {
  if (!src) return null;
  if (/^\/uploads\/[0-9a-f]{64}\.(?:png|jpg|webp|ico)$/.test(src)) return src;
  return /^https:\/\/[^\s/]+/i.test(src) ? src : null;
}

type Heading = 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
const heading = (Tag: Heading) =>
  function MarkdownHeading({ node: _node, ...props }: ComponentProps<Heading> & ExtraProps) {
    return <Tag {...props} />;
  };

export function PageMarkdown({ markdown, images = {}, baseUrl }: { markdown: string; images?: Record<string, ImageSize>; baseUrl?: string }) {
  const { t } = useTranslation('public');
  const components = useMemo<Components>(
    () => ({
      h1: heading('h2'),
      h2: heading('h3'),
      h3: heading('h4'),
      h4: heading('h5'),
      h5: heading('h6'),
      h6: heading('h6'),
      a: ({ node: _node, href = '', children }) => {
        if (!isOutboundUrl(href, baseUrl)) return <a href={href}>{children}</a>;
        return (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
            <ExternalLink aria-hidden className="ml-1 inline size-3.5 align-[-2px]" />
            <span className="sr-only"> {t('link.newTab')}</span>
          </a>
        );
      },
      img: ({ node: _node, src, alt, title }) => {
        const safe = safeImageSrc(typeof src === 'string' ? src : undefined);
        if (!safe) return null;
        const size = images[safe];
        return (
          <img
            src={safe}
            alt={alt ?? ''}
            title={title}
            loading="lazy"
            decoding="async"
            {...(size ? { width: size.width, height: size.height } : {})}
          />
        );
      },
      table: ({ node: _node, ...props }) => (
        <div className="page-table" tabIndex={0} role="region" aria-label={t('page.table')}>
          <table {...props} />
        </div>
      ),
    }),
    [images, baseUrl, t],
  );
  return (
    <div className="page-prose">
      <Markdown remarkPlugins={remarkPlugins} components={components} skipHtml>
        {markdown}
      </Markdown>
    </div>
  );
}
