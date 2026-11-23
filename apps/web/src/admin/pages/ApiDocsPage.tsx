/**
 * API documentation (/admin/api) for every signed-in user: renders the
 * OpenAPI document of GET /api/openapi.json (the whole API for a signed-in
 * user) with the operations grouped by tag, their parameters, request and
 * response schemas and examples, and a "try it" form for requests to this
 * instance with the current session (CSRF header included). Requests that
 * change data need an explicit confirmation.
 *
 * In-house and small on purpose: no third-party renderer, no CDN, nothing
 * evaluated; it lives in its own lazy chunk of the management UI.
 */
import { clsx } from 'clsx';
import { FileJson } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  canTry,
  constraints,
  credentialInputs,
  exampleBody,
  groupByTag,
  isMutating,
  matchesQuery,
  refName,
  pathValueProblem,
  requestUrl,
  resolve,
  typeLabel,
  type DocOperation,
  type OpenApiDocument,
  type OperationObject,
  type Parameter,
  type ResponseObject,
  type Schema,
} from '../api-docs/spec';
import { CheckboxField, TextAreaField, TextField } from '../components/fields';
import { Badge, Button, buttonClass, EmptyState, LoadingState, PageHeader } from '../components/ui';

export const OPENAPI_URL = '/api/openapi.json';
/** Longest response body shown in full. */
const MAX_SHOWN = 50_000;

const METHOD_TONE = { get: 'info', post: 'success', patch: 'warning', put: 'warning', delete: 'danger' } as const;

