# Release Procedure

This extension is published to the Visual Studio Marketplace by GitHub Actions ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)). Pushing a version tag (`v*`) publishes it; nothing else does.

## How the pipeline works

| Event | `test` | `package` | `publish` |
| --- | --- | --- | --- |
| Pull request to `master` | ✅ | ✅ | — |
| Push to `master` | ✅ | ✅ | — |
| Push of a `v*` tag (e.g. `v0.0.5`) | ✅ | ✅ | ✅ |

- `test` runs lint, compile and the test suite on Linux, Windows and macOS.
- `package` builds the `.vsix` and uploads it as the `vsix` workflow artifact.
- `publish` runs `vsce publish`, which publishes the version in `package.json`. The tag itself is only the trigger, so **the tag and `package.json` version must match**.

## One-time setup

1. Create a Personal Access Token at <https://dev.azure.com> → User settings → Personal access tokens:
   - Organization: **All accessible organizations**
   - Scope: **Marketplace → Manage**
2. Add it to the GitHub repo as the secret `VSCE_PAT` (Settings → Secrets and variables → Actions).
3. Make sure the publisher `PatrickPhan` exists at <https://marketplace.visualstudio.com/manage>.

The PAT expires; when publishing fails with a 401, create a new one and update the secret.

## Naming

| Item | Format | Example |
| --- | --- | --- |
| Release branch | `release/X.Y.Z` | `release/0.0.5` |
| Tag | `vX.Y.Z` | `v0.0.5` |
| GitHub Release title | `vX.Y.Z` or `vX.Y.Z – <highlight>` | `v0.0.5 – Consumer group view` |

Pick the version with [semver](https://semver.org):

- `patch` for bug fixes (0.0.4 → 0.0.5)
- `minor` for new features (0.0.5 → 0.1.0)
- `major` for breaking changes (→ 1.0.0)

## Steps

### 1. Prepare the release branch

```sh
git checkout master && git pull
git checkout -b release/0.0.5
npm version 0.0.5 --no-git-tag-version   # updates package.json and package-lock.json
```

Add a section to [`CHANGELOG.md`](CHANGELOG.md):

```markdown
## [0.0.5] - YYYY-MM-DD

### Added
- …

### Fixed
- …
```

Check that it packages cleanly:

```sh
npx vsce package
```

### 2. Open and merge the PR

```sh
git commit -am "Release v0.0.5"
git push -u origin release/0.0.5
gh pr create --base master --title "Release v0.0.5" --fill
```

Wait for CI to pass, then merge.

### 3. Tag master (this publishes)

```sh
git checkout master && git pull
git tag -a v0.0.5 -m "v0.0.5"
git push origin v0.0.5
```

### 4. Verify

```sh
gh run watch
```

All three jobs should succeed. The new version appears on the Marketplace within a few minutes.

### 5. Create the GitHub Release (optional)

```sh
gh run download --name vsix          # the .vsix built by the tag run
gh release create v0.0.5 --title "v0.0.5" --generate-notes *.vsix
```

## Troubleshooting

| Problem | Cause / fix |
| --- | --- |
| `publish` job is skipped | The run wasn't triggered by a `v*` tag. Push the tag. |
| No workflow run after pushing the tag | The tag doesn't start with `v`, or `tags: ['v*']` is missing from `on.push` in `ci.yml`. |
| `... already exists` from `vsce` | `package.json` wasn't bumped. Bump it, merge, and tag a new version. Don't reuse the old tag. |
| `401` / `Access Denied` | `VSCE_PAT` is missing, expired, or lacks the Marketplace → Manage scope. |
| Wrong commit was tagged | Before the publish succeeds: `git push --delete origin vX.Y.Z && git tag -d vX.Y.Z`, then re-tag. After it has published, release a new patch version instead. |
