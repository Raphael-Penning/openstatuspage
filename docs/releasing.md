# Releasing and container images

This page is for maintainers. It describes how the container image is built
and published and how to cut a release. Operators find the deployment steps in
the [installation guide](guide/en/02-installation.md).

## How the image pipeline works

The `image` job in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)
builds [`docker/Dockerfile`](../docker/Dockerfile) with Docker Buildx and
publishes it to the GitHub Container Registry (GHCR):

```
ghcr.io/raphael-penning/openstatuspage
```

The image name is derived from the repository (`ghcr.io/<owner>/<repo>`, in
lower case), so a fork publishes to its own namespace without changes.

| Event | Platforms | Pushed |
| --- | --- | --- |
| Pull request | `linux/amd64` | nothing, the build only has to succeed |
| Push to `main` | `linux/amd64`, `linux/arm64` | yes |
| Tag `vX.Y.Z` (or a pre-release such as `v1.2.0-rc.1`) | `linux/amd64`, `linux/arm64` | yes |

- The job depends on the `check` (typecheck, tests, build) and `postgres`
  (migrations and seed against PostgreSQL) jobs. Nothing is pushed unless both
  passed.
- Pushed images carry OCI labels and annotations (title, description,
  `AGPL-3.0-only` license, source repository, version, revision) and
  [build provenance and an SBOM](https://docs.docker.com/build/metadata/attestations/)
  as attestations.
- Layers are cached in the GitHub Actions cache. Pull requests read the cache
  of `main` but do not write to it.
- Only one image build runs per branch or tag. A newer push to `main` or to a
  pull request cancels the running build of the same ref; tag builds are never
  cancelled.
- The arm64 image is built with QEMU emulation and takes noticeably longer
  than the amd64 one.

## Tags

| Tag | Set by | Meaning |
| --- | --- | --- |
| `X.Y.Z` (e.g. `1.2.3`) | tag `vX.Y.Z` | Exactly this release. Recommended for production. |
| `X.Y` (e.g. `1.2`) | tag `vX.Y.Z` | Newest patch release of `X.Y`. |
| `X` (e.g. `1`) | tag `vX.Y.Z` with `X` ≥ 1 | Newest release of major version `X`. Not set for `0.x`. |
| `latest` | tag `vX.Y.Z` | Newest stable release. |
| `X.Y.Z-pre` (e.g. `1.2.0-rc.1`) | tag `vX.Y.Z-pre` | A pre-release. Moves none of the tags above. |
| `edge` | push to `main` | Current state of `main`. For testing, not for production. |
| `sha-<short sha>` (e.g. `sha-1a2b3c4`) | push to `main` | A specific commit of `main`. |

The moving tags (`X.Y`, `X`, `latest`) only move forward: the pipeline compares
the new tag with all existing stable `vX.Y.Z` tags of the repository. A
backport release such as `v1.4.9`, tagged after `v2.0.0`, gets `1.4.9` and
`1.4`, but leaves `1` alone if a newer 1.x release exists and never takes
`latest`.

## Cutting a release

1. Make sure `main` is green and contains everything for the release.
2. Update the `version` in the root `package.json` (and note the changes in the
   release notes), merge to `main`.
3. Create and push an annotated tag on that commit:

   ```bash
   git switch main && git pull
   git tag -a v1.2.3 -m "v1.2.3"
   git push origin v1.2.3
   ```

4. Wait for the CI run of the tag. The `image` job pushes `1.2.3`, `1.2`, `1`
   and `latest` (see [Tags](#tags)).
5. Create a GitHub release for the tag with the release notes, mention
   upgrade notes (configuration changes, migrations) prominently.

For a pre-release use a tag with a suffix, e.g. `v1.3.0-rc.1`. It is published
as `1.3.0-rc.1` only.

A `v*` tag that is not a valid semantic version (e.g. `v1.2`) produces no
image tag, so the `image` job fails. Delete such a tag (`git push origin :refs/tags/<tag>`)
and push a correct one. Never move or re-push an existing release tag; publish
a new patch release instead.

## First-time GHCR setup

No secrets are needed: the job logs in with the automatic `GITHUB_TOKEN` and
requests `packages: write` for itself, so **Settings > Actions > General >
Workflow permissions** can stay at "Read repository contents and packages
permissions".

After the first successful push:

1. Open the package (repository page > **Packages** > `openstatuspage`, or your
   profile/organization > **Packages**).
2. New packages may be **private**. Under **Package settings > Danger Zone >
   Change visibility** set it to **Public**, so the image can be pulled without
   logging in.
3. Check that the package is linked to the repository (the `source` label
   does that automatically) and that the repository has access under
   **Manage Actions access** with the role **Write**. A package created by the
   workflow of this repository already has it.

## Forks

A fork publishes to `ghcr.io/<fork owner>/<fork repo>` as soon as Actions are
enabled in the fork and something is pushed to its `main` or a `v*` tag; the
same visibility step applies. To deploy a fork's image, set `OSP_IMAGE` in the
Compose env file or adjust the `images:` entry in
[`deploy/kubernetes/kustomization.yaml`](../deploy/kubernetes/kustomization.yaml).

## Verifying an image

Check that both architectures were published:

```bash
docker buildx imagetools inspect ghcr.io/raphael-penning/openstatuspage:1.2.3
```

The output lists a manifest for `linux/amd64` and `linux/arm64` (plus
`unknown/unknown` entries, which hold the attestations). Provenance and SBOM
can be printed with:

```bash
docker buildx imagetools inspect ghcr.io/raphael-penning/openstatuspage:1.2.3 \
  --format '{{ json .Provenance }}'
docker buildx imagetools inspect ghcr.io/raphael-penning/openstatuspage:1.2.3 \
  --format '{{ json .SBOM }}'
```

A quick functional check of a published image (SQLite in a throwaway volume):

```bash
docker run --rm -p 127.0.0.1:3000:3000 \
  -e SECRET_KEY="$(openssl rand -base64 48)" \
  ghcr.io/raphael-penning/openstatuspage:1.2.3
curl http://127.0.0.1:3000/api/health
```

## Building locally

The image can always be built from a checkout, for example to test
unreleased changes or for a platform without a published image:

```bash
docker build -f docker/Dockerfile -t openstatuspage:local .
# or with Compose:
docker compose --env-file deploy.env -f docker/docker-compose.yml \
  -f docker/docker-compose.build.yml up -d --build
```

To reproduce the multi-arch build of the pipeline you need QEMU/binfmt (built
into Docker Desktop) and a builder that supports several platforms (Docker
Desktop with the containerd image store, or one created with
`docker buildx create --use`):

```bash
docker buildx build -f docker/Dockerfile --platform linux/amd64,linux/arm64 .
```
