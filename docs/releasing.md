# Releasing and container images

This page is for maintainers. It describes how the container image and the
release assets are built and published and how to cut a release. Operators find the deployment steps in
the [installation guide](guide/en/02-installation.md).

## How the image pipeline works

The `image` job in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)
builds [`docker/Dockerfile`](../docker/Dockerfile) with Docker Buildx and
publishes it to the GitHub Container Registry (GHCR). Pull requests run the
separate `image-build` job instead, which only builds the image:

```
ghcr.io/raphael-penning/openstatuspage
```

The image name is derived from the repository (`ghcr.io/<owner>/<repo>`, in
lower case), so a fork publishes to its own namespace without changes.

| Event | Platforms | Pushed |
| --- | --- | --- |
| Pull request (`image-build`) | `linux/amd64` | nothing, the build only has to succeed |
| Push to `main` (`image`) | `linux/amd64`, `linux/arm64` | yes |
| Tag `vX.Y.Z` (or a pre-release such as `v1.2.0-rc.1`) (`image`) | `linux/amd64`, `linux/arm64` | yes |

- Only the `image` job, which never runs for pull requests, gets
  `packages: write`. `image-build` has read access only.
- Both jobs depend on the `check` (typecheck, tests, build) and `postgres`
  (migrations and seed against PostgreSQL) jobs. Nothing is pushed unless both
  passed.
- Pushed images carry OCI labels and annotations (title, description,
  `AGPL-3.0-only` license, source repository, version, revision) and
  [build provenance and an SBOM](https://docs.docker.com/build/metadata/attestations/)
  as attestations.
- Layers are cached in the GitHub Actions cache. Pull requests read the cache
  of `main` but do not write to it.
- Only one image build runs per branch, tag or pull request. A newer push to a
  pull request cancels its running build; builds of `main` and of tags are
  never cancelled, so every commit of `main` gets its `sha-` tag.
- Every action in the workflow is pinned to a full commit SHA, with the
  release it belongs to as a comment (`# vX.Y.Z`). To upgrade an action,
  resolve the new release tag to its commit
  (`git ls-remote https://github.com/<owner>/<repo> refs/tags/<tag>`, using the
  `^{}` entry for annotated tags) and update SHA and comment together.
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

## Release assets (Compose deployment)

Operators deploy with two files that are attached to every GitHub release:

| Asset | Source in the repository | Content |
| --- | --- | --- |
| `compose.yaml` | [`deploy/compose/compose.yaml`](../deploy/compose/compose.yaml) | App and PostgreSQL, no reverse proxy. The image default `${OSP_VERSION:-latest}` is rewritten to `${OSP_VERSION:-X.Y.Z}`. |
| `env.example` | [`deploy/compose/.env.example`](../deploy/compose/.env.example) | Settings template, saved as `.env` by the operator. `OSP_VERSION=latest` is rewritten to `OSP_VERSION=X.Y.Z`. |

The asset is called `env.example` because file names starting with a dot are
awkward to download and to see in the release UI. The installation guide fetches
both from `https://github.com/Raphael-Penning/openstatuspage/releases/latest/download/<asset>`,
so that URL always has to serve the newest **stable** release, pinned to its own
version.

The `release` job in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)
takes care of that. It runs for every pushed `v*` tag after the `image` job
succeeded (so the assets never point to an image that does not exist):

1. Renders both assets into a temporary directory with `sed`, using the tag
   without the leading `v` as version, and fails if a substitution no longer
   matches (e.g. after the templates were reworded).
