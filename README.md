# dsh-file-manager

Adds the write direction to DeepSeek Harness Web's **Files** feature: **upload, download, zip a folder, rename, delete and create folders** — no SFTP client needed for day-to-day work in a session workspace.

The shipped files panel only lists and previews. This plugin adds an authenticated, workspace-confined transfer channel plus a full manager tab.

## What it adds

| Where | What |
|---|---|
| New **文件管理** tab in the right sidebar (reachable from the guide page) | breadcrumb navigation, directories-first ordering, multi-select, drag & drop upload (folders included), per-file progress and cancel, overwrite confirmation, file download, folder ZIP download, rename, delete, new folder |
| Action row of the shipped **文件** tab | **Upload**, **ZIP download** and **Open manager** for the folder currently displayed |
| Action row of the document preview tab | **Download** for the open file |

Uploads stream to disk (no full-file buffering), downloads honour HTTP `Range`, folder archives are streamed as the tree is walked.

## Install

The package is a standard DSH profile bundle (`dsh.bundle.patch` + `dsh.client`):

```bash
cd ~/.dsh/profiles/web
pnpm add file:/path/to/dsh-file-manager
# then add "dsh-file-manager" to package.json -> dsh.profile.bundles
```

Or link the source without pnpm:

```bash
ln -s /path/to/dsh-file-manager ~/.dsh/profiles/web/node_modules/dsh-file-manager
# add "dsh-file-manager" to package.json -> dsh.profile.bundles
```

Restart `dsh web` (or let profile hot reload pick it up) and refresh the page. The bundled `cordis.patch.yml` inserts the host row:

```yaml
- insert:
    - id: file-manager
      name: dsh-file-manager
```

Disable it from the profile patch with `- id: file-manager` + `disabled: true`; the browser half disappears with its host row.

## Host routes

All under `/api2/dsh-file-manager/*` (not the reflection-owned `/api` channel):

| Method | Path | Purpose |
|---|---|---|
| GET | `/info?sessionId` | session workspace root |
| GET | `/list?sessionId&path` | one directory level |
| POST | `/upload?sessionId&path&name&overwrite` | raw `application/octet-stream` body streamed to disk; `name` may contain `a/b/c` |
| GET | `/download?sessionId&path[&inline=1]` | one file, `Range` supported |
| GET | `/zip?sessionId&path` | streamed ZIP of a directory |
| POST | `/mkdir` | JSON `{sessionId, path}` |
| POST | `/move` | JSON `{sessionId, from, to, overwrite?}` |
| POST | `/copy` | JSON `{sessionId, from, to, overwrite?}` |
| POST | `/delete` | JSON `{sessionId, paths: []}` |

Success is `{ "ok": true, "value": … }`; failures are `{ "ok": false, "error": { code, message, details } }` with a matching status (`outside-workspace` 403, `exists` 409, `upload-too-large` 413, …).

## Security

- **Auth & origin**: every route first asks the composition's `connection.requestRejection()` — the same Host/Origin fence plus browser session cookie that guards the official `/api` channel. A composition without Connection is refused, not served.
- **CSRF**: every mutating route also requires the custom header `x-dsh-fm: 1`, which a cross-site form cannot set.
- **Workspace confinement**: paths resolve against the session `cwd` (falling back to `sandboxPolicy.workspaceRoot`), absolute paths included; `..` cannot climb out, and the real path is re-checked, so **a symlink pointing outside the workspace is refused** for download, zip, delete and move alike.
- **Overwrite**: upload and move refuse to clobber by default (`exists`); the browser confirms and retries with `overwrite`.
- **Ceilings**: 16 GiB per upload (`maxUploadBytes`), 5000 listed entries, ZIP up to 60000 entries / 4 GiB (ZIP32).

## Configuration

```yaml
- id: file-manager
  config:
    maxUploadBytes: 17179869184
    maxListEntries: 5000
    zipMaxEntries: 60000
    zipMaxBytes: 4294967294
```

## Known limits

- **No resumable upload**: a failed upload restarts from byte zero; downloads can resume through `Range`.
- **Copy fallback before the host reloads**: the `/copy` route needs a dsh restart. Until it is live, paste falls back to download + re-upload (recursing through directories) — same result, slower; the server route is used automatically once loaded.
- **ZIP32 only**: archives beyond 4 GiB or 60000 entries fail with a clear error rather than producing a corrupt file.
- **No permission/ownership editing**: `chmod`/`chown` are out of scope.
- **One workspace**: it manages the current session's workspace only.
- **Takeover, not a sibling**: the panel is the same `files` type, so the shipped implementation is shadowed until the plugin unloads; two file panels never appear side by side.

## Development

```bash
cd dsh-file-manager
ln -s ~/.dsh/profiles/web/node_modules node_modules   # schemastery for tests
node --test test/*.test.mjs
```
