# Publishing Docker images

These instructions are for repository maintainers. Users can find image deployment and update instructions in [README.md](README.md#updating-and-stopping).

After merging verified changes into `master`, create and push a new Web release tag:

```sh
git switch master
git tag v2.32.0-web.1
git push origin v2.32.0-web.1
```

Replace the example with an unpublished version. `2.32.0` identifies the upstream baseline; `web.N` is the Web revision starting at 1. Release accepts `vX.Y.Z-web.N` and `vX.Y.Z-web.N-beta.M` tags whose commit belongs to `master` history. Both `N` and `M` must be positive integers without leading zeros. Original upstream tags do not trigger it. The image version is separate from the upstream version displayed in the UI; desktop version files are unchanged.

For the first beta of a Web revision, use `v2.32.0-web.1-beta.1` in both commands above. Further test releases increment `beta.M`; the stable release drops the beta suffix. Tag the commit containing the release workflow changes, not an earlier commit.

Release runs frontend lint, type checking and tests, isolated Web Rust tests, a separate desktop runtime check with default features, and the browser checks described in [DEVELOPMENT.md](DEVELOPMENT.md#continuous-integration). It then builds the `linux/amd64` image, checks initialization, non-root execution, static content and `/health`, and runs LAN authentication and persistence checks across container recreation using temporary data volumes. Only that tested image is pushed to GHCR. No real VRChat credentials are used; the health check does not verify VRChat login or third-party integrations.

Images receive the Git tag without its leading `v`, `sha-<full-commit>` and a channel tag:

| Release | Version tag           | Channel tag |
| ------- | --------------------- | ----------- |
| Stable  | `2.32.0-web.1`        | `latest`    |
| Beta    | `2.32.0-web.1-beta.1` | `beta`      |

The channel tag is updated last. Beta releases never update `latest`; after a beta-only first publication, `latest` does not exist yet. All versions share one publication concurrency group. Existing versions cannot be overwritten by the workflow, and authentication or network errors stop publication. Failed runs can be retried if the version has not been pushed. If the version was pushed but a later tag failed, publish a new `web.N` for stable releases or increment `beta.M` for beta releases; the existing version remains unchanged. No GitHub Release page, desktop installer or logger attachment is created.

The workflow uses the built-in `GITHUB_TOKEN` with `packages: write`; no additional PAT or desktop signing keys are needed. **After the first publication, the maintainer must set the `vrcx-docker` package visibility to Public in GitHub Packages**, then verify an anonymous pull of the published version, for example `docker pull ghcr.io/e-larex/vrcx-docker:2.32.0-web.1-beta.1` for the first beta. New GHCR packages default to private even when the source repository is public; see the [GitHub Container Registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#pushing-container-images). Published image references appear in the Actions run summary.
