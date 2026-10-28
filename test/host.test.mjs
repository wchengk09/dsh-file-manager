/**
 * End-to-end tests for the host half: a real HTTP server over the registered
 * routes, a real temporary workspace, and assertions on files on disk.
 *
 * Run with: node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'

const SESSION = 'session-test'

/**
 * Build a fake host context and a real HTTP server over the plugin's routes.
 * @param {object} options harness options.
 * @returns {Promise<{ root: string, base: string, setRejection: Function, close: Function }>} harness.
 */
async function harness(options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-fm-'))
  const routes = new Map()
  let rejection
  const ctx = {
    effect(fn) {
      return fn()
    },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    get(name) {
      if (name === 'connection') return { requestRejection: () => (rejection === undefined ? undefined : rejection) }
      if (name === 'sessions') {
        return { get: (id) => (id === SESSION ? { header: { cwd: root } } : undefined) }
      }
      if (name === 'sandboxPolicy') return { workspaceRoot: root }
      return undefined
    },
    logger: { warn() {}, error() {} },
  }
  apply(ctx, { maxUploadBytes: options.maxUploadBytes ?? 8 * 1024 * 1024, maxListEntries: 5000 })

  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    const route = routes.get(pathname)
    if (route === undefined) {
      res.statusCode = 404
      res.end()
      return
    }
    route.handler(req, res).catch((error) => {
      res.destroy(error)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    root,
    base,
    setRejection(value) {
      rejection = value
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }).then(() => rm(root, { recursive: true, force: true }))
    },
  }
}

/** GET one JSON route. */
async function getJson(base, op, params) {
  const search = new URLSearchParams({ sessionId: SESSION, ...params })
  const response = await fetch(`${base}/api2/dsh-file-manager/${op}?${search}`)
  const text = await response.text()
  return { status: response.status, body: text === '' ? null : JSON.parse(text), headers: response.headers }
}

/** POST one JSON route. */
async function postJson(base, op, body) {
  const response = await fetch(`${base}/api2/dsh-file-manager/${op}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-fm': '1' },
    body: JSON.stringify({ sessionId: SESSION, ...body }),
  })
  const text = await response.text()
  return { status: response.status, body: text === '' ? null : JSON.parse(text) }
}

/** Upload raw bytes. */
async function upload(base, { directory, name, bytes, overwrite = false, headers = {} }) {
  const search = new URLSearchParams({
    sessionId: SESSION,
    path: directory,
    name,
    overwrite: overwrite ? '1' : '0',
  })
  const response = await fetch(`${base}/api2/dsh-file-manager/upload?${search}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-dsh-fm': '1', ...headers },
    body: bytes,
  })
  const text = await response.text()
  return { status: response.status, body: text === '' ? null : JSON.parse(text) }
}

test('lists a directory with directories first and symlinks resolved', async () => {
  const h = await harness()
  try {
    await mkdir(path.join(h.root, 'src'))
    await writeFile(path.join(h.root, 'b.txt'), 'hello')
    await writeFile(path.join(h.root, 'A.md'), '# a')
    await symlink(path.join(h.root, 'src'), path.join(h.root, 'link'))
    const { status, body } = await getJson(h.base, 'list', {})
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.value.root, h.root)
    assert.deepEqual(body.value.entries.map((entry) => entry.name), ['link', 'src', 'A.md', 'b.txt'])
    assert.equal(body.value.entries[1].type, 'directory')
    assert.equal(body.value.entries[2].type, 'file')
    assert.equal(body.value.entries[2].size, 3)
    assert.equal(body.value.entries[0].symlink, true)
    assert.equal(body.value.entries[0].type, 'directory')
  } finally {
    await h.close()
  }
})

test('uploads, refuses overwrite until asked, and creates nested folders', async () => {
  const h = await harness()
  try {
    const first = await upload(h.base, { directory: '', name: 'notes.txt', bytes: Buffer.from('first') })
    assert.equal(first.status, 200)
    assert.equal(first.body.value.size, 5)
    assert.equal(await readFile(path.join(h.root, 'notes.txt'), 'utf8'), 'first')

    const second = await upload(h.base, { directory: '', name: 'notes.txt', bytes: Buffer.from('second') })
    assert.equal(second.status, 409)
    assert.equal(second.body.error.code, 'exists')
    assert.equal(await readFile(path.join(h.root, 'notes.txt'), 'utf8'), 'first')

    const third = await upload(h.base, { directory: '', name: 'notes.txt', bytes: Buffer.from('second'), overwrite: true })
    assert.equal(third.status, 200)
    assert.equal(await readFile(path.join(h.root, 'notes.txt'), 'utf8'), 'second')

    const nested = await upload(h.base, { directory: '', name: 'a/b/c/deep.bin', bytes: Buffer.from([1, 2, 3]) })
    assert.equal(nested.status, 200)
    assert.deepEqual([...(await readFile(path.join(h.root, 'a/b/c/deep.bin')))], [1, 2, 3])

    const intoSub = await upload(h.base, { directory: path.join(h.root, 'a/b'), name: 'sibling.txt', bytes: Buffer.from('x') })
    assert.equal(intoSub.status, 200)
    assert.equal(await readFile(path.join(h.root, 'a/b/sibling.txt'), 'utf8'), 'x')
  } finally {
    await h.close()
  }
})

