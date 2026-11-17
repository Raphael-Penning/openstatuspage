/**
 * Renders one guide topic. Raw HTML in the markdown is not rendered
 * (react-markdown default); links are mapped with `resolveHelpLink`.
 */
import { ExternalLink } from 'lucide-react';
import { useMemo, type ComponentProps, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import Markdown, { type Components, type ExtraProps } from 'react-markdown';
import { Link } from 'react-router';
import remarkGfm from 'remark-gfm';
import { rehypeHeadingIds, resolveHelpLink } from './markdown';

type HeadingTag = 'h1' | 'h2' | 'h3' | 'h4';
type HeadingProps = ComponentProps<HeadingTag> & ExtraProps;

const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeHeadingIds];

export function HelpMarkdown({ markdown, lang }: { markdown: string; lang: string }) {
  const { t } = useTranslation('help');

  const components = useMemo<Components>(() => {
    const heading =
      (Tag: HeadingTag) =>
      ({ node: _node, id, children, ...rest }: HeadingProps) => (
        <Tag id={id} {...rest}>
          {children}
          {id && Tag !== 'h1' && (
            <Link to={{ hash: id }} className="help-anchor" aria-label={t('anchorLink')}>
              #
            </Link>
          )}
        </Tag>
      );

    return {
      h1: heading('h1'),
      h2: heading('h2'),
      h3: heading('h3'),
      h4: heading('h4'),
      a: ({ node: _node, href = '', children }) => <HelpLink href={href} lang={lang}>{children}</HelpLink>,
      table: ({ node: _node, ...props }) => (
        <div className="help-table">
          <table {...props} />
        </div>
      ),
    };
  }, [lang, t]);

  return (
    <div className="help-prose">
      <Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
        {markdown}
      </Markdown>
    </div>
  );
}

function HelpLink({ href, lang, children }: { href: string; lang: string; children: ReactNode }) {
  const { t } = useTranslation('help');
  const target = resolveHelpLink(href, lang);
  switch (target.kind) {
    case 'topic':
      return <Link to={target.to}>{children}</Link>;
    case 'anchor':
      return <Link to={{ hash: target.hash }}>{children}</Link>;
    case 'external':
      return (
        <a href={target.href} target="_blank" rel="noopener noreferrer">
          {children}
          <ExternalLink aria-hidden className="help-external-icon" />
        </a>
      );
    case 'repo':
      // Repository files are not served by the app; name the file instead of linking.
      return (
        <span className="help-repo-link" title={t('repoFile', { path: target.path })}>
          {children}
        </span>
      );
  }
}
