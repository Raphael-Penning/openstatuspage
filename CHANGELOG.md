# Changelog

All notable changes to this project are documented here. The project follows
[Semantic Versioning](https://semver.org/); before 1.0 a minor release may contain
breaking changes.

## [Unreleased] (0.2.0)

### Breaking changes

- **The HTTP API speaks [JSON:API 1.1](https://jsonapi.org/format/1.1/)**
  (`application/vnd.api+json`). There is no compatibility layer for the former
  plain JSON bodies. See [docs/api.md](docs/api.md) for the conventions.
  - Responses are documents with `data` (resource objects with `type`, `id`,
    `attributes`, `relationships`), `included`, `meta` and `links`.
  - Request bodies must be sent as `{ "data": { "type", "attributes", "relationships" } }`
    with `Content-Type: application/vnd.api+json` (ingest and webhook endpoints keep
    their native payloads).
  - Errors are `{ "errors": [{ "status", "code", "title", "detail", "source" }] }`.
  - Lists use `page[number]`, `page[size]` and `filter[name]` instead of `page`,
    `pageSize` and plain filter parameters.
  - Public API: `/api/public/history` filters are `filter[type]`, `filter[service]`,
    `filter[location]` and `filter[month]`; history entries are `incidents` and
    `maintenances` resources instead of `{ type, date, incident | maintenance }`.
  - Unchanged: `/api/public/status.json`, `/api/health` and the RSS/Atom feeds.