test('rejects escapes, missing CSRF header, wrong content type and oversize bodies', async () => {
  const h = await harness({ maxUploadBytes: 1024 })
  try {
    const traversal = await upload(h.base, { directory: '', name: '../escape.txt', bytes: Buffer.from('x') })
    assert.equal(traversal.status, 400)
    assert.equal(traversal.body.error.code, 'bad-request')

    const outside = await upload(h.base, { directory: '/tmp', name: 'escape.txt', bytes: Buffer.from('x') })
    assert.equal(outside.status, 403)
    assert.equal(outside.body.error.code, 'outside-workspace')

    const noHeader = await upload(h.base, { directory: '', name: 'x.txt', bytes: Buffer.from('x'), headers: { 'x-dsh-fm': '0' } })
    assert.equal(noHeader.status, 403)

    const badType = await fetch(`${h.base}/api2/dsh-file-manager/upload?sessionId=${SESSION}&path=&name=x.txt`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-dsh-fm': '1' },
      body: 'x',
    })
    assert.equal(badType.status, 400)
    await badType.text()

    const tooBig = await upload(h.base, { directory: '', name: 'big.bin', bytes: Buffer.alloc(4096, 7) })
    assert.equal(tooBig.status, 413)
    const leftovers = await getJson(h.base, 'list', {})
    assert.deepEqual(leftovers.body.value.entries.map((entry) => entry.name), [])

    h.setRejection(401)
    const rejected = await getJson(h.base, 'list', {})
    assert.equal(rejected.status, 401)
  } finally {
    await h.close()
  }
})

test('downloads a file with attachment headers and honours Range', async () => {
  const h = await harness()
  try {
    await writeFile(path.join(h.root, 'hello world.txt'), '0123456789')
    const url = `${h.base}/api2/dsh-file-manager/download?sessionId=${SESSION}&path=${encodeURIComponent('hello world.txt')}`
    const whole = await fetch(url)
    assert.equal(whole.status, 200)
    assert.equal(whole.headers.get('content-type'), 'application/octet-stream')
    assert.match(whole.headers.get('content-disposition'), /attachment/)
    assert.match(whole.headers.get('content-disposition'), /filename\*=UTF-8''hello%20world\.txt/)
    assert.equal(await whole.text(), '0123456789')

    const partial = await fetch(url, { headers: { range: 'bytes=2-4' } })
    assert.equal(partial.status, 206)
    assert.equal(partial.headers.get('content-range'), 'bytes 2-4/10')
    assert.equal(await partial.text(), '234')

    const invalid = await fetch(url, { headers: { range: 'bytes=99-100' } })
    assert.equal(invalid.status, 416)
    await invalid.text()
  } finally {
    await h.close()
  }
})

test('refuses to follow a symlink that leaves the workspace', async () => {
  const h = await harness()
  try {
    await symlink('/etc/hostname', path.join(h.root, 'leak'))
    const url = `${h.base}/api2/dsh-file-manager/download?sessionId=${SESSION}&path=${encodeURIComponent('leak')}`
    const response = await fetch(url)
    assert.equal(response.status, 403)
    const body = JSON.parse(await response.text())
    assert.equal(body.error.code, 'outside-workspace')
  } finally {
    await h.close()
  }
})

test('archives a directory as a valid ZIP that unzips to the same tree', async () => {
  const h = await harness()
  try {
    await mkdir(path.join(h.root, 'project/sub'), { recursive: true })
    await writeFile(path.join(h.root, 'project/README.md'), '# readme\n')
    await writeFile(path.join(h.root, 'project/sub/data.bin'), Buffer.alloc(200, 3))
    await writeFile(path.join(h.root, 'project/empty.txt'), '')
    const response = await fetch(`${h.base}/api2/dsh-file-manager/zip?sessionId=${SESSION}&path=project`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'application/zip')
    assert.match(response.headers.get('content-disposition'), /project\.zip/)
    const archive = Buffer.from(await response.arrayBuffer())
    assert.equal(archive.subarray(0, 2).toString(), 'PK')

    const archivePath = path.join(tmpdir(), `dsh-fm-${Date.now()}.zip`)
    const outDir = await mkdtemp(path.join(tmpdir(), 'dsh-fm-unzip-'))
    await writeFile(archivePath, archive)
    execFileSync('unzip', ['-qq', '-o', archivePath, '-d', outDir])
    assert.equal(await readFile(path.join(outDir, 'README.md'), 'utf8'), '# readme\n')
    assert.deepEqual([...(await readFile(path.join(outDir, 'sub/data.bin')))], new Array(200).fill(3))
    assert.equal(await readFile(path.join(outDir, 'empty.txt'), 'utf8'), '')
    await rm(archivePath, { force: true })
    await rm(outDir, { recursive: true, force: true })
  } finally {
    await h.close()
  }
})