/** `Admin: catalog` → `tag-admin-catalog`. */
const tagId = (name: string) => `tag-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;

function useOpenApi() {
  const [state, setState] = useState<{ doc?: OpenApiDocument; error?: boolean }>({});
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    fetch(OPENAPI_URL, { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as OpenApiDocument;
      })
      .then(
        (doc) => active && setState({ doc }),
        () => active && setState({ error: true }),
      );
    return () => {
      active = false;
    };
  }, [attempt]);
  return { ...state, retry: () => (setState({}), setAttempt((n) => n + 1)) };
}

export default function ApiDocsPage() {
  const { t } = useTranslation('admin');
  const { doc, error, retry } = useOpenApi();
  const [query, setQuery] = useState('');
  const groups = useMemo(() => (doc ? groupByTag(doc) : []), [doc]);
  const filtered = useMemo(
    () => groups.map((g) => ({ ...g, operations: g.operations.filter((op) => matchesQuery(op, query)) })).filter((g) => g.operations.length > 0),
    [groups, query],
  );
  const count = filtered.reduce((n, g) => n + g.operations.length, 0);

  useEffect(() => {
    const previous = document.title;
    document.title = t('apiDocs.title');
    return () => {
      document.title = previous;
    };
  }, [t]);

  const header = (
    <PageHeader
      title={t('apiDocs.title')}
      description={t('apiDocs.description')}
      actions={
        <a href={OPENAPI_URL} className={buttonClass('secondary', 'sm')}>
          <FileJson aria-hidden className="size-4" />
          {t('apiDocs.download')}
        </a>
      }
    />
  );

  if (error) {
    return (
      <>
        {header}
        <div role="alert" className="flex flex-col items-center gap-3 p-10 text-center text-sm">
          <p className="text-status-major-outage-text">{t('apiDocs.loadError')}</p>
          <Button size="sm" onClick={retry}>
            {t('common:actions.retry')}
          </Button>
        </div>
      </>
    );
  }
  if (!doc) {
    return (
      <>
        {header}
        <LoadingState />
      </>
    );
  }

  return (
    <>
      {header}
      <div className="mb-6 flex flex-col gap-4">
        <InlineText text={doc.info.description ?? ''} className="flex flex-col gap-2 text-sm text-muted" />
        <p className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm">{t('apiDocs.tryItNote')}</p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <TextField
            className="sm:w-96"
            type="search"
            label={t('apiDocs.search')}
            help={t('apiDocs.searchHelp')}
            value={query}
            onValue={setQuery}
            autoComplete="off"
          />
          <p role="status" className="text-sm text-muted">
            {t('apiDocs.results', { count })}
          </p>
        </div>
        {!query && (
          <nav aria-label={t('apiDocs.contents')}>
            <ul className="flex flex-wrap gap-2 text-sm">
              {groups.map((g) => (
                <li key={g.name}>
                  <a href={`#${tagId(g.name)}`} className="inline-block rounded-lg border border-border px-2.5 py-1 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent">
                    {g.name}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </div>
      {filtered.length === 0 && <EmptyState>{t('apiDocs.noResults')}</EmptyState>}
      <div className="flex flex-col gap-8">
        {filtered.map((group) => (
          <section key={group.name} aria-labelledby={tagId(group.name)} className="flex flex-col gap-3">
            <div>
              <h2 id={tagId(group.name)} className="scroll-mt-4 text-lg font-semibold">
                {group.name}
              </h2>
              {group.description && <InlineText text={group.description} className="text-sm text-muted" />}
            </div>
            <ul className="flex flex-col gap-2">
              {group.operations.map((op) => (
                <li key={`${op.method} ${op.path}`}>
                  <OperationItem doc={doc} op={op} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}

function MethodBadge({ method }: { method: DocOperation['method'] }) {
  return (
    <Badge tone={METHOD_TONE[method]} className="w-16 justify-center font-mono uppercase">
      {method}
    </Badge>
  );
}

function OperationItem({ doc, op }: { doc: OpenApiDocument; op: DocOperation }) {
  const { t } = useTranslation('admin');
  const [open, setOpen] = useState(false);
  const role = op.operation['x-required-role'];
  return (
    <details
      id={op.operation.operationId}
      className="rounded-xl border border-border bg-surface"
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 rounded-xl px-4 py-3 focus-visible:outline-2 focus-visible:outline-accent">
        <MethodBadge method={op.method} />
        <code className="font-mono text-sm break-all">{op.path}</code>
        <span className="text-sm text-muted">{op.operation.summary}</span>
        {role === 'admin' && <Badge tone="danger">{t('apiDocs.adminOnly')}</Badge>}
      </summary>
      {open && <OperationDetails doc={doc} op={op} />}
    </details>
  );
}

function OperationDetails({ doc, op }: { doc: OpenApiDocument; op: DocOperation }) {
  const { t } = useTranslation('admin');
  const { operation } = op;
  const parameters = operation.parameters ?? [];
  const rateLimit = operation['x-rate-limit'];
  return (
    <div className="flex flex-col gap-5 border-t border-border px-4 py-4">
      {operation.description && <InlineText text={operation.description} className="flex flex-col gap-2 text-sm" />}
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
        <dt className="font-medium">{t('apiDocs.credentials')}</dt>
        <dd>
          <Credentials doc={doc} operation={operation} />
        </dd>
        {rateLimit && (
          <>
            <dt className="font-medium">{t('apiDocs.rateLimit')}</dt>
            <dd>{t('apiDocs.rateLimitValue', { max: rateLimit.max, per: rateLimit.per })}</dd>
          </>
        )}
      </dl>
      {parameters.length > 0 && <Parameters doc={doc} parameters={parameters} />}
      {operation.requestBody && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">{t('apiDocs.requestBody')}</h3>
          {operation.requestBody.description && <InlineText text={operation.requestBody.description} className="text-sm" />}
          {Object.entries(operation.requestBody.content).map(([type, media]) => (
            <div key={type} className="flex flex-col gap-2">
              <p className="text-xs text-muted">
                <code className="font-mono">{type}</code>
              </p>
              {media.schema && <SchemaView doc={doc} schema={media.schema} />}
              {media.example !== undefined && <CodeBlock label={t('apiDocs.example')}>{JSON.stringify(media.example, null, 2)}</CodeBlock>}
            </div>
          ))}
        </div>
      )}
      <Responses doc={doc} responses={operation.responses} />
      <TryIt doc={doc} op={op} />
    </div>
  );
}

function Credentials({ doc, operation }: { doc: OpenApiDocument; operation: OperationObject }) {
  const { t } = useTranslation('admin');
  const role = operation['x-required-role'];
  const alternatives = operation.security ?? [];
  if (alternatives.length === 0) return <>{t('apiDocs.credentialsNone')}</>;
  return (
    <>
      {alternatives.map((requirement, i) => (
        <Fragment key={i}>
          {i > 0 && ` ${t('apiDocs.or')} `}
          {Object.keys(requirement).map((name, j) => (
            <Fragment key={name}>
              {j > 0 && ' + '}
              <code className="font-mono text-xs" title={doc.components?.securitySchemes?.[name]?.description}>
                {schemeLabel(doc, name)}
              </code>
            </Fragment>
          ))}
        </Fragment>
      ))}
      {role && <span className="text-muted"> ({role === 'admin' ? t('apiDocs.adminOnly') : t('apiDocs.editor')})</span>}
    </>
  );
}

/** `osp_session` cookie, `X-Requested-With` header, `Bearer` token. */
function schemeLabel(doc: OpenApiDocument, name: string): string {
  const scheme = doc.components?.securitySchemes?.[name];
  if (!scheme) return name;
  if (scheme.type === 'http') return `Authorization: Bearer (${name})`;
  return `${scheme.in === 'cookie' ? 'Cookie ' : scheme.in === 'query' ? '?' : ''}${scheme.name}`;
}

function Parameters({ doc, parameters }: { doc: OpenApiDocument; parameters: Parameter[] }) {
  const { t } = useTranslation('admin');
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{t('apiDocs.parameters')}</h3>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-left text-sm">
          <thead className="bg-surface-2">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                {t('apiDocs.name')}
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                {t('apiDocs.in')}
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                {t('apiDocs.type')}
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                {t('apiDocs.descriptionColumn')}
              </th>
            </tr>
          </thead>
          <tbody>
            {parameters.map((p) => (
              <tr key={`${p.in} ${p.name}`} className="border-t border-border align-top">
                <td className="px-3 py-2">
                  <code className="font-mono">{p.name}</code>
                  {p.required && <span className="ml-1 text-xs text-status-major-outage-text">{t('apiDocs.required')}</span>}
                </td>
                <td className="px-3 py-2">{p.in}</td>
                <td className="px-3 py-2">
                  <code className="font-mono text-xs">{p.schema ? typeLabel(doc, p.schema) : 'string'}</code>
                </td>
                <td className="px-3 py-2">
                  {p.description && <InlineText text={p.description} />}
                  {p.schema && constraints(p.schema).length > 0 && <p className="text-xs text-muted">{constraints(p.schema).join(' · ')}</p>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Responses({ doc, responses }: { doc: OpenApiDocument; responses: Record<string, ResponseObject> }) {
  const { t } = useTranslation('admin');
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{t('apiDocs.responses')}</h3>
      <ul className="flex flex-col gap-2 text-sm">
        {Object.entries(responses).map(([status, raw]) => {
          const response = resolve(doc, raw);
          const success = status.startsWith('2') || status.startsWith('3');
          const content = Object.entries(response.content ?? {});
          return (
            <li key={status} className="flex flex-col gap-1">
              <p>
                <Badge tone={success ? 'success' : 'neutral'} className="mr-2 font-mono">
                  {status}
                </Badge>
                {response.description && <InlineText text={response.description} as="span" />}
              </p>
              {success &&
                content.map(([type, media]) => (
                  <div key={type} className="ml-2 flex flex-col gap-1 border-l border-border pl-3">
                    <p className="text-xs text-muted">
                      <code className="font-mono">{type}</code>
                    </p>
                    {media.schema && <SchemaView doc={doc} schema={media.schema} />}
                    {media.example !== undefined && <CodeBlock label={t('apiDocs.example')}>{JSON.stringify(media.example, null, 2)}</CodeBlock>}
                  </div>
                ))}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** A schema as a nested list of its properties (local references resolved, at most a few levels deep). */
function SchemaView({ doc, schema }: { doc: OpenApiDocument; schema: Schema }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-bg px-3 py-2 text-sm">
      <SchemaNode doc={doc} schema={schema} depth={0} seen={[]} />
    </div>
  );
}

function SchemaNode({ doc, schema, depth, seen }: { doc: OpenApiDocument; schema: Schema; depth: number; seen: string[] }): ReactNode {
  const { t } = useTranslation('admin');
  if (schema.$ref) {
    const name = refName(schema.$ref);
    if (seen.includes(name) || depth > 5) return <code className="font-mono text-xs">{name}</code>;
    return <SchemaNode doc={doc} schema={resolve(doc, schema)} depth={depth} seen={[...seen, name]} />;
  }
  if (schema.allOf) {
    // allOf here is a document plus the type of its data: show the parts after each other.
    return (
      <div className="flex flex-col gap-1">
        {schema.allOf.map((part, i) => (
          <SchemaNode key={i} doc={doc} schema={part} depth={depth} seen={seen} />
        ))}
      </div>
    );
  }
  const variants = schema.oneOf ?? schema.anyOf;
  if (variants && variants.some((v) => resolve(doc, v).properties)) {
    return (
      <div className="flex flex-col gap-1">
        <p className="text-xs text-muted">{t('apiDocs.oneOf')}</p>
        <ol className="flex list-decimal flex-col gap-2 pl-5">
          {variants.map((variant, i) => (
            <li key={i}>
              <SchemaNode doc={doc} schema={variant} depth={depth + 1} seen={seen} />
            </li>
          ))}
        </ol>
      </div>
    );
  }
  if (schema.properties) {
    const required = new Set(schema.required ?? []);
    return (
      <ul className={clsx('flex flex-col gap-1', depth > 0 && 'ml-3 border-l border-border pl-3')}>
        {Object.entries(schema.properties).map(([name, child]) => (
          <li key={name}>
            <PropertyLine doc={doc} name={name} schema={child} required={required.has(name)} />
            {hasChildren(doc, child) && depth < 6 && <SchemaNode doc={doc} schema={childSchema(child)} depth={depth + 1} seen={seen} />}
          </li>
        ))}
      </ul>
    );
  }
  return <PropertyLine doc={doc} schema={schema} />;
}

/** Array items or the object itself. */
const childSchema = (schema: Schema): Schema => (schema.type === 'array' && schema.items ? schema.items : schema);

function hasChildren(doc: OpenApiDocument, schema: Schema): boolean {
  const child = resolve(doc, childSchema(schema));
  return Boolean(child.properties || child.allOf || (child.oneOf ?? child.anyOf)?.some((v) => resolve(doc, v).properties));
}

function PropertyLine({ doc, name, schema, required }: { doc: OpenApiDocument; name?: string; schema: Schema; required?: boolean }) {
  const { t } = useTranslation('admin');
  const notes = constraints(schema);
  return (
    <p className="flex flex-wrap items-baseline gap-x-2">
      {name && <code className="font-mono font-medium">{name}</code>}
      <code className="font-mono text-xs text-muted">{typeLabel(doc, schema)}</code>
      {required && <span className="text-xs text-status-major-outage-text">{t('apiDocs.required')}</span>}
      {schema.description && <InlineText text={schema.description} as="span" className="text-xs" />}
      {notes.length > 0 && <span className="text-xs text-muted">{notes.join(' · ')}</span>}
    </p>
  );
}

function CodeBlock({ label, children }: { label: string; children: string }) {
  return (
    <figure className="flex flex-col gap-1">
      <figcaption className="text-xs font-medium text-muted">{label}</figcaption>
      <pre tabIndex={0} className="max-h-80 overflow-auto rounded-lg border border-border bg-bg p-3 font-mono text-xs">
        {children}
      </pre>
    </figure>
  );
}

interface TryResult {
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
}

function TryIt({ doc, op }: { doc: OpenApiDocument; op: DocOperation }) {
  const { t } = useTranslation('admin');
  const { operation, method, path } = op;

  const confirmRef = useRef<HTMLDivElement>(null);
  const parameters = (operation.parameters ?? []).filter((p) => p.in === 'path' || p.in === 'query');
  const credentials = credentialInputs(doc, operation);
  const bodyType = Object.keys(operation.requestBody?.content ?? {})[0];
  const [values, setValues] = useState<Record<string, string>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [body, setBody] = useState(() => exampleBody(doc, bodyType ? operation.requestBody?.content[bodyType] : undefined));
  const [confirmed, setConfirmed] = useState(false);
  const [confirmError, setConfirmError] = useState(false);
  const [pathErrors, setPathErrors] = useState<Record<string, 'empty' | 'dot'>>({});
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<TryResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const mutating = isMutating(method);

  if (!canTry(operation)) {
    return (
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">{t('apiDocs.tryIt')}</h3>
        <p className="text-sm text-muted">{t('apiDocs.tryItUnavailable')}</p>
      </div>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    // Path values are checked before anything is sent: an empty or dot value
    // would turn the URL into another route (`/x//updates`, `/x/..`).
    const problems: Record<string, 'empty' | 'dot'> = {};
    for (const p of parameters) {
      if (p.in !== 'path') continue;
      const key = `path:${p.name}`;
      const problem = pathValueProblem(values[key]);
      if (problem) problems[key] = problem;
    }
    setPathErrors(problems);
    const firstInvalid = Object.keys(problems)[0];
    if (firstInvalid) {
      const inputs = formRef.current?.querySelectorAll<HTMLInputElement>('input[data-param]') ?? [];
      Array.from(inputs)
        .find((input) => input.dataset.param === firstInvalid)
        ?.focus();
      return;
    }
    if (mutating && !confirmed) {
      setConfirmError(true);
      confirmRef.current?.querySelector('input')?.focus();
      return;
    }
    setPending(true);
    setFailure(null);
    setResult(null);
    try {
      const query: Record<string, string> = {};
      const pathValues: Record<string, string> = {};
      for (const p of parameters) (p.in === 'path' ? pathValues : query)[p.name] = values[`${p.in}:${p.name}`] ?? '';
      const headers: Record<string, string> = {
        accept: 'application/vnd.api+json, application/json;q=0.9, */*;q=0.8',
        // CSRF protection of cookie-authenticated mutations (the web client always sends it).
        'x-requested-with': 'openstatuspage',
      };
      for (const { scheme, definition } of credentials) {
        const value = secrets[scheme] ?? '';
        if (!value) continue;
        if (definition.type === 'http') headers.authorization = `Bearer ${value}`;
        else if (definition.in === 'header' && definition.name) headers[definition.name.toLowerCase()] = value;
        else if (definition.in === 'query' && definition.name) query[definition.name] = value;
      }
      const url = requestUrl(path, pathValues, query, window.location.origin);
      const sendBody = bodyType && body.trim() !== '' ? body : undefined;
      if (sendBody && bodyType) headers['content-type'] = bodyType;
      const res = await fetch(url, { method: method.toUpperCase(), credentials: 'same-origin', redirect: 'manual', headers, body: sendBody });
      const text = await res.text();
      let shown = text;
      try {
        shown = text ? JSON.stringify(JSON.parse(text), null, 2) : '';
      } catch {
        // Not JSON (feeds): shown as text.
      }
      setResult({
        status: res.status,
        contentType: res.headers.get('content-type') ?? '',
        body: shown.slice(0, MAX_SHOWN),
        truncated: shown.length > MAX_SHOWN,
      });
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <form ref={formRef} className="flex flex-col gap-3 rounded-lg border border-border p-3" onSubmit={submit} noValidate>
      <h3 className="text-sm font-semibold">
        {t('apiDocs.tryIt')}
      </h3>
      {mutating && (
        <p className="rounded-lg border border-status-degraded/40 bg-status-degraded/10 px-3 py-2 text-sm">
          {t('apiDocs.mutatingWarning', { method: method.toUpperCase() })}
        </p>
      )}
      {parameters.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {parameters.map((p) => {
            const key = `${p.in}:${p.name}`;
            const problem = pathErrors[key];
            return (
              <TextField
                key={key}
                data-param={key}
                label={`${p.name} (${p.in})`}
                required={p.required || p.in === 'path'}
                value={values[key] ?? ''}
                onValue={(v) => {
                  setValues((s) => ({ ...s, [key]: v }));
                  if (problem && !pathValueProblem(v)) {
                    setPathErrors((errors) => {
                      const next = { ...errors };
                      delete next[key];
                      return next;
                    });
                  }
                }}
                error={problem ? t(problem === 'empty' ? 'apiDocs.pathValueEmpty' : 'apiDocs.pathValueDot', { name: p.name }) : undefined}
                autoComplete="off"
                spellCheck={false}
              />
            );
          })}
        </div>
      )}
      {credentials.map(({ scheme, definition }) => (
        <TextField
          key={scheme}
          type="password"
          label={t('apiDocs.credential', { name: definition.type === 'http' ? 'Authorization: Bearer' : (definition.name ?? scheme) })}
          help={definition.description}
          value={secrets[scheme] ?? ''}
          onValue={(v) => setSecrets((s) => ({ ...s, [scheme]: v }))}
          autoComplete="off"
        />
      ))}
      {bodyType && (
        <TextAreaField
          label={t('apiDocs.body', { type: bodyType })}
          value={body}
          onValue={setBody}
          rows={Math.min(14, Math.max(4, body.split('\n').length))}
          className="font-mono"
          spellCheck={false}
        />
      )}
      {mutating && (
        <div ref={confirmRef} className="flex flex-col gap-1">
          <CheckboxField
            label={t('apiDocs.confirmMutating')}
            checked={confirmed}
            onChecked={(v) => {
              setConfirmed(v);
              if (v) setConfirmError(false);
            }}
          />
          {confirmError && (
            <p role="alert" className="text-xs text-status-major-outage-text">
              {t('apiDocs.confirmRequired')}
            </p>
          )}
        </div>
      )}
      <div>
        <Button type="submit" variant={mutating ? 'danger' : 'primary'} size="sm" pending={pending}>
          {t('apiDocs.send')}
        </Button>
      </div>
      <div aria-live="polite" className="flex flex-col gap-2">
        {failure && (
          <p role="alert" className="text-sm text-status-major-outage-text">
            {t('apiDocs.requestFailed', { message: failure })}
          </p>
        )}
        {result && (
          <>
            <p className="text-sm">
              <Badge tone={result.status < 400 ? 'success' : 'danger'} className="mr-2 font-mono">
                {result.status || t('apiDocs.redirect')}
              </Badge>
              <code className="font-mono text-xs text-muted">{result.contentType}</code>
            </p>
            <CodeBlock label={t('apiDocs.response')}>{result.body || t('apiDocs.emptyBody')}</CodeBlock>
            {result.truncated && <p className="text-xs text-muted">{t('apiDocs.truncated', { count: MAX_SHOWN })}</p>}
          </>
        )}
      </div>
    </form>
  );
}

/**
 * The little Markdown the descriptions use: paragraphs, `code` and **bold**.
 * Everything is text: nothing is parsed as HTML.
 */
function InlineText({ text, className, as = 'div' }: { text: string; className?: string; as?: 'div' | 'span' }) {
  const paragraphs = text.split(/\n{2,}/);
  const inline = (part: string) =>
    part.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((token, i) => {
      if (token.startsWith('`') && token.endsWith('`') && token.length > 1) {
        return (
          <code key={i} className="rounded bg-surface-2 px-1 font-mono text-[0.85em]">
            {token.slice(1, -1)}
          </code>
        );
      }
      if (token.startsWith('**') && token.endsWith('**') && token.length > 3) return <strong key={i}>{token.slice(2, -2)}</strong>;
      return <Fragment key={i}>{linkless(token)}</Fragment>;
    });
  if (as === 'span') return <span className={className}>{inline(paragraphs.join(' '))}</span>;
  return (
    <div className={className}>
      {paragraphs.map((p, i) => (
        <p key={i}>{inline(p)}</p>
      ))}
    </div>
  );
}

/** `[text](url)` → `text (url)`: links of the description stay readable without becoming links. */
const linkless = (text: string) => text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
