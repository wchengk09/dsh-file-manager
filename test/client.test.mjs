/**
 * Wiring tests for the browser half: load the bundle through a fake module
 * loader, call apply() with fake client services, and render the contributions
 * through a tiny React stub. This cannot prove the visual result — the live GUI
 * check does that — but it catches registration mistakes, bad keys and render
 * crashes before the plugin is ever installed.
 *
 * Run with: node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

/** Minimal React replacement with working hook slots. */
function reactStub() {
  const hooks = []
  let index = 0
  return {
    createElement(type, props, ...children) {
      const flat = []
      const push = (child) => {
        if (Array.isArray(child)) child.forEach(push)
        else if (child !== null && child !== undefined && child !== false) flat.push(child)
      }
      push(children)
      return { type, props: { ...(props || {}), children: flat }, children: flat }
    },
    useState(initial) {
      const at = index++
      if (!(at in hooks)) hooks[at] = typeof initial === 'function' ? initial() : initial
      const set = (value) => {
        hooks[at] = typeof value === 'function' ? value(hooks[at]) : value
      }
      return [hooks[at], set]
    },
    useRef(initial) {
      const at = index++
      if (!(at in hooks)) hooks[at] = { current: initial }
      return hooks[at]
    },
    useEffect(effect) {
      index += 1
      const cleanup = effect()
      return typeof cleanup === 'function' ? cleanup : undefined
    },
    cloneElement(element, props) {
      return { ...element, props: { ...element.props, ...props } }
    },
    reset() {
      index = 0
    },
    hooks,
  }
}

/** Install the browser globals the bundle touches at import time. */
function installGlobals() {
  const react = reactStub()
  let factory
  const styles = []
  globalThis.window = {
    __ModuleLoader__: {
      load(definition) {
        factory = definition.factory
      },
    },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    confirm: () => true,
    prompt: () => null,
    alert: () => {},
  }
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, style: {}, textContent: '', remove() {} }),
    head: {
      appendChild(node) {
        styles.push(node)
      },
    },
    body: { appendChild() {} },
    visibilityState: 'visible',
  }
  return { react, styles, factory: () => factory }
}

/** Load the bundle once (ESM modules are cached per process). */
let loaded
async function loadClient() {
  if (loaded !== undefined) return loaded
  const { react, styles, factory } = installGlobals()
  await import(pathToFileURL(path.join(import.meta.dirname, '..', 'lib', 'client.js')).href)
  const exports = factory()((name) => {
    if (name === 'react') return react
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { IconFolderOpenRegular: function Folder() {} }
    throw new Error(`unexpected require: ${name}`)
  })
  loaded = { exports, react, styles }
  return loaded
}

/** Fake client context that records every registration. */
function fakeContext() {
  const recorded = { tabs: [], slots: [], opened: null }
  const ctx = {
    effect(fn) {
      return fn()
    },
    sidebarRightTabs: {
      register(definition) {
        recorded.tabs.push(definition)
        return () => {}
      },
    },
    slots: {
      inject(_name, factory) {
        return factory()
      },
      register(options, component) {
        recorded.slots.push({ options, component })
        return () => {}
      },
    },
    sidebarRight: {
      openTab(kind, options) {
        recorded.opened = { kind, options }
      },
    },
  }
  return { ctx, recorded }
}

/** The session standard props the slot framework supplies. */
const STANDARD = {
  sessionId: 'session-1',
  useSessions: (selector) => selector({ byId: { 'session-1': { cwd: '/tmp/workspace' } } }),
  useTabInfo: () => ({
    visible: true,
    navigation: { address: 'sidebar://filemanager', params: undefined, revision: 0 },
    actions: { openResource() {}, openTab() {}, close() {}, bindCommands: () => () => {} },
    tab: { id: 'tab-1' },
  }),
}

test('takes over the shipped files tab instead of adding a new one', async () => {
  const { exports, styles } = await loadClient()
  assert.deepEqual(exports.inject, ['slots', 'sidebarRightTabs', 'sidebarRight'])
  const { ctx, recorded } = fakeContext()
  exports.apply(ctx)

  assert.equal(recorded.tabs.length, 1)
  const definition = recorded.tabs[0]
  assert.equal(definition.id, 'dsh-file-manager')
  assert.equal(definition.kind, 'files', 'answers the kind the shipped Files tab owns')
  assert.equal(definition.priority, 'extension')
  assert.equal(definition.title('x'), '文件')
  assert.equal(definition.guide.length, 1)
  assert.equal(definition.guide[0].id, 'workspace')
  assert.equal(definition.guide[0].commandId, 'workspace.files')
  assert.equal(definition.guide[0].title(), '工作区文件')
  assert.equal(definition.guide[0].description(), '浏览会话工作区的文件')

  const byName = Object.fromEntries(recorded.slots.map((entry) => [entry.options.name, entry]))
  assert.equal(byName['sidebar.right.pane.tab'].options.key, 'dsh-file-manager')
  assert.equal(byName['sidebar.right.tab.document.actions'].options.id, 'dsh-file-manager')
  assert.equal(byName['sidebar.right.tab.files.actions'], undefined, 'no duplicated action row')

  assert.equal(styles.length, 1, 'stylesheet installed once')
  assert.match(styles[0].textContent, /\.dsfm\{/)
})

test('the tab body renders the toolbar and an empty folder note', async () => {
  const { exports, react } = await loadClient()
  const { ctx, recorded } = fakeContext()
  exports.apply(ctx)
  const body = recorded.slots.find((entry) => entry.options.name === 'sidebar.right.pane.tab').component
  react.reset()
  const tree = body(STANDARD)
  assert.equal(tree.props.className, 'dsfm')
  const text = JSON.stringify(tree)
  assert.match(text, /上传/)
  assert.match(text, /新建文件夹/)
  assert.match(text, /打包下载/)
})

test('the tab body loads and renders directory rows from the host route', async () => {
  const { exports, react } = await loadClient()
  const { ctx, recorded } = fakeContext()
  exports.apply(ctx)
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    const payload = {
      ok: true,
      value: {
        root: '/tmp/workspace',
        path: '/tmp/workspace',
        truncated: false,
        entries: [
          { name: 'src', type: 'directory', size: 0, mtimeMs: 1, symlink: false },
          { name: 'readme.md', type: 'file', size: 12, mtimeMs: 2, symlink: false },
        ],
      },
    }
    return { status: 200, text: async () => JSON.stringify(payload) }
  }
  const body = recorded.slots.find((entry) => entry.options.name === 'sidebar.right.pane.tab').component
  react.reset()
  body(STANDARD)
  await new Promise((resolve) => setTimeout(resolve, 5))
  react.reset()
  const tree = body(STANDARD)
  const text = JSON.stringify(tree)
  assert.ok(calls.some((url) => url.includes('/api2/dsh-file-manager/list')), 'listing requested')
  assert.match(text, /readme\.md/)
  assert.match(text, /src/)
  assert.match(text, /12 B/)
  assert.match(text, /workspace/, 'breadcrumb shows the workspace folder')
})

test('the document contribution renders a download button', async () => {
  const { exports, react } = await loadClient()
  const { ctx, recorded } = fakeContext()
  exports.apply(ctx)
  const entry = recorded.slots.find((item) => item.options.name === 'sidebar.right.tab.document.actions')
  react.reset()
  const tree = entry.component({ ...STANDARD, absolutePath: '/tmp/workspace/notes/a.md' })
  assert.ok(tree)
  assert.match(JSON.stringify(tree), /下载/)
})