test('creates folders, moves entries and deletes trees', async () => {
  const h = await harness()
  try {
    const made = await postJson(h.base, 'mkdir', { path: 'docs' })
    assert.equal(made.status, 200)
    assert.equal((await stat(path.join(h.root, 'docs'))).isDirectory(), true)

    const duplicate = await postJson(h.base, 'mkdir', { path: 'docs' })
    assert.equal(duplicate.status, 409)

    await writeFile(path.join(h.root, 'docs/note.txt'), 'body')
    const moved = await postJson(h.base, 'move', { from: 'docs/note.txt', to: 'docs/renamed.txt' })
    assert.equal(moved.status, 200)
    assert.equal(await readFile(path.join(h.root, 'docs/renamed.txt'), 'utf8'), 'body')

    const clash = await postJson(h.base, 'move', { from: 'docs/renamed.txt', to: 'docs/renamed.txt' })
    assert.equal(clash.status, 409)

    const deleted = await postJson(h.base, 'delete', { paths: ['docs'] })
    assert.equal(deleted.status, 200)
    assert.equal(deleted.body.value.removed, 1)
    await assert.rejects(stat(path.join(h.root, 'docs')))

    const rootDelete = await postJson(h.base, 'delete', { paths: [''] })
    assert.equal(rootDelete.body.value.failures[0].code, 'forbidden')

    const emptyDelete = await postJson(h.base, 'delete', { paths: [] })
    assert.equal(emptyDelete.status, 400)
  } finally {
    await h.close()
  }
})

test('copies files and folders, refuses clashes and self-nesting', async () => {
  const h = await harness()
  try {
    await mkdir(path.join(h.root, 'pkg/sub'), { recursive: true })
    await writeFile(path.join(h.root, 'pkg/sub/a.txt'), 'A')
    await writeFile(path.join(h.root, 'file.txt'), 'one')

    const copied = await postJson(h.base, 'copy', { from: 'file.txt', to: 'file copy.txt' })
    assert.equal(copied.status, 200)
    assert.equal(await readFile(path.join(h.root, 'file copy.txt'), 'utf8'), 'one')

    const clash = await postJson(h.base, 'copy', { from: 'file.txt', to: 'file copy.txt' })
    assert.equal(clash.status, 409)
    assert.equal(clash.body.error.code, 'exists')

    const folderCopy = await postJson(h.base, 'copy', { from: 'pkg', to: 'pkg2' })
    assert.equal(folderCopy.status, 200)
    assert.equal(folderCopy.body.value.type, 'directory')
    assert.equal(await readFile(path.join(h.root, 'pkg2/sub/a.txt'), 'utf8'), 'A')

    const selfCopy = await postJson(h.base, 'copy', { from: 'pkg', to: 'pkg/inner' })
    assert.equal(selfCopy.status, 400)

    await writeFile(path.join(h.root, 'pkg2/keep.txt'), 'kept')
    const merged = await postJson(h.base, 'copy', { from: 'pkg', to: 'pkg2', overwrite: true })
    assert.equal(merged.status, 200)
    assert.equal(await readFile(path.join(h.root, 'pkg2/sub/a.txt'), 'utf8'), 'A')
    assert.equal(await readFile(path.join(h.root, 'pkg2/keep.txt'), 'utf8'), 'kept', 'merge keeps destination-only files')

    const selfMove = await postJson(h.base, 'move', { from: 'pkg', to: 'pkg/sub' })
    assert.equal(selfMove.status, 400)
  } finally {
    await h.close()
  }
})

test('reports the workspace root for a live session', async () => {
  const h = await harness()
  try {
    const info = await getJson(h.base, 'info', {})
    assert.equal(info.status, 200)
    assert.equal(info.body.value.root, h.root)
    const missing = await getJson(h.base, 'list', { sessionId: 'unknown-session' })
    assert.equal(missing.body.ok, true, 'unknown sessions fall back to the sandbox root')
  } finally {
    await h.close()
  }
})
