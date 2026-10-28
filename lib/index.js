/**
 * dsh-file-manager — host half.
 *
 * The shipped workspace-files Remote lists and reads files; this plugin adds the
 * write direction and the transfer endpoints a browser file manager needs, so a
 * user can replace an SFTP client for their session workspace:
 *
 *   GET  /api2/dsh-file-manager/list      one directory level
 *   GET  /api2/dsh-file-manager/info      the session workspace root
 *   POST /api2/dsh-file-manager/upload    raw streamed bytes → one file
 *   GET  /api2/dsh-file-manager/download  one file (Range supported)
 *   GET  /api2/dsh-file-manager/zip       one directory as a streamed ZIP
 *   POST /api2/dsh-file-manager/mkdir     create a directory
 *   POST /api2/dsh-file-manager/move      rename / move
 *   POST /api2/dsh-file-manager/delete    remove files or trees
 *
 * Security posture matches the shipped hosts: every route first asks the
 * composition's Connection service for a rejection (Host/Origin fence plus the
 * browser session cookie), mutations additionally require a custom header a
 * cross-site form cannot set, and every path is resolved relative to the
 * session workspace root and refused when it would escape it.
 *
 * @module dsh-file-manager
 */
import path from 'node:path'
import { createReadStream, createWriteStream } from 'node:fs'
import {
  cp,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { randomBytes } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import {
  canonicalizeRoot,
  FileOpError,
  isInside,
  normalizeRelativeName,
  resolveInside,
} from './paths.js'
import { ZipWriter } from './zip.js'

/** Cordis plugin name. */
export const name = 'dsh-file-manager'

/** The webserver owns the browser entry point; Connection owns the trust fence. */
export const inject = ['webServer']

/** Route namespace. Deliberately not under the reflection-owned `/api` channel. */
export const ROUTE_PREFIX = '/api2/dsh-file-manager'

/** Composition-time defaults; every one is a safety ceiling, not a feature flag. */
export const DEFAULTS = Object.freeze({
  maxUploadBytes: 16 * 1024 * 1024 * 1024,
  maxListEntries: 5000,
  zipMaxEntries: 60000,
  zipMaxBytes: 4 * 1024 * 1024 * 1024 - 1,
})

/** Schemastery schema validated by the Cordis loader before `apply()` runs. */
export const Config = z.object({
  maxUploadBytes: z.natural().default(DEFAULTS.maxUploadBytes),
  maxListEntries: z.natural().default(DEFAULTS.maxListEntries),
  zipMaxEntries: z.natural().default(DEFAULTS.zipMaxEntries),
  zipMaxBytes: z.natural().default(DEFAULTS.zipMaxBytes),
})

/** HTTP status per stable failure code. */
const STATUS = {
  'bad-request': 400,
  'forbidden': 403,
  'not-found': 404,
  'not-a-directory': 400,
  'is-a-directory': 400,
  'exists': 409,
  'outside-workspace': 403,
  'upload-too-large': 413,
  'zip-too-large': 413,
  'internal': 500,
}

/** Extension → media type for the download route; anything else is octet-stream. */
const MEDIA_TYPES = {
  css: 'text/css; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  gif: 'image/gif',
  gz: 'application/gzip',
  htm: 'text/html; charset=utf-8',
  html: 'text/html; charset=utf-8',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  jsonl: 'application/x-ndjson; charset=utf-8',
  m4a: 'audio/mp4',
  mjs: 'text/javascript; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  pdf: 'application/pdf',
  png: 'image/png',
  svg: 'image/svg+xml',
  tar: 'application/x-tar',
  txt: 'text/plain; charset=utf-8',
  wasm: 'application/wasm',
  webm: 'video/webm',
  webp: 'image/webp',
  woff2: 'font/woff2',
  xml: 'application/xml; charset=utf-8',
  yml: 'text/yaml; charset=utf-8',
  yaml: 'text/yaml; charset=utf-8',
  zip: 'application/zip',
}

/** JSON response helper. */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** Map any thrown value onto the JSON error envelope. */
function sendError(res, error) {
  const failure = error instanceof FileOpError
    ? error
    : new FileOpError('internal', error instanceof Error ? error.message : String(error))
  if (res.headersSent) {
    res.destroy()
    return
  }
  sendJson(res, STATUS[failure.code] ?? 500, {
    ok: false,
    error: { code: failure.code, message: failure.message, details: failure.details },
  })
}

/** Read a bounded JSON body. */
async function readJsonBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      req.resume()
      throw new FileOpError('bad-request', 'request body is too large')
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks, size).toString('utf8')
  if (text.trim() === '') throw new FileOpError('bad-request', 'request body is required')
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new FileOpError('bad-request', 'request body must be a JSON object')
    }
    return parsed
  } catch (error) {
    if (error instanceof FileOpError) throw error
    throw new FileOpError('bad-request', 'request body must be valid JSON')
  }
}