2. Creates the GitHub release for the tag if it does not exist yet
   (`gh release create --verify-tag --generate-notes --title vX.Y.Z`), or
   updates an existing one (`gh release edit`). Tags with a `-` (pre-releases)
   are marked as pre-release. The release is marked **latest** only when the
   `image` job moved the `latest` image tag (see [Tags](#tags)); a pre-release
   or a backport such as `v1.4.9` after `v2.0.0` gets `--latest=false`, so
   `releases/latest` keeps pointing to the highest stable release.
3. Uploads `compose.yaml` and `env.example` with `--clobber`, replacing assets
   of an earlier run.

The job only needs `contents: write` and the automatic `GITHUB_TOKEN`. In
`deploy/compose/` the files keep `latest` as default, so a git checkout
follows the newest release. `compose.build.yaml` next to them is not published;
it builds the image from the checkout (see [Building locally](#building-locally)).

### Re-running the asset upload

The upload is idempotent. To publish the assets again for an existing tag (for
example after the release was created by hand, or after a failed run), re-run
the `release` job of the tag's CI run in the Actions tab ("Re-run jobs" >
`release`). Manually, from a checkout of the tag:

```bash
tag=v1.2.3; version="${tag#v}"; out="$(mktemp -d)"
sed "s/\${OSP_VERSION:-latest}/\${OSP_VERSION:-$version}/" deploy/compose/compose.yaml > "$out/compose.yaml"
sed "s/^OSP_VERSION=latest\$/OSP_VERSION=$version/" deploy/compose/.env.example > "$out/env.example"
gh release upload "$tag" "$out/compose.yaml" "$out/env.example" --clobber
```

Fixes to the templates reach operators only with the next release; never
re-upload changed files to an old release.

### Former `docker/docker-compose.yml`

Up to v0.1.0 the repository shipped `docker/docker-compose.yml` and the
`docker/docker-compose.build.yml` override, used with `--env-file deploy.env -f
docker/docker-compose.yml`. Both were replaced by `deploy/compose/compose.yaml`
and `deploy/compose/compose.build.yaml`. Settings now live in a `.env` next to
the compose file. The old project took its name from the directory (`docker`),
so its volumes are `docker_data` and `docker_pg`, while the new file uses the
fixed project name `openstatuspage`. Existing installations keep their data by
running the new file as `docker compose -p docker up -d` (and `-p docker` for
every further command), or migrate the database with `pg_dump`/restore, see
[Operations](guide/en/09-operations.md). Mention this in the release notes of
the first release with the new file.

## Helm chart

The chart in [`deploy/helm/openstatuspage`](../deploy/helm/openstatuspage) is
checked and published by two jobs of
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml):

- `helm` runs [`scripts/helm-test.sh`](../scripts/helm-test.sh) on every push
  and pull request: `helm lint --strict` and `helm template` for the value
  files in `deploy/helm/openstatuspage/ci/` (SQLite, external PostgreSQL, split
  mode, split mode with NetworkPolicy and HPA), checks of the rendered output
  and of the invalid combinations the chart must reject, and `helm package`.
  It then validates every render with
  [kubeconform](https://github.com/yannh/kubeconform) (`-strict`, against the
  minimum Kubernetes version of `kubeVersion` in `Chart.yaml`). The job
  downloads a pinned kubeconform release and checks it against two SHA-256
  values hard-coded in the workflow (`KUBECONFORM_SHA256` for the tarball,
  `KUBECONFORM_CHECKSUMS_SHA256` for the release's `CHECKSUMS` file); to
  upgrade kubeconform, update the version and both hashes from the new
  release. Run the script locally before changing the chart; it needs only
  `helm`, and uses `kubeconform` too when it is on the `PATH`.
- `helm-publish` runs for pushed `v*` tags only, after `image` (so the chart
  never points to an image that does not exist) and `helm` succeeded. It
  packages the chart with `version` and `appVersion` set to the tag without the
  leading `v` (`v1.2.3` gives `1.2.3`, `v1.3.0-rc.1` gives `1.3.0-rc.1`) and
  pushes it with the automatic `GITHUB_TOKEN` to
  `oci://ghcr.io/<owner>/charts/openstatuspage`. The default image repository in
  the packaged `values.yaml` is set to the image of the same repository.

The `version` in `Chart.yaml` is only used for local packaging; a release does
not need a change there. The chart package is a separate GHCR package
(`charts/openstatuspage`): set it to **Public** after the first release, as
described in [First-time GHCR setup](#first-time-ghcr-setup).

Check a published chart with:

```bash
helm show chart oci://ghcr.io/raphael-penning/charts/openstatuspage --version 1.2.3
```

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
   and `latest` (see [Tags](#tags)); the `release` job then creates the GitHub
   release with generated notes and attaches `compose.yaml` and `env.example`
   (see [Release assets](#release-assets-compose-deployment)), and the
   `helm-publish` job pushes the Helm chart `1.2.3` (see [Helm chart](#helm-chart)).
5. Edit the release notes on GitHub and put upgrade notes (configuration
   changes, migrations) at the top. Check that the assets are attached and
   that `releases/latest/download/compose.yaml` shows the new version.

For a pre-release use a tag with a suffix, e.g. `v1.3.0-rc.1`. The image is
published as `1.3.0-rc.1` only, and the GitHub release is marked as pre-release
(its assets pin `1.3.0-rc.1`, `releases/latest` is not affected).

A `v*` tag that is not a valid semantic version (e.g. `v1.2`) produces no
image tag, so the `image` job fails and no release is created. Delete such a tag (`git push origin :refs/tags/<tag>`)
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
same visibility step applies. A fork's tags also get GitHub releases with the
Compose assets, but those assets still name this repository's image as default.
To deploy a fork's image, set `OSP_IMAGE` in the
Compose `.env` or adjust the `images:` entry in
[`deploy/kubernetes/kustomization.yaml`](../deploy/kubernetes/kustomization.yaml).
The fork's Helm chart is published to
`ghcr.io/<fork owner>/charts/openstatuspage` and already defaults to the fork's
image.

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
# or the Compose stack, from deploy/compose with a .env (see CONTRIBUTING.md):
cd deploy/compose
docker compose -f compose.yaml -f compose.build.yaml up -d --build
```

To reproduce the multi-arch build of the pipeline you need QEMU/binfmt (built
into Docker Desktop) and a builder that supports several platforms (Docker
Desktop with the containerd image store, or one created with
`docker buildx create --use`):

```bash
docker buildx build -f docker/Dockerfile --platform linux/amd64,linux/arm64 .
```
