/**
 * Path confinement for the file manager.
 *
 * Every route resolves client-supplied paths through here before touching the
 * filesystem. The rules are the same ones the shipped workspace-files Remote
 * enforces: a path is interpreted relative to the Session workspace root unless
 * it is already absolute, `..` can never climb out, and a symlink that points
 * outside the root is refused rather than followed.
 *
 * @module dsh-file-manager/paths
 */
import path from 'node:path'
import { realpath } from 'node:fs/promises'

/** Failure carrying a stable code the HTTP layer maps onto a status. */
export class FileOpError extends Error {
  /**
   * @param {string} code stable failure code (`bad-request`, `outside-workspace`, …).
   * @param {string} message human diagnostic.
   * @param {object} [details] structured payload for the client.
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'FileOpError'
    this.code = code
    this.details = details
  }
}

/**
 * Whether `candidate` is `root` itself or sits below it.
 * @param {string} root absolute, canonical root.
 * @param {string} candidate absolute, canonical candidate.
 * @returns {boolean} true when the candidate is inside the root.
 */
export function isInside(root, candidate) {
  if (candidate === root) return true
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  return candidate.startsWith(prefix)
}

/**
 * Canonicalize the workspace root once per request.
 * @param {string} [root] the Session workspace root (cwd or sandbox root).
 * @returns {Promise<string>} its real path.
 * @throws {FileOpError} when the root is unknown or missing.
 */
export async function canonicalizeRoot(root) {
  if (typeof root !== 'string' || root === '') {
    throw new FileOpError('bad-request', 'the session workspace root is unknown')
  }
  try {
    return await realpath(root)
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new FileOpError('not-found', `the workspace root does not exist: ${root}`)
    }
    throw error
  }
}

/**
 * Resolve the real path of `target`, tolerating the not-yet-existing tail of a
 * path about to be created (upload, mkdir, rename destination).
 * @param {string} target absolute path.
 * @returns {Promise<string>} the real path of the deepest existing ancestor plus the missing tail.
 */
async function realpathLoose(target) {
  const tail = []
  let current = target
  for (;;) {
    try {
      const real = await realpath(current)
      return tail.length === 0 ? real : path.join(real, ...tail.slice().reverse())
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      tail.push(path.basename(current))
      current = parent
    }
  }
}

/**
 * Resolve one client path against the workspace root and prove it stays inside.
 * @param {string} root canonical workspace root.
 * @param {string} [input] absolute or workspace-relative path; empty means the root.
 * @param {object} [options] reserved for future flags.
 * @returns {Promise<string>} canonical absolute path inside the root.
 * @throws {FileOpError} `outside-workspace` when confinement would be broken.
 */
export async function resolveInside(root, input, options) {
  void options
  const raw = input === undefined || input === null ? '' : String(input)
  if (raw.includes('\0')) throw new FileOpError('bad-request', 'path contains a NUL byte')
  const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw)
  if (!isInside(root, candidate)) {
    throw new FileOpError('outside-workspace', `"${raw}" is outside the workspace`, { path: raw })
  }
  const real = await realpathLoose(candidate)
  if (!isInside(root, real)) {
    throw new FileOpError('outside-workspace', `"${raw}" resolves outside the workspace`, { path: raw })
  }
  return real
}

/**
 * Validate a browser-supplied file name (which may carry sub-directories for a
 * folder upload) and normalize its separators.
 * @param {unknown} name raw name from the request.
 * @returns {string} a relative `a/b/c` path.
 * @throws {FileOpError} `bad-request` when the name is empty or escapes upward.
 */
export function normalizeRelativeName(name) {
  if (typeof name !== 'string' || name === '') {
    throw new FileOpError('bad-request', 'name is required')
  }
  if (name.includes('\0')) throw new FileOpError('bad-request', 'name contains a NUL byte')
  const parts = name.replace(/\\/g, '/').split('/')
  const kept = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') throw new FileOpError('bad-request', 'name must not climb out of its directory')
    kept.push(part)
  }
  if (kept.length === 0) throw new FileOpError('bad-request', 'name is required')
  return kept.join('/')
}

/**
 * Display path: the path relative to the root, or `.` for the root itself.
 * @param {string} root canonical workspace root.
 * @param {string} abs absolute path inside the root.
 * @returns {string} a workspace-relative path.
 */
export function relativeTo(root, abs) {
  if (abs === root) return '.'
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  return abs.startsWith(prefix) ? abs.slice(prefix.length) : abs
}