/** Content-Disposition with an ASCII fallback plus RFC 5987 UTF-8 name. */
function disposition(kind, filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

/** Media type from a file name. */
function mediaTypeOf(filename) {
  const dot = filename.lastIndexOf('.')
  const suffix = dot === -1 ? '' : filename.slice(dot + 1).toLowerCase()
  return MEDIA_TYPES[suffix] ?? 'application/octet-stream'
}

/**
 * Parse one `bytes=` range against a known size.
 * @returns {{ start: number, end: number } | 'invalid' | undefined} the window, or a marker.
 */
function parseRange(header, size) {
  if (typeof header !== 'string' || !header.startsWith('bytes=')) return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return 'invalid'
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return 'invalid'
  let start
  let end
  if (rawStart === '') {
    const length = Number(rawEnd)
    if (!Number.isSafeInteger(length) || length <= 0) return 'invalid'
    start = Math.max(0, size - length)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return 'invalid'
  return { start, end: Math.min(end, size - 1) }
}

/** List one directory level with the metadata the browser table shows. */
async function listDirectory(target, limit) {
  const dirents = await readdir(target, { withFileTypes: true })
  const entries = []
  for (const dirent of dirents) {
    const absolutePath = path.join(target, dirent.name)
    let info
    try {
      info = await lstat(absolutePath)
    } catch {
      continue
    }
    const symlink = info.isSymbolicLink()
    let type = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other'
    let size = info.size
    let mtimeMs = info.mtimeMs
    if (symlink) {
      try {
        const followed = await stat(absolutePath)
        type = followed.isDirectory() ? 'directory' : followed.isFile() ? 'file' : 'other'
        size = followed.size
        mtimeMs = followed.mtimeMs
      } catch {
        type = 'other'
      }
    }
    entries.push({ name: dirent.name, type, size, mtimeMs, symlink })
  }
  entries.sort((left, right) => {
    const leftRank = left.type === 'directory' ? 0 : left.type === 'file' ? 1 : 2
    const rightRank = right.type === 'directory' ? 0 : right.type === 'file' ? 1 : 2
    if (leftRank !== rightRank) return leftRank - rightRank
    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
  })
  return {
    entries: entries.length > limit ? entries.slice(0, limit) : entries,
    truncated: entries.length > limit,
  }
}

/**
 * Walk one directory tree for the ZIP route.
 * @returns {Promise<Array<{ rel: string, abs: string, kind: 'dir'|'file', size: number, mtimeMs: number }>>} entries.
 */
async function collectZipEntries(root, target, limits) {
  const collected = []
  let totalBytes = 0

  /** @param {string} dir @param {string} prefix */
  const walk = async (dir, prefix) => {
    const dirents = await readdir(dir, { withFileTypes: true })
    dirents.sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' }))
    for (const dirent of dirents) {
      const absolutePath = path.join(dir, dirent.name)
      const rel = prefix === '' ? dirent.name : `${prefix}/${dirent.name}`
      let info
      try {
        info = await lstat(absolutePath)
      } catch {
        continue
      }
      if (info.isSymbolicLink()) {
        let resolved
        try {
          resolved = await realpath(absolutePath)
        } catch {
          continue
        }
        // A link that leaves the workspace would leak its target into the archive.
        if (!isInside(root, resolved)) continue
        try {
          info = await stat(absolutePath)
        } catch {
          continue
        }
      }
      if (info.isDirectory()) {
        collected.push({ rel: `${rel}/`, abs: absolutePath, kind: 'dir', size: 0, mtimeMs: info.mtimeMs })
        if (collected.length > limits.zipMaxEntries) {
          throw new FileOpError('zip-too-large', `the folder holds more than ${limits.zipMaxEntries} entries`)
        }
        await walk(absolutePath, rel)
      } else if (info.isFile()) {
        totalBytes += info.size
        if (totalBytes > limits.zipMaxBytes) {
          throw new FileOpError('zip-too-large', 'the folder is larger than the 4 GiB ZIP32 limit')
        }
        collected.push({ rel, abs: absolutePath, kind: 'file', size: info.size, mtimeMs: info.mtimeMs })
        if (collected.length > limits.zipMaxEntries) {
          throw new FileOpError('zip-too-large', `the folder holds more than ${limits.zipMaxEntries} entries`)
        }
      }
    }
  }

  await walk(target, '')
  return collected
}

/** The live Session's workspace root, falling back to the sandbox policy root. */
function workspaceRootOf(ctx, sessionId) {
  const sessions = safeGet(ctx, 'sessions')
  let cwd
  if (sessions !== undefined && typeof sessions.get === 'function') {
    try {
      cwd = sessions.get(sessionId)?.header?.cwd
    } catch {
      cwd = undefined
    }
  }
  if (typeof cwd === 'string' && cwd !== '') return cwd
  const policy = safeGet(ctx, 'sandboxPolicy')
  const root = policy?.workspaceRoot
  if (typeof root === 'string' && root !== '') return root
  throw new FileOpError('bad-request', `session "${sessionId}" has no workspace root`)
}

/** Read a service without asserting it was declared in the plugin's inject map. */
function safeGet(ctx, serviceName) {
  try {
    return ctx.get(serviceName)
  } catch {
    return undefined
  }
}

/**
 * Register every route.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context carrying the web server.
 * @param {object} [rawConfig] - validated Cordis config.
 */
export function apply(ctx, rawConfig) {
  const settings = { ...DEFAULTS, ...(rawConfig ?? {}) }

  /**
   * Answer an untrusted or unauthenticated request; true when it was rejected.
   * The fence is read per request: the Connection service may mount after this
   * plugin, and a composition without one must not expose unauthenticated I/O.
   */
  const rejected = (req, res) => {
    const connection = safeGet(ctx, 'connection')
    if (connection === undefined || typeof connection.requestRejection !== 'function') {
      res.statusCode = 503
      res.end()
      return true
    }
    const rejection = connection.requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  /** Mutations must carry a header a cross-site form cannot set. */
  const crossSiteGuard = (req) => {
    if (req.headers['x-dsh-fm'] === '1') return true
    throw new FileOpError('forbidden', 'missing x-dsh-fm request header')
  }

  /** Query parameters of this request. */
  const paramsOf = (req) => new URL(req.url ?? '/', 'http://dsh.invalid').searchParams

  /** Canonical workspace root for the addressed session. */
  const rootOf = async (sessionId) => canonicalizeRoot(workspaceRootOf(ctx, sessionId))

  /** A required string query parameter. */
  const required = (params, key) => {
    const value = params.get(key)
    if (value === null || value === '') throw new FileOpError('bad-request', `"${key}" is required`)
    return value
  }

  /**
   * Register one exact route with the shared method/fence/error plumbing.
   * @param {string} op route name under {@link ROUTE_PREFIX}.
   * @param {string} method the one supported method.
   * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, params: URLSearchParams) => Promise<void>} handler
   */
  const route = (op, method, handler) => {
    const registered = ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/${op}`,
      handler: async (req, res) => {
        if (rejected(req, res)) return
        if (req.method !== method) {
          res.statusCode = 405
          res.setHeader('allow', method)
          res.end()
          return
        }
        try {
          await handler(req, res, paramsOf(req))
        } catch (error) {
          sendError(res, error)
        }
      },
    }), `dsh-file-manager: ${method} ${ROUTE_PREFIX}/${op}`)
    return registered
  }

  route('info', 'GET', async (req, res, params) => {
    const sessionId = required(params, 'sessionId')
    const root = await rootOf(sessionId)
    sendJson(res, 200, { ok: true, value: { root, separator: path.sep } })
  })

  route('list', 'GET', async (req, res, params) => {
    const sessionId = required(params, 'sessionId')
    const root = await rootOf(sessionId)
    const target = await resolveInside(root, params.get('path') ?? '')
    const info = await stat(target)
    if (!info.isDirectory()) throw new FileOpError('not-a-directory', 'the path is not a directory')
    const { entries, truncated } = await listDirectory(target, settings.maxListEntries)
    sendJson(res, 200, { ok: true, value: { root, path: target, entries, truncated } })
  })

  route('upload', 'POST', async (req, res, params) => {
    crossSiteGuard(req)
    const mediaType = String(req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase()
    if (mediaType !== 'application/octet-stream') {
      req.resume()
      throw new FileOpError('bad-request', 'content-type must be application/octet-stream')
    }
    const sessionId = required(params, 'sessionId')
    const name = normalizeRelativeName(params.get('name'))
    const declaredLength = Number(req.headers['content-length'])
    if (Number.isFinite(declaredLength) && declaredLength > settings.maxUploadBytes) {
      req.resume()
      throw new FileOpError('upload-too-large', `the upload exceeds ${settings.maxUploadBytes} bytes`)
    }
    const overwrite = params.get('overwrite') === '1'
    const root = await rootOf(sessionId)
    const directory = await resolveInside(root, params.get('path') ?? '')
    const directoryInfo = await stat(directory)
    if (!directoryInfo.isDirectory()) throw new FileOpError('not-a-directory', 'the upload target is not a directory')
    const target = await resolveInside(root, path.join(directory, name))
    if (target === root) throw new FileOpError('forbidden', 'refusing to overwrite the workspace root')
    await mkdir(path.dirname(target), { recursive: true })
    const confined = await resolveInside(root, path.dirname(target))

    let existing
    try {
      existing = await lstat(target)
    } catch {
      existing = undefined
    }
    if (existing !== undefined && existing.isDirectory()) {
      throw new FileOpError('is-a-directory', 'a directory with that name already exists')
    }
    if (existing !== undefined && !overwrite) {
      req.resume()
      throw new FileOpError('exists', `"${name}" already exists`, { name })
    }

    const temporary = path.join(confined, `.${path.basename(target)}.dshupload-${randomBytes(6).toString('hex')}`)
    let received = 0
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length
        if (received > settings.maxUploadBytes) {
          callback(new FileOpError('upload-too-large', `the upload exceeds ${settings.maxUploadBytes} bytes`))
          return
        }
        callback(null, chunk)
      },
    })
    try {
      await pipeline(req, counter, createWriteStream(temporary, { mode: 0o644 }))
      await rename(temporary, target)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {})
      throw error
    }
    sendJson(res, 200, { ok: true, value: { path: target, size: received } })
  })

  route('download', 'GET', async (req, res, params) => {
    const sessionId = required(params, 'sessionId')
    const root = await rootOf(sessionId)
    const target = await resolveInside(root, required(params, 'path'))
    const info = await stat(target)
    if (info.isDirectory()) throw new FileOpError('is-a-directory', 'directories are downloaded as ZIP archives')
    if (!info.isFile()) throw new FileOpError('forbidden', 'only regular files can be downloaded')
    const filename = path.basename(target)
    const inline = params.get('inline') === '1'
    const range = parseRange(req.headers.range, info.size)
    if (range === 'invalid') {
      res.statusCode = 416
      res.setHeader('content-range', `bytes */${info.size}`)
      res.end()
      return
    }
    res.statusCode = range === undefined ? 200 : 206
    res.setHeader('content-type', inline ? mediaTypeOf(filename) : 'application/octet-stream')
    res.setHeader('content-length', String(range === undefined ? info.size : range.end - range.start + 1))
    res.setHeader('content-disposition', disposition(inline ? 'inline' : 'attachment', filename))
    res.setHeader('accept-ranges', 'bytes')
    res.setHeader('cache-control', 'no-store')
    if (range !== undefined) res.setHeader('content-range', `bytes ${range.start}-${range.end}/${info.size}`)
    const stream = range === undefined ? createReadStream(target) : createReadStream(target, { start: range.start, end: range.end })
    try {
      await pipeline(stream, res)
    } catch (error) {
      res.destroy(error instanceof Error ? error : undefined)
    }
  })

  route('zip', 'GET', async (req, res, params) => {
    const sessionId = required(params, 'sessionId')
    const root = await rootOf(sessionId)
    const target = await resolveInside(root, required(params, 'path'))
    const info = await stat(target)
    if (!info.isDirectory()) throw new FileOpError('not-a-directory', 'only directories are archived')
    const entries = await collectZipEntries(root, target, settings)
    res.statusCode = 200
    res.setHeader('content-type', 'application/zip')
    res.setHeader('content-disposition', disposition('attachment', `${path.basename(target) || 'workspace'}.zip`))
    res.setHeader('cache-control', 'no-store')
    const writer = new ZipWriter(res)
    try {
      for (const entry of entries) {
        if (entry.kind === 'dir') await writer.addDirectory(entry.rel, entry.mtimeMs)
        else await writer.addFile(entry.rel, entry.abs, { size: entry.size, mtimeMs: entry.mtimeMs })
      }
      await writer.finish()
      res.end()
    } catch (error) {
      res.destroy(error instanceof Error ? error : undefined)
    }
  })

  route('mkdir', 'POST', async (req, res) => {
    crossSiteGuard(req)
    const body = await readJsonBody(req, 64 * 1024)
    const sessionId = requiredString(body, 'sessionId')
    const root = await rootOf(sessionId)
    const target = await resolveInside(root, requiredString(body, 'path'))
    if (target === root) throw new FileOpError('exists', 'the workspace root already exists')
    try {
      await mkdir(target, { recursive: false })
    } catch (error) {
      if (error && error.code === 'EEXIST') throw new FileOpError('exists', 'a file or directory with that name already exists')
      if (error && error.code === 'ENOENT') throw new FileOpError('not-found', 'the parent directory does not exist')
      throw error
    }
    sendJson(res, 200, { ok: true, value: { path: target } })
  })

  route('move', 'POST', async (req, res) => {
    crossSiteGuard(req)
    const body = await readJsonBody(req, 64 * 1024)
    const sessionId = requiredString(body, 'sessionId')
    const root = await rootOf(sessionId)
    const from = await resolveInside(root, requiredString(body, 'from'))
    const to = await resolveInside(root, requiredString(body, 'to'))
    const overwrite = body.overwrite === true
    if (from === root || to === root) throw new FileOpError('forbidden', 'the workspace root cannot be moved or replaced')
    if (from !== to && isInside(from, to)) throw new FileOpError('bad-request', 'a directory cannot be moved into itself')
    const fromInfo = await stat(from).catch(() => {
      throw new FileOpError('not-found', 'the source path does not exist')
    })
    let toExists = true
    try {
      await lstat(to)
    } catch {
      toExists = false
    }
    if (toExists && !overwrite) {
      throw new FileOpError('exists', 'a file or directory with that name already exists')
    }
    if (toExists && overwrite) await rm(to, { recursive: true, force: true })
    await mkdir(path.dirname(to), { recursive: true })
    try {
      await rename(from, to)
    } catch (error) {
      if (error && error.code === 'EXDEV') {
        await cp(from, to, { recursive: fromInfo.isDirectory(), force: true, errorOnExist: false })
        await rm(from, { recursive: true, force: true })
      } else {
        throw error
      }
    }
    sendJson(res, 200, { ok: true, value: { from, to } })
  })

  route('copy', 'POST', async (req, res) => {
    crossSiteGuard(req)
    const body = await readJsonBody(req, 64 * 1024)
    const sessionId = requiredString(body, 'sessionId')
    const root = await rootOf(sessionId)
    const from = await resolveInside(root, requiredString(body, 'from'))
    const to = await resolveInside(root, requiredString(body, 'to'))
    const overwrite = body.overwrite === true
    if (from === root || to === root) throw new FileOpError('forbidden', 'the workspace root cannot be copied or replaced')
    if (from !== to && isInside(from, to)) throw new FileOpError('bad-request', 'a directory cannot be copied into itself')
    await stat(from).catch(() => {
      throw new FileOpError('not-found', 'the source path does not exist')
    })
    const toExists = await lstat(to).then(() => true, () => false)
    if (toExists && !overwrite) throw new FileOpError('exists', 'a file or directory with that name already exists')
    await mkdir(path.dirname(to), { recursive: true })
    // Windows semantics: copy merges into an existing directory and replaces
    // colliding files, instead of deleting the destination first.
    await cp(from, to, { recursive: true, force: true, errorOnExist: false, preserveTimestamps: true, dereference: false })
    const info = await stat(to)
    sendJson(res, 200, {
      ok: true,
      value: { path: to, type: info.isDirectory() ? 'directory' : 'file', size: info.size },
    })
  })

  route('delete', 'POST', async (req, res) => {
    crossSiteGuard(req)
    const body = await readJsonBody(req, 1024 * 1024)
    const sessionId = requiredString(body, 'sessionId')
    const root = await rootOf(sessionId)
    if (!Array.isArray(body.paths) || body.paths.length === 0) {
      throw new FileOpError('bad-request', '"paths" must be a non-empty array')
    }
    const failures = []
    let removed = 0
    for (const raw of body.paths) {
      if (typeof raw !== 'string') {
        failures.push({ path: String(raw), code: 'bad-request', message: 'path must be a string' })
        continue
      }
      try {
        const target = await resolveInside(root, raw)
        if (target === root) throw new FileOpError('forbidden', 'the workspace root cannot be deleted')
        await rm(target, { recursive: true, force: false })
        removed += 1
      } catch (error) {
        const failure = error instanceof FileOpError
          ? error
          : new FileOpError('internal', error instanceof Error ? error.message : String(error))
        failures.push({ path: raw, code: failure.code, message: failure.message })
      }
    }
    sendJson(res, 200, { ok: true, value: { removed, failures } })
  })
}

/** Read one required non-empty string field of a JSON body. */
function requiredString(body, key) {
  const value = body[key]
  if (typeof value !== 'string' || value === '') throw new FileOpError('bad-request', `"${key}" is required`)
  return value
}
