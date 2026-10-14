# Publishing Docker images

These instructions are for repository maintainers. Users can find image deployment and update instructions in [README.md](README.md#updating-and-stopping).

After merging verified changes into `master`, create and push a new Web release tag:

```sh
git switch master
git tag v2.32.0-web.1
git push origin v2.32.0-web.1
```

Replace the example with an unpublished version. `2.32.0` identifies the upstream baseline; `web.N` is the Web revision starting at 1. Release only accepts `vX.Y.Z-web.N` tags whose commit belongs to `master` history. Original upstream tags do not trigger it. The image version is separate from the upstream version displayed in the UI; desktop version files are unchanged.

Release runs frontend lint, type checking and tests, plus isolated Web Rust tests. It then builds the `linux/amd64` image, checks initialization, non-root execution, static content and `/health` using a temporary data volume, and pushes that same tested image to GHCR. No real VRChat credentials are used; the health check does not verify VRChat login or third-party integrations.

Images receive `2.32.0-web.N`, `sha-<full-commit>` and `latest` tags, with `latest` updated last. All versions share one publication concurrency group. Existing versions cannot be overwritten by the workflow, and authentication or network errors stop publication. Failed runs can be retried if the version has not been pushed. If the version was pushed but a later tag failed, publish a new `web.N`; the existing version remains unchanged. No GitHub Release page, desktop installer or logger attachment is created.

The workflow uses the built-in `GITHUB_TOKEN` with `packages: write`; no additional PAT or desktop signing keys are needed. **After the first publication, the maintainer must set the `vrcx-docker` package visibility to Public in GitHub Packages**, then verify `docker pull ghcr.io/e-larex/vrcx-docker:latest` without GHCR credentials. New GHCR packages default to private even when the source repository is public; see the [GitHub Container Registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#pushing-container-images). Published image references appear in the Actions run summary.
