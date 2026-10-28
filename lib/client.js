/* dsh-file-manager — browser half.
 *
 * Shell module-table format (window.__ModuleLoader__.load), the same shape the
 * shipped ui-* bundles and the other profile plugins use: the Cordis client
 * kernel adopts the exported `apply`/`inject`.
 *
 * What it adds to the Web GUI:
 *   - a "文件管理" (file manager) tab for the right sidebar: browse the session
 *     workspace, upload files and folders (picker or drag & drop, with progress
 *     and cancel), download a file, download a folder as ZIP, rename, delete and
 *     create folders;
 *   - quick upload / folder-ZIP buttons inside the shipped 文件 tab's action
 *     row, plus a button that opens the manager on the displayed folder;
 *   - a download button in the document preview tab.
 *
 * All transfers go through the host half's /api2/dsh-file-manager routes; the
 * browser never sees the host filesystem beyond the session workspace.
 */
window.__ModuleLoader__.load({
  id: 'dsh-file-manager',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var react = require('react')
    var h = react.createElement
    var primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch (error) {
      primitives = null
    }

    /** The primitives namespace, or an empty object when the package is absent. */
    var prim = primitives !== null ? primitives : {}
    /** Host route namespace (must match lib/index.js). */
    var API = '/api2/dsh-file-manager'
    /** This implementation's identity in the tab system. */
    var TAB_ID = 'dsh-file-manager'
    /** The page kind this implementation takes over: the shipped Files tab. */
    var FILES_KIND = 'files'
    /** Poll interval while the tab is visible, ms. */
    var REFRESH_MS = 5000
    /** Opens a `dsh-resource://` address in the active pane; bound by `apply`. */
    var openResource = null

    // ------------------------------------------------------------------ copy

    var COPY = {
      typeLabel: '文件',
      guideTitle: '工作区文件',
      guideDescription: '浏览会话工作区的文件',
      upload: '上传',
      uploadFolder: '上传文件夹',
      mkdir: '新建文件夹',
      refresh: '刷新',
      zipHere: '打包下载',
      empty: '这个文件夹是空的',
      emptyHint: '拖入文件即可上传',
      loading: '读取中…',
      truncated: '条目过多，仅显示前一部分',
      noWorkspace: '这个会话没有工作目录',
      selected: '已选 {n} 项',
      delete: '删除',
      uploading: '上传中',
      queued: '排队中',
      done: '已完成',
      failed: '失败',
      cancel: '取消',
      clearDone: '清除已完成',
      size: '大小',
      name: '名称',
      actions: '操作',
      open: '打开',
      openPreview: '打开预览',
      copy: '复制',
      cut: '剪切',
      paste: '粘贴',
      pasteHere: '粘贴到此处',
      confirm: '确定',
      cancelLabel: '取消',
      close: '关闭',
      replace: '替换',
      renameTitle: '重命名',
      nameLabel: '名称',
      deleteTitle: '删除',
      conflictTitle: '目标中已有同名项',
      conflictMessage: '“{name}” 已存在，要替换吗？',
      copied: '已复制 {n} 项',
      cutDone: '已剪切 {n} 项',
      pasted: '已粘贴',
      moved: '已移动',
      skipped: '完成，跳过 {n} 项',
      sameFolder: '已经在该文件夹里',
      needSelection: '先选中文件或文件夹',
      nameInvalid: '名称不能包含路径分隔符',
      deleteFailed: '删除失败',
      renameFailed: '重命名失败',
      mkdirFailed: '创建失败',
      uploadFiles: '上传文件',
      back: '后退',
      forward: '前进',
      up: '上一级',
      properties: '属性',
      copyPath: '复制路径',
      copiedPath: '已复制路径',
      cancelled: '已取消',
      transfer: '传输',
      itemCount: '{n} 个项目',
      selectedCount: '已选 {n} 项',
      copying: '正在复制',
      moving: '正在移动',
      nameEmpty: '名称不能为空',
      nameIllegal: '名称不能包含 \\ / : * ? " < > | 等字符',
      nameTrailing: '名称不能以空格或句点结尾',
      nameReserved: '这是 Windows 的保留名称',
      renamePrompt: '重命名',
      deleteConfirm: '删除“{name}”？此操作不可恢复。',
      deleteSelectedConfirm: '删除选中的 {n} 项？此操作不可恢复。',
      overwriteConfirm: '“{name}” 已存在，覆盖吗？',
      mkdirPrompt: '新文件夹名称',
      mkdirTitle: '新建文件夹',
      folderZip: '打包下载此文件夹',
      download: '下载',
      retry: '重试',
    }

    /** Tiny template helper for COPY strings. */
    function copy(key, params) {
      var text = COPY[key] || key
      if (!params) return text
      return text.replace(/\{(\w+)\}/g, function (match, name) {
        return params[name] === undefined ? match : String(params[name])
      })
    }

    // ---------------------------------------------------------------- styles

    var CSS = [
      '.dsfm{display:flex;flex-direction:column;height:100%;min-height:0;font-size:12.5px;color:var(--dsw-alias-label-primary,#e8e8e8)}',
      '.dsfm *{box-sizing:border-box}',
      '.dsfm-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:8px 10px 7px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25))}',
      '.dsfm-btn{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}',
      '.dsfm-btn:hover:not(:disabled){background:var(--dsw-alias-bg-hover,rgba(128,128,128,.14))}',
      '.dsfm-btn:disabled{opacity:.45;cursor:default}',
      '.dsfm-btn.primary{border-color:transparent;background:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff}',
      '.dsfm-btn.primary:hover:not(:disabled){filter:brightness(1.08)}',
      '.dsfm-btn.icon-only{width:26px;padding:0;justify-content:center}',
      '.dsfm-btn.danger:hover:not(:disabled){color:var(--dsw-alias-state-danger-primary,#e5484d)}',
      '.dsfm-btn svg{flex:none}',
      '.dsfm-crumbs{display:flex;flex-wrap:wrap;align-items:center;gap:1px;padding:5px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18));color:var(--dsw-alias-label-secondary,#a8a8a8);font-size:12px}',
      '.dsfm-crumb{background:none;border:0;padding:1px 4px;border-radius:5px;color:inherit;font:inherit;cursor:pointer;max-width:16em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsfm-crumb:hover{background:var(--dsw-alias-bg-hover,rgba(128,128,128,.14));color:var(--dsw-alias-label-primary,#e8e8e8)}',
      '.dsfm-crumb.last{color:var(--dsw-alias-label-primary,#e8e8e8);font-weight:500}',
      '.dsfm-sep{opacity:.5}',
      '.dsfm-list{flex:1;min-height:0;overflow:auto;padding:4px 6px 48px;position:relative}',
      '.dsfm-list.dragging{outline:2px dashed var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:-4px;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 7%,transparent)}',
      '.dsfm-head{display:grid;grid-template-columns:16px minmax(0,1fr) 64px 78px;gap:6px;align-items:center;padding:3px 6px;color:var(--dsw-alias-label-tertiary,#8a8a8a);font-size:11px;position:sticky;top:0;background:var(--dsw-alias-bg-primary,var(--dsw-alias-bg-base,#1b1b1b));z-index:1}',
      '.dsfm-list,.dsfm-row{-webkit-user-select:none;user-select:none}',
      '.dsfm-row{display:grid;grid-template-columns:16px minmax(0,1fr) 64px 78px;gap:6px;align-items:center;padding:2px 6px;border-radius:6px;min-height:26px}',
      '.dsfm-row:hover{background:var(--dsw-alias-bg-hover,rgba(128,128,128,.12))}',
      '.dsfm-row.checked{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 14%,transparent)}',
      '.dsfm-row.cut{opacity:.5}',
      '.dsfm-row.drop-target{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 22%,transparent);outline:1px dashed var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:-2px}',
      '.dsfm-danger{background:var(--dsw-alias-state-danger-primary,#e5484d)!important;border-color:transparent!important;color:#fff!important}',
      '.dsfm-modal input{width:100%}',
      '.dsfm-ico{display:inline-flex;align-items:center;justify-content:center;line-height:0;color:var(--dsw-alias-brand-primary,#4d6bfe)}',
      '.dsfm-row .dsfm-ico{color:inherit}',
      '.dsfm-glyph{display:block}',
      '.dsfm-name{display:flex;align-items:center;gap:0;min-width:0;background:none;border:0;padding:0;color:inherit;font:inherit;text-align:left;cursor:pointer}',
      '.dsfm-name span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-radius:4px;padding:1px 2px}',
      '.dsfm-name:hover span{text-decoration:underline}',
      '.dsfm-name.dir{color:var(--dsw-alias-label-primary,#e8e8e8)}',
      '.dsfm-rename{width:100%;min-width:0;height:22px;padding:0 4px;border-radius:5px;border:1px solid var(--dsw-alias-brand-primary,#4d6bfe);background:var(--dsw-alias-bg-input,rgba(0,0,0,.28));color:inherit;font:inherit;font-size:12.5px;outline:none}',
      '.dsfm-name.symlink span::after{content:" ↪";opacity:.5;font-size:10px}',
      '.dsfm-size,.dsfm-time{color:var(--dsw-alias-label-tertiary,#8a8a8a);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsfm-actions{display:flex;align-items:center;justify-content:flex-end;gap:2px;opacity:.35;transition:opacity .12s}',
      '.dsfm-row:hover .dsfm-actions,.dsfm-row:focus-within .dsfm-actions{opacity:1}',
      '.dsfm-act{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary,#a8a8a8);cursor:pointer;padding:0}',
      '.dsfm-act:hover{background:var(--dsw-alias-bg-hover,rgba(128,128,128,.2));color:var(--dsw-alias-label-primary,#e8e8e8)}',
      '.dsfm-act.danger:hover{color:var(--dsw-alias-state-danger-primary,#e5484d)}',
      '.dsfm-note{padding:14px 12px;text-align:center;color:var(--dsw-alias-label-tertiary,#8a8a8a);line-height:1.6}',
      '.dsfm-error{margin:6px;padding:8px 10px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-danger-primary,#e5484d) 12%,transparent);color:var(--dsw-alias-state-danger-primary,#e5484d);line-height:1.5;word-break:break-word}',
      '.dsfm-hint{margin-top:2px;font-size:11px;opacity:.8}',
      '.dsfm-marquee{position:absolute;pointer-events:none;z-index:2;border:1px solid var(--dsw-alias-brand-primary,#4d6bfe);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 14%,transparent);border-radius:2px}',
      '.dsfm-status{display:flex;align-items:center;gap:10px;padding:3px 10px;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18));color:var(--dsw-alias-label-tertiary,#8a8a8a);font-size:11px;font-variant-numeric:tabular-nums}',
      '.dsfm-status-selected{color:var(--dsw-alias-brand-primary,#4d6bfe)}',
      '.dsfm-uploads{border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));max-height:34%;overflow:auto;padding:6px 10px;font-size:11.5px}',
      '.dsfm-uploads-head{display:flex;align-items:center;justify-content:space-between;color:var(--dsw-alias-label-tertiary,#8a8a8a);margin-bottom:3px}',
      '.dsfm-up{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 8px;padding:3px 0;align-items:center}',
      '.dsfm-up-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsfm-up-status{color:var(--dsw-alias-label-tertiary,#8a8a8a);white-space:nowrap}',
      '.dsfm-up-status.err{color:var(--dsw-alias-state-danger-primary,#e5484d)}',
      '.dsfm-bar{grid-column:1 / -1;height:3px;border-radius:2px;background:rgba(128,128,128,.22);overflow:hidden}',
      '.dsfm-bar>i{display:block;height:100%;background:var(--dsw-alias-brand-primary,#4d6bfe);transition:width .12s}',
      '.dsfm-bar.err>i{background:var(--dsw-alias-state-danger-primary,#e5484d)}',
      '.dsfm-inline{display:inline-flex;align-items:center;gap:4px}',
      '.dsfm-inline-status{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a8a);max-width:9em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsfm-inline-status.err{color:var(--dsw-alias-state-danger-primary,#e5484d)}',
    ].join('')

    /** Install the stylesheet once per page. */
    function installStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin="dsh-file-manager"]') !== null) return
      var tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-file-manager'
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ----------------------------------------------------------------- icons

    /**
     * Build one stroke icon.
     * @param {Array} children path/polyline elements.
     * @param {number} [size] pixel size.
     */
    function icon(children, size) {
      return h('svg', {
        width: size || 15,
        height: size || 15,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      }, children)
    }

    var ICONS = {
      folder: function (size) {
        return icon([h('path', { key: 'p', d: 'M1.8 4.2c0-.7.6-1.2 1.2-1.2h3l1.3 1.5h5.7c.7 0 1.2.5 1.2 1.2v6.1c0 .7-.5 1.2-1.2 1.2H3c-.6 0-1.2-.5-1.2-1.2z' })], size)
      },
      file: function (size) {
        return icon([
          h('path', { key: 'p', d: 'M3.4 1.9h5l4.2 4.2v8H3.4z' }),
          h('path', { key: 'q', d: 'M8.4 1.9v4.2h4.2' }),
        ], size)
      },
      upload: function (size) {
        return icon([
          h('path', { key: 'p', d: 'M8 10.6V2.4' }),
          h('path', { key: 'q', d: 'M4.9 5.4 8 2.3l3.1 3.1' }),
          h('path', { key: 'r', d: 'M2.6 10.9v1.6c0 .7.5 1.2 1.2 1.2h8.4c.7 0 1.2-.5 1.2-1.2v-1.6' }),
        ], size)
      },
      folderPlus: function (size) {
        return icon([
          h('path', { key: 'p', d: 'M1.8 4.2c0-.7.6-1.2 1.2-1.2h3l1.3 1.5h5.7c.7 0 1.2.5 1.2 1.2v6.1c0 .7-.5 1.2-1.2 1.2H3c-.6 0-1.2-.5-1.2-1.2z' }),
          h('path', { key: 'q', d: 'M8 6.9v3.4M6.3 8.6h3.4' }),
        ], size)
      },
      refresh: function (size) {
        return icon([
          h('path', { key: 'p', d: 'M13 8a5 5 0 1 1-1.6-3.7' }),
          h('path', { key: 'q', d: 'M13.2 2.4v2.8h-2.8' }),
        ], size)
      },
      download: function (size) {
        return icon([
          h('path', { key: 'p', d: 'M8 2.4v8.2' }),
          h('path', { key: 'q', d: 'M4.9 7.5 8 10.6l3.1-3.1' }),
          h('path', { key: 'r', d: 'M2.6 10.9v1.6c0 .7.5 1.2 1.2 1.2h8.4c.7 0 1.2-.5 1.2-1.2v-1.6' }),
        ], size)
      },
      archive: function (size) {
        return icon([
          h('path', { key: 'p', d: 'M2.2 4.1h11.6v2.2H2.2z' }),
          h('path', { key: 'q', d: 'M3.2 6.3h9.6v7.4H3.2z' }),
          h('path', { key: 'r', d: 'M6.6 8.6h2.8' }),
        ], size)
      },
      trash: function (size) {
        return icon([
          h('path', { key: 'p', d: 'M2.8 4.2h10.4' }),
          h('path', { key: 'q', d: 'M4.2 4.2v9.4h7.6V4.2' }),
          h('path', { key: 'r', d: 'M6.2 4.2V2.4h3.6v1.8' }),
        ], size)
      },
      edit: function (size) {
        return icon([
          h('path', { key: 'p', d: 'M9.6 2.8l3.6 3.6-7.4 7.4H2.2v-3.6z' }),
          h('path', { key: 'q', d: 'M8.2 4.2l3.6 3.6' }),
        ], size)
      },
      close: function (size) {
        return icon([h('path', { key: 'p', d: 'M4 4l8 8M12 4l-8 8' })], size)
      },
      folderOpen: function (size) {
        return icon([
          h('path', { key: 'p', d: 'M1.8 4.4c0-.6.5-1.1 1.1-1.1h3l1.2 1.4h5.8c.6 0 1.1.5 1.1 1.1v1.1' }),
          h('path', { key: 'q', d: 'M1.8 6.9h12.4l-1.4 6H3.2z' }),
        ], size)
      },
      copy: function (size) {
        return icon([
          h('path', { key: 'p', d: 'M5.6 5.6h7.2c.5 0 .9.4.9.9v7.2c0 .5-.4.9-.9.9H5.6a.9.9 0 0 1-.9-.9V6.5c0-.5.4-.9.9-.9z' }),
          h('path', { key: 'q', d: 'M10.8 5.6V3.2c0-.5-.4-.9-.9-.9H3.2c-.5 0-.9.4-.9.9v6.7c0 .5.4.9.9.9h1.5' }),
        ], size)
      },
      cut: function (size) {
        return icon([
          h('circle', { key: 'a', cx: '4.4', cy: '11.7', r: '1.7' }),
          h('circle', { key: 'b', cx: '11.6', cy: '11.7', r: '1.7' }),
          h('path', { key: 'c', d: 'M5.6 10.4 12.1 2.5M10.4 10.4 3.9 2.5' }),
        ], size)
      },
      chevronLeft: function (size) {
        return icon([h('path', { key: 'p', d: 'M10 3.2 5.2 8 10 12.8' })], size)
      },
      chevronRight: function (size) {
        return icon([h('path', { key: 'p', d: 'M6 3.2 10.8 8 6 12.8' })], size)
      },
      up: function (size) {
        return icon([
          h('path', { key: 'p', d: 'M8 13V3.4' }),
          h('path', { key: 'q', d: 'M3.9 7.2 8 3.1l4.1 4.1' }),
        ], size)
      },
      paste: function (size) {
        return icon([
          h('path', { key: 'p', d: 'M6 3.2h4v1.6H6z' }),
          h('path', { key: 'q', d: 'M4.2 4.1H3.4c-.6 0-1.1.5-1.1 1.1v7.7c0 .6.5 1.1 1.1 1.1h9.2c.6 0 1.1-.5 1.1-1.1V5.2c0-.6-.5-1.1-1.1-1.1h-.8' }),
        ], size)
      },
    }

    // ------------------------------------------------------------ path utils

    /** Normalize separators for browser-side comparison and URL building. */
    function slashes(value) {
      return String(value == null ? '' : value).replace(/\\/g, '/')
    }

    /** Join a directory and a child name with `/`. */
    function joinPath(dir, name) {
      return slashes(dir).replace(/\/+$/, '') + '/' + name
    }

    /** Whether `target` is `root` or sits below it (browser-side copy). */
    function insideRoot(root, target) {
      var base = slashes(root).replace(/\/+$/, '')
      var value = slashes(target).replace(/\/+$/, '')
      return value === base || value.indexOf(base + '/') === 0
    }

    /** Workspace-relative form of an absolute path. */
    function relativeOf(root, abs) {
      var base = slashes(root).replace(/\/+$/, '')
      var path = slashes(abs)
      if (path === base) return ''
      if (path.indexOf(base + '/') === 0) return path.slice(base.length + 1)
      return path
    }

    /** Final segment of a path. */
    function baseName(value) {
      var path = slashes(value).replace(/\/+$/, '')
      var at = path.lastIndexOf('/')
      return at === -1 ? path : path.slice(at + 1)
    }

    /** Parent directory of a path, or '' at the filesystem root. */
    function dirName(value) {
      var path = slashes(value).replace(/\/+$/, '')
      var at = path.lastIndexOf('/')
      if (at <= 0) return path.slice(0, Math.max(at, 0))
      return path.slice(0, at)
    }

    /** `dsh-resource://file/session/<id>/<path>` for the shipped preview tab. */
    function fileAddress(sessionId, root, abs) {
      var relative = relativeOf(root, abs)
      var encoded = relative.split('/').map(encodeURIComponent).join('/')
      return 'dsh-resource://file/session/' + encodeURIComponent(sessionId) + '/' + encoded
    }

    /** Human byte size. */
    function sizeText(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return ''
      if (bytes < 1024) return bytes + ' B'
      var units = ['KB', 'MB', 'GB', 'TB']
      var value = bytes / 1024
      var unit = 0
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit += 1
      }
      return (value >= 10 ? value.toFixed(0) : value.toFixed(1)) + ' ' + units[unit]
    }

    /** Short absolute date-time for a tooltip. */
    function timeText(milliseconds) {
      if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds)) return ''
      var date = new Date(milliseconds)
      var pad = function (value) { return String(value).padStart(2, '0') }
      return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
        + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
    }

    /** Query string from a plain object. */
    function query(params) {
      var search = new URLSearchParams()
      Object.keys(params).forEach(function (key) {
        var value = params[key]
        if (value === undefined || value === null) return
        search.set(key, String(value))
      })
      return search.toString()
    }

    // -------------------------------------------------------------- host API

    /** Error carrying the host's stable failure code. */
    function apiError(code, message, details) {
      var error = new Error(message)
      error.code = code
      error.details = details
      return error
    }

    /**
     * Call one JSON route of the host half.
     * @param {string} op route name.
     * @param {object} [params] query parameters.
     * @param {object} [body] JSON body; omit for GET.
     * @returns {Promise<any>} the `value` of the success envelope.
     */
    function api(op, params, body) {
      var init = {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        headers: { 'x-dsh-fm': '1' },
      }
      if (body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(body)
      }
      return fetch(API + '/' + op + '?' + query(params || {}), init).then(function (response) {
        return response.text().then(function (text) {
          var payload = null
          try {
            payload = JSON.parse(text)
          } catch (error) {
            payload = null
          }
          if (payload && payload.ok === true) return payload.value
          var failure = payload && payload.error ? payload.error : null
          throw apiError(
            failure ? failure.code : 'http-' + response.status,
            failure ? failure.message : 'HTTP ' + response.status,
            failure ? failure.details : undefined,
          )
        })
      })
    }

    /** Absolute URL of a transfer route (used by anchors / XHR). */
    function transferUrl(op, params) {
      return API + '/' + op + '?' + query(params)
    }

    /**
     * Stream one browser File into a workspace directory.
     * @param {object} options upload parameters.
     * @returns {{ promise: Promise<any>, abort: () => void }} the transfer handle.
     */
    function uploadOne(options) {
      var xhr = new XMLHttpRequest()
      var promise = new Promise(function (resolve, reject) {
        xhr.open('POST', transferUrl('upload', {
          sessionId: options.sessionId,
          path: options.directory,
          name: options.name,
          overwrite: options.overwrite ? '1' : '0',
        }))
        xhr.setRequestHeader('content-type', 'application/octet-stream')
        xhr.setRequestHeader('x-dsh-fm', '1')
        if (xhr.upload) {
          xhr.upload.onprogress = function (event) {
            if (event.lengthComputable && options.onProgress) options.onProgress(event.loaded, event.total)
          }
        }
        xhr.onload = function () {
          var payload = null
          try {
            payload = JSON.parse(xhr.responseText)
          } catch (error) {
            payload = null
          }
          if (xhr.status >= 200 && xhr.status < 300 && payload && payload.ok === true) {
            resolve(payload.value)
            return
          }
          var failure = payload && payload.error ? payload.error : null
          reject(apiError(
            failure ? failure.code : 'http-' + xhr.status,
            failure ? failure.message : 'HTTP ' + xhr.status,
            failure ? failure.details : undefined,
          ))
        }
        xhr.onerror = function () { reject(apiError('network', '网络中断，上传失败')) }
        xhr.onabort = function () { reject(apiError('aborted', '已取消')) }
        xhr.send(options.file)
      })
      return {
        promise: promise,
        abort: function () { xhr.abort() },
      }
    }


    /** CRC-32, the checksum every ZIP entry carries. */
    var crcTable = null
    function crc32(bytes) {
      if (crcTable === null) {
        crcTable = new Uint32Array(256)
        for (var n = 0; n < 256; n += 1) {
          var c = n
          for (var k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
          crcTable[n] = c >>> 0
        }
      }
      var crc = 0xffffffff
      for (var index = 0; index < bytes.length; index += 1) {
        crc = crcTable[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)
      }
      return (crc ^ 0xffffffff) >>> 0
    }

    /** MS-DOS packed time/date for one timestamp (ZIP fields 10/12 and 12/14). */
    function dosDateTime(milliseconds) {
      var date = new Date(typeof milliseconds === 'number' && Number.isFinite(milliseconds) ? milliseconds : Date.now())
      var year = Math.min(2107, Math.max(1980, date.getFullYear()))
      return {
        time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
        date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
      }
    }

    /**
     * Build a stored (uncompressed) ZIP from `{name, data, mtimeMs}` entries.
     * Used for "download the selection": one file drops, many become one archive.
     */
    function zipBlob(entries) {
      var encoder = new TextEncoder()
      var parts = []
      var central = []
      var offset = 0
      entries.forEach(function (entry) {
        var nameBytes = encoder.encode(entry.name)
        var data = entry.data
        var stamp = dosDateTime(entry.mtimeMs)
        var crc = crc32(data)
        var local = new Uint8Array(30 + nameBytes.length)
        var view = new DataView(local.buffer)
        view.setUint32(0, 0x04034b50, true)
        view.setUint16(4, 20, true)
        view.setUint16(6, 0x0800, true)
        view.setUint16(8, 0, true)
        view.setUint16(10, stamp.time, true)
        view.setUint16(12, stamp.date, true)
        view.setUint32(14, crc, true)
        view.setUint32(18, data.length, true)
        view.setUint32(22, data.length, true)
        view.setUint16(26, nameBytes.length, true)
        view.setUint16(28, 0, true)
        local.set(nameBytes, 30)
        parts.push(local, data)
        var record = new Uint8Array(46 + nameBytes.length)
        var rview = new DataView(record.buffer)
        rview.setUint32(0, 0x02014b50, true)
        rview.setUint16(4, 20, true)
        rview.setUint16(6, 20, true)
        rview.setUint16(8, 0x0800, true)
        rview.setUint16(10, 0, true)
        rview.setUint16(12, stamp.time, true)
        rview.setUint16(14, stamp.date, true)
        rview.setUint32(16, crc, true)
        rview.setUint32(20, data.length, true)
        rview.setUint32(24, data.length, true)
        rview.setUint16(28, nameBytes.length, true)
        rview.setUint16(30, 0, true)
        rview.setUint16(32, 0, true)
        rview.setUint16(34, 0, true)
        rview.setUint16(36, 0, true)
        rview.setUint32(38, 0, true)
        rview.setUint32(42, offset, true)
        record.set(nameBytes, 46)
        central.push(record)
        offset += local.length + data.length
      })
      var centralSize = central.reduce(function (total, record) { return total + record.length }, 0)
      var end = new Uint8Array(22)
      var eview = new DataView(end.buffer)
      eview.setUint32(0, 0x06054b50, true)
      eview.setUint16(8, entries.length, true)
      eview.setUint16(10, entries.length, true)
      eview.setUint32(12, centralSize, true)
      eview.setUint32(16, offset, true)
      return new Blob(parts.concat(central, [end]), { type: 'application/zip' })
    }

    /** `20261028-143512`, the stamp Windows-style archive names carry. */
    function timeStamp() {
      var date = new Date()
      var pad = function (value) { return String(value).padStart(2, '0') }
      return String(date.getFullYear()) + pad(date.getMonth() + 1) + pad(date.getDate())
        + '-' + pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds())
    }

    /** Hand one generated file to the browser's download machinery. */
    function triggerBlobDownload(blob, filename) {
      var url = URL.createObjectURL(blob)
      var anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      anchor.style.display = 'none'
      document.body.appendChild(anchor)
      anchor.click()
      window.setTimeout(function () {
        anchor.remove()
        URL.revokeObjectURL(url)
      }, 10000)
    }

    /** Start a browser download for a transfer URL through a hidden anchor. */
    function triggerDownload(url) {
      var anchor = document.createElement('a')
      anchor.href = url
      anchor.rel = 'noopener'
      anchor.style.display = 'none'
      document.body.appendChild(anchor)
      anchor.click()
      window.setTimeout(function () { anchor.remove() }, 1000)
    }

    // ------------------------------------------------------------- components

    /** One compact icon button. */
    function IconButton(props) {
      return h('button', {
        type: 'button',
        className: 'dsfm-act' + (props.danger ? ' danger' : ''),
        title: props.title,
        'aria-label': props.title,
        disabled: props.disabled === true,
        onClick: props.onClick,
      }, (ICONS[props.icon] || ICONS.file)(14))
    }

    /** A labelled toolbar button. */
    function ToolButton(props) {
      return h('button', {
        type: 'button',
        className: 'dsfm-btn' + (props.primary ? ' primary' : '') + (props.iconOnly ? ' icon-only' : ''),
        title: props.title || props.label,
        disabled: props.disabled === true,
        onClick: props.onClick,
      }, props.icon ? (ICONS[props.icon] || ICONS.file)(14) : null, props.iconOnly ? null : h('span', null, props.label))
    }

    /** A menu-sized glyph for one icon name. */
    function menuIcon(name) {
      return (ICONS[name] || ICONS.file)(16)
    }

    /**
     * One modal dialog, driven by the panel's `dialog` state.
     *
     * The state object carries a promise resolver, so callers await a plain
     * value: the typed text, `true` for a confirmed action, or `null` for a
     * cancel. Keyed per dialog so the input starts from its own initial value.
     */
    function DialogHost(props) {
      var state = props.state
      var valueState = react.useState(state !== null && typeof state.value === 'string' ? state.value : '')
      var value = valueState[0]
      var setValue = valueState[1]
      if (state === null || prim.Modal === undefined) return null
      var isInput = state.kind === 'input'
      var finish = function (result) {
        props.onClose()
        state.resolve(result === undefined ? null : result)
      }
      var footer = []
      if (state.kind !== 'info') {
        footer.push(h(prim.Button, {
          key: 'cancel',
          variant: 'ghost',
          size: 'sm',
          onClick: function () { finish(null) },
        }, state.cancelLabel || copy('cancelLabel')))
      }
      footer.push(h(prim.Button, {
        key: 'ok',
        variant: 'primary',
        size: 'sm',
        className: state.danger === true ? 'dsfm-danger' : undefined,
        disabled: isInput && String(value).trim() === '',
        onClick: function () { finish(isInput ? String(value).trim() : true) },
      }, state.kind === 'info' ? copy('confirm') : state.confirmLabel || copy('confirm')))
      return h(prim.Modal, {
        open: true,
        onClose: function () { finish(null) },
        title: state.title,
        closeLabel: copy('close'),
        description: state.kind === 'info' ? undefined : state.message,
        footer: footer,
        className: 'dsfm-modal',
      }, state.kind === 'info'
        ? h('div', { style: { whiteSpace: 'pre-line', lineHeight: 1.7 } }, state.message)
        : isInput
        ? h(prim.Input, {
          'data-modal-autofocus': true,
          value: value,
          spellCheck: false,
          'aria-label': state.title,
          onChange: function (event) { setValue(event.target.value) },
          onKeyDown: function (event) {
            if (event.key === 'Enter' && String(value).trim() !== '') finish(String(value).trim())
          },
        })
        : null)
    }

    /** One right-click menu, placed at the pointer through the primitives' Menu. */
    function ContextMenuHost(props) {
      var state = props.state
      if (state === null || prim.Menu === undefined) return null
      var rect = new DOMRect(state.x, state.y, 0, 0)
      return h(prim.Menu, {
        open: true,
        anchor: h('span', { key: 'anchor', style: { display: 'none' } }),
        items: state.items,
        compact: true,
        portal: true,
        getAnchorRect: function () { return rect },
        onSelect: function (id) { props.onSelect(id) },
        onClose: function () { props.onClose() },
      })
    }

    /** The transient banner used for results the user does not have to answer. */
    function ToastHost(props) {
      if (props.state === null || prim.Toast === undefined) return null
      return h(prim.Toast, {
        key: props.state.seq,
        text: props.state.text,
        tone: props.state.tone,
        onDone: props.onDone,
      })
    }

    /** Download button for the document preview tab. */
    function DocumentActions(props) {
      var cwd = props.useSessions(function (state) {
        var entry = state.byId[props.sessionId]
        return entry && entry.cwd ? entry.cwd : ''
      })
      var toastState = react.useState(null)
      var toast = toastState[0]
      var setToast = toastState[1]
      return h('span', { className: 'dsfm-inline' }, [
        h(ToolButton, {
          key: 'download',
          icon: 'download',
          label: copy('download'),
          title: copy('download'),
          onClick: function () {
            if (cwd && !insideRoot(cwd, props.absolutePath)) {
              setToast({ seq: Date.now(), text: '该文件不在会话工作区内，无法下载' })
              return
            }
            triggerDownload(transferUrl('download', { sessionId: props.sessionId, path: props.absolutePath }))
          },
        }),
        toast === null ? null : h(ToastHost, {
          key: 'doc-toast',
          state: toast,
          onDone: function () { setToast(null) },
        }),
      ])
    }

    /** Walk a dropped directory entry tree into `{file, rel}` pairs. */
    function walkEntry(entry, prefix, out) {
      return new Promise(function (resolve) {
        if (entry.isFile) {
          entry.file(function (file) {
            out.push({ file: file, rel: prefix + file.name })
            resolve()
          }, function () { resolve() })
          return
        }
        if (entry.isDirectory) {
          var reader = entry.createReader()
          var all = []
          var next = function () {
            reader.readEntries(function (batch) {
              if (batch.length === 0) {
                Promise.all(all.map(function (child) {
                  return walkEntry(child, prefix + entry.name + '/', out)
                })).then(function () { resolve() }, function () { resolve() })
                return
              }
              all = all.concat(Array.prototype.slice.call(batch))
              next()
            }, function () { resolve() })
          }
          next()
          return
        }
        resolve()
      })
    }

    /** Turn a drop event into `{file, rel}` pairs. */
    function droppedFiles(event) {
      var transfer = event.dataTransfer
      var out = []
      var items = transfer && transfer.items
      if (items && items.length > 0 && typeof items[0].webkitGetAsEntry === 'function') {
        var tasks = []
        for (var index = 0; index < items.length; index += 1) {
          var entry = items[index].webkitGetAsEntry()
          if (entry) tasks.push(walkEntry(entry, '', out))
        }
        return Promise.all(tasks).then(function () { return out })
      }
      var files = transfer ? transfer.files : null
      if (files) {
        for (var at = 0; at < files.length; at += 1) out.push({ file: files[at], rel: files[at].name })
      }
      return Promise.resolve(out)
    }

    /** The shipped primitives' glyph for one entry, with a local fallback. */
    function entryGlyph(entry) {
      if (entry.type === 'directory') {
        if (primitives !== null && primitives.IconFolderOpenRegular !== undefined) {
          return h(primitives.IconFolderOpenRegular, { key: 'glyph', className: 'dsfm-glyph' })
        }
        return ICONS.folder(15)
      }
      if (entry.type === 'file' && primitives !== null
        && primitives.FileTypeIcon !== undefined && primitives.classifyFileType !== undefined) {
        return h(primitives.FileTypeIcon, {
          key: 'glyph',
          kind: primitives.classifyFileType(entry.name),
          size: 16,
          className: 'dsfm-glyph',
        })
      }
      return ICONS.file(15)
    }

    /**
     * The file manager tab body.
     * @param {object} props slot props: `sessionId`, `useSessions`, `useTabInfo`.
     */
    function FileManagerBody(props) {
      var sessionId = props.sessionId
      var useSessions = props.useSessions
      var useTabInfo = props.useTabInfo
      var tab = useTabInfo()
      var navigation = tab.navigation !== undefined ? tab.navigation : {}
      var cwd = useSessions(function (state) {
        var entry = state.byId[sessionId]
        return entry && entry.cwd ? entry.cwd : ''
      })

      var dirState = react.useState('')
      var dir = dirState[0]
      var setDir = dirState[1]
      var listingState = react.useState({ status: 'idle', entries: [], truncated: false, error: null })
      var listing = listingState[0]
      var setListing = listingState[1]
      var uploadsState = react.useState([])
      var uploads = uploadsState[0]
      var setUploads = uploadsState[1]
      var selectedState = react.useState({})
      var selected = selectedState[0]
      var setSelected = selectedState[1]
      var draggingState = react.useState(false)
      var dragging = draggingState[0]
      var setDragging = draggingState[1]
      var dialogState = react.useState(null)
      var dialog = dialogState[0]
      var setDialog = dialogState[1]
      var toastState = react.useState(null)
      var toast = toastState[0]
      var setToast = toastState[1]
      var clipboardState = react.useState(null)
      var clipboard = clipboardState[0]
      var setClipboard = clipboardState[1]
      var menuState = react.useState(null)
      var menu = menuState[0]
      var setMenu = menuState[1]
      var dragTargetState = react.useState('')
      var dragTarget = dragTargetState[0]
      var setDragTarget = dragTargetState[1]
      var renamingState = react.useState(null)
      var renaming = renamingState[0]
      var setRenaming = renamingState[1]
      var marqueeState = react.useState(null)
      var marquee = marqueeState[0]
      var setMarquee = marqueeState[1]
      var transfersState = react.useState([])
      var transfers = transfersState[0]
      var setTransfers = transfersState[1]

      var dirRef = react.useRef('')
      var cwdRef = react.useRef('')
      var seqRef = react.useRef(0)
      var counterRef = react.useRef(0)
      var uploadInput = react.useRef(null)
      var folderInput = react.useRef(null)
      var chainRef = react.useRef(Promise.resolve())
      var handlesRef = react.useRef({})
      var dialogSeq = react.useRef(0)
      var toastSeq = react.useRef(0)
      var dragNames = react.useRef(null)
      var anchorRef = react.useRef(null)
      var historyRef = react.useRef({ entries: [], index: -1 })
      var renamingRef = react.useRef(null)
      var renameInput = react.useRef(null)
      var transferCancelRef = react.useRef(null)
      var listRef = react.useRef(null)
      var marqueeStart = react.useRef(null)
      var suppressClick = react.useRef(false)
      var selectedRef = react.useRef({})
      cwdRef.current = cwd

      /** Explorer-style location history: every jump pushes, back/forward replay. */
      var goTo = function (target, mode) {
        var history = historyRef.current
        if (mode === 'back' || mode === 'forward') {
          var next = history.index + (mode === 'back' ? -1 : 1)
          if (next < 0 || next >= history.entries.length) return
          history.index = next
          target = history.entries[next]
        } else if (history.entries[history.index] !== target) {
          history.entries = history.entries.slice(0, history.index + 1)
          history.entries.push(target)
          history.index = history.entries.length - 1
        }
        dirRef.current = target
        setDir(target)
        setSelected({})
        loadDirectory(target, false)
      }

      var navigate = function (target, silent) {
        if (silent === true) {
          dirRef.current = target
          setDir(target)
          setSelected({})
          loadDirectory(target, true)
          return
        }
        goTo(target)
      }

      var atWorkspaceRoot = function () {
        return slashes(dirRef.current).replace(/\/+$/, '') === slashes(cwdRef.current).replace(/\/+$/, '')
      }

      var goUp = function () {
        if (atWorkspaceRoot()) return
        var parent = dirName(dirRef.current)
        if (parent === dirRef.current) return
        if (!insideRoot(cwdRef.current, parent)) return
        navigate(parent)
      }

      var loadDirectory = function (target, silent) {
        if (!target) return
        var seq = seqRef.current + 1
        seqRef.current = seq
        if (silent !== true) {
          setListing(function (previous) {
            return {
              status: previous.entries.length > 0 ? 'refreshing' : 'loading',
              entries: previous.entries,
              truncated: previous.truncated,
              error: null,
            }
          })
        }
        api('list', { sessionId: sessionId, path: target }).then(function (value) {
          if (seq !== seqRef.current) return
          setListing({ status: 'ready', entries: value.entries, truncated: value.truncated, error: null })
        }, function (error) {
          if (seq !== seqRef.current) return
          setListing(function (previous) {
            return { status: 'failed', entries: previous.entries, truncated: previous.truncated, error: error }
          })
        })
      }

      // Seed from the session workspace and follow a session switch.
      react.useEffect(function () {
        dirRef.current = ''
        historyRef.current = { entries: [], index: -1 }
        setListing({ status: 'idle', entries: [], truncated: false, error: null })
        setSelected({})
        if (cwd) navigate(cwd)
      }, [cwd])

      // A navigation parameter (`{ dir }`) from the files tab's opener re-targets
      // the manager; `revision` moves on every navigation, including repeats.
      react.useEffect(function () {
        var params = navigation.params
        var requested = params && typeof params.dir === 'string' ? params.dir : ''
        if (!cwd || requested === '') return
        if (!insideRoot(cwd, requested)) return
        navigate(requested)
      }, [navigation.revision, cwd])

      // Background refresh while the tab is on screen.
      react.useEffect(function () {
        if (!dir || !tab.visible) return
        var timer = window.setInterval(function () {
          if (document.visibilityState !== 'visible') return
          loadDirectory(dirRef.current, true)
        }, REFRESH_MS)
        return function () { window.clearInterval(timer) }
      }, [dir, tab.visible, sessionId])

      var updateUpload = function (key, patch) {
        setUploads(function (list) {
          return list.map(function (item) {
            if (item.key !== key) return item
            var next = Object.assign({}, item, patch)
            return next
          })
        })
      }

      var runUpload = function (item, directory) {
        var attempt = function (overwrite, isRetry) {
          var handle = uploadOne({
            sessionId: sessionId,
            directory: directory,
            name: item.name,
            file: item.file,
            overwrite: overwrite,
            onProgress: function (loaded, total) {
              updateUpload(item.key, { status: 'uploading', loaded: loaded, size: total })
            },
          })
          handlesRef.current[item.key] = handle
          return handle.promise.then(function (value) {
            delete handlesRef.current[item.key]
            updateUpload(item.key, { status: 'done', loaded: value.size, size: value.size })
            loadDirectory(dirRef.current, true)
          }, function (error) {
            delete handlesRef.current[item.key]
            if (error.code === 'exists' && !isRetry) {
              return askConfirm(copy('conflictTitle'), copy('conflictMessage', { name: item.name }), copy('replace'))
                .then(function (replace) {
                  if (replace === true) return attempt(true, true)
                  updateUpload(item.key, { status: 'error', message: copy('failed') + '：已存在' })
                })
            }
            if (error.code === 'aborted') {
              updateUpload(item.key, { status: 'error', message: copy('cancel') })
              return
            }
            updateUpload(item.key, { status: 'error', message: (error && error.message) || copy('failed') })
          })
        }
        return attempt(false, false)
      }

      var enqueue = function (pairs, directory) {
        if (!pairs || pairs.length === 0) return
        var target = directory || dirRef.current
        if (!target) return
        pairs.forEach(function (pair) {
          counterRef.current += 1
          var item = {
            key: 'up-' + counterRef.current,
            name: pair.rel,
            size: pair.file.size,
            loaded: 0,
            status: 'queued',
            message: '',
            file: pair.file,
          }
          setUploads(function (list) { return list.concat([item]) })
          chainRef.current = chainRef.current.then(function () { return runUpload(item, target) })
        })
      }

      var refresh = function () { loadDirectory(dirRef.current, false) }

      var uploadInto = function (fileList, directory) {
        var pairs = []
        for (var index = 0; index < fileList.length; index += 1) {
          var file = fileList[index]
          var relative = file.webkitRelativePath && file.webkitRelativePath !== '' ? file.webkitRelativePath : file.name
          pairs.push({ file: file, rel: relative })
        }
        enqueue(pairs, directory)
      }

      /** Open one file in the shipped preview tab. */
      var openPreview = function (entry) {
        if (entry.type !== 'file') return
        var absolute = absoluteOf(entry.name)
        var address = fileAddress(sessionId, cwdRef.current || dirRef.current, absolute)
        if (openResource === null) return
        try {
          openResource(address)
        } catch (error) {
          console.error('[dsfm] could not open the preview', error)
        }
      }

      /** Double click and Enter on a single row: folder enters, file previews. */
      var openEntry = function (entry) {
        if (entry.type === 'directory') {
          navigate(absoluteOf(entry.name))
          return
        }
        openPreview(entry)
      }

      /**
       * Explorer opens every selected item. One pane cannot hold several folder
       * windows, so a selection of files previews each one, while a selection of
       * folders alone enters the single focused folder.
       */
      var openSelection = function (entry) {
        var items = menuSelection(entry).map(findEntry).filter(function (item) { return item !== null })
        var files = items.filter(function (item) { return item.type === 'file' })
        var folders = items.filter(function (item) { return item.type === 'directory' })
        if (files.length === 0) {
          if (folders.length === 1) navigate(absoluteOf(folders[0].name))
          else if (folders.length > 1) notify('一次只能进入一个文件夹')
          return
        }
        files.forEach(function (item) { openPreview(item) })
        if (folders.length > 0) notify('已跳过 ' + folders.length + ' 个文件夹')
      }

      var downloadEntry = function (entry) {
        var absolute = joinPath(dirRef.current, entry.name)
        triggerDownload(transferUrl('download', { sessionId: sessionId, path: absolute }))
      }

      /** Walk one entry into `{name, data}` pairs for the selection archive. */
      var collectForZip = function (absolute, name, entry, out) {
        if (entry.type !== 'directory') {
          return fetch(transferUrl('download', { sessionId: sessionId, path: absolute }), { credentials: 'same-origin' })
            .then(function (response) {
              if (!response.ok) throw apiError('http-' + response.status, '读取失败：' + name)
              return response.arrayBuffer()
            })
            .then(function (buffer) {
              out.push({ name: name, data: new Uint8Array(buffer), mtimeMs: entry.mtimeMs })
            })
        }
        return api('list', { sessionId: sessionId, path: absolute }).then(function (value) {
          var chain = Promise.resolve()
          value.entries.forEach(function (child) {
            chain = chain.then(function () {
              return collectForZip(joinPath(absolute, child.name), name + '/' + child.name, child, out)
            })
          })
          return chain
        })
      }

      /** One selected file downloads as itself; a selection becomes one archive. */
      var downloadSelection = function (entry) {
        var names = menuSelection(entry)
        if (names.length === 1) {
          downloadEntry(entry)
          return
        }
        var picked = []
        names.forEach(function (name) {
          var item = findEntry(name)
          if (item !== null) picked.push({ name: name, entry: item })
        })
        notify('正在打包 ' + names.length + ' 项…')
        var files = []
        var chain = Promise.resolve()
        picked.forEach(function (item) {
          chain = chain.then(function () {
            return collectForZip(absoluteOf(item.name), item.name, item.entry, files)
          })
        })
        chain.then(function () {
          if (files.length === 0) {
            notify('没有可下载的文件')
            return
          }
          triggerBlobDownload(zipBlob(files), '选择' + names.length + '项-' + timeStamp() + '.zip')
        }, function (error) {
          notify((error && error.message) || '打包失败')
        })
      }

      var zipEntry = function (entry) {
        var absolute = joinPath(dirRef.current, entry.name)
        triggerDownload(transferUrl('zip', { sessionId: sessionId, path: absolute }))
      }

      var ask = function (options) {
        return new Promise(function (resolve) {
          dialogSeq.current += 1
          setDialog(Object.assign({ seq: dialogSeq.current, resolve: resolve }, options))
        })
      }

      var notify = function (text, tone) {
        toastSeq.current += 1
        setToast({ seq: toastSeq.current, text: text, tone: tone })
      }

      var askInput = function (title, value) {
        return ask({ kind: 'input', title: title, value: value })
      }

      var askInfo = function (title, message) {
        return ask({ kind: 'info', title: title, message: message })
      }

      var askConfirm = function (title, message, confirmLabel, danger) {
        return ask({ kind: 'confirm', title: title, message: message, confirmLabel: confirmLabel, danger: danger === true })
      }

      var findEntry = function (name) {
        for (var index = 0; index < listing.entries.length; index += 1) {
          if (listing.entries[index].name === name) return listing.entries[index]
        }
        return null
      }

      var absoluteOf = function (name) { return joinPath(dirRef.current, name) }

      var selectByName = function (name) {
        var single = {}
        single[name] = true
        setSelected(single)
      }

      /** The right-clicked row when it is part of the selection, else just that row. */
      var menuSelection = function (entry) {
        var names = Object.keys(selected).filter(function (name) { return selected[name] === true })
        return names.indexOf(entry.name) === -1 ? [entry.name] : names
      }

      var showProperties = function (entry) {
        var names = menuSelection(entry)
        if (names.length > 1) {
          var total = 0
          names.forEach(function (name) {
            var item = findEntry(name)
            if (item !== null && item.type !== 'directory') total += item.size
          })
          askInfo(copy('properties'), [
            '项目数：' + names.length,
            '位置：' + dirRef.current,
            '总大小：' + sizeText(total) + '（' + total + ' 字节，仅文件）',
          ].join('\n'))
          return
        }
        var lines = [
          '名称：' + entry.name,
          '位置：' + dirRef.current,
          '类型：' + (entry.type === 'directory' ? '文件夹' : entry.symlink ? '符号链接' : '文件'),
          entry.type === 'directory' ? '大小：—' : '大小：' + sizeText(entry.size) + '（' + entry.size + ' 字节）',
          '修改时间：' + timeText(entry.mtimeMs),
          '完整路径：' + absoluteOf(entry.name),
        ]
        askInfo(copy('properties'), lines.join('\n'))
      }

      var copyPathOf = function (entry) {
        var text = menuSelection(entry).map(absoluteOf).join('\n')
        var clipboardApi = navigator.clipboard
        if (!clipboardApi || typeof clipboardApi.writeText !== 'function') {
          notify('浏览器不允许写剪贴板')
          return
        }
        clipboardApi.writeText(text).then(function () {
          notify(copy('copiedPath'), 'success')
        }, function () {
          notify('复制路径失败')
        })
      }

      /** Copy/move each `{src, dst}` in order, asking once about a name clash. */
      /** Unknown until the first copy: whether the host serves the `/copy` route. */
      var serverCopy = null

      /**
       * Copy one path through the raw routes, used until the host half that
       * serves `/copy` is loaded: walk directories and re-upload file bytes.
       */
      var copyThroughRoutes = function (from, to, overwrite) {
        return api('list', { sessionId: sessionId, path: dirName(from) }).then(function (value) {
          var entry = null
          value.entries.forEach(function (item) {
            if (item.name === baseName(from)) entry = item
          })
          if (entry === null) throw apiError('not-found', '源文件不存在')
          if (entry.type !== 'directory') {
            return fetch(transferUrl('download', { sessionId: sessionId, path: from }), { credentials: 'same-origin' })
              .then(function (response) {
                if (!response.ok) throw apiError('http-' + response.status, '读取源文件失败')
                return response.blob()
              })
              .then(function (blob) {
                return uploadOne({
                  sessionId: sessionId,
                  directory: dirName(to),
                  name: baseName(to),
                  file: new File([blob], baseName(to)),
                  overwrite: overwrite,
                }).promise
              })
          }
          var make = api('mkdir', {}, { sessionId: sessionId, path: to })
          if (overwrite) {
            make = make.catch(function (error) {
              if (error.code !== 'exists') throw error
            })
          }
          return make.then(function () {
            return api('list', { sessionId: sessionId, path: from }).then(function (children) {
              var chain = Promise.resolve()
              children.entries.forEach(function (child) {
                chain = chain.then(function () {
                  return copyThroughRoutes(joinPath(from, child.name), joinPath(to, child.name), true)
                })
              })
              return chain
            })
          })
        })
      }

      /** Prefer the host route; fall back once when it is not served yet. */
      var copyPath = function (from, to, overwrite) {
        if (serverCopy === false) return copyThroughRoutes(from, to, overwrite)
        return api('copy', {}, { sessionId: sessionId, from: from, to: to, overwrite: overwrite }).then(function (value) {
          serverCopy = true
          return value
        }, function (error) {
          if (error.code !== 'http-404' && error.code !== 'http-405') throw error
          serverCopy = false
          return copyThroughRoutes(from, to, overwrite)
        })
      }

      /**
       * Copy/move each `{src, dst}` in order, asking once about a name clash.
       * A transfer is listed while it runs, with a cancel that takes effect at
       * the next item — the same shape Explorer's copy dialog offers.
       */
      var transfer = function (op, items, done) {
        if (items.length === 0) return
        counterRef.current += 1
        var key = 'tr-' + counterRef.current
        var label = op === 'copy' ? copy('copying') : copy('moving')
        var cancelled = false
        var force = false
        var skipped = 0
        var completed = 0
        var update = function (patch) {
          setTransfers(function (list) {
            return list.map(function (item) {
              return item.key === key ? Object.assign({}, item, patch) : item
            })
          })
        }
        setTransfers(function (list) {
          return list.concat([{ key: key, label: label, done: 0, total: items.length, status: 'running' }])
        })
        transferCancelRef.current = function () {
          cancelled = true
          update({ status: 'cancelled' })
        }
        var chain = Promise.resolve()
        items.forEach(function (item) {
          chain = chain.then(function () {
            if (cancelled) return
            var send = function (overwrite) {
              if (op === 'copy') return copyPath(item.src, item.dst, overwrite)
              return api('move', {}, { sessionId: sessionId, from: item.src, to: item.dst, overwrite: overwrite })
            }
            var succeed = function () {
              completed += 1
              update({ done: completed })
            }
            return send(force).then(succeed, function (error) {
              if (error.code !== 'exists') {
                skipped += 1
                notify((error && error.message) || copy('failed'))
                return
              }
              return askConfirm(copy('conflictTitle'), copy('conflictMessage', { name: baseName(item.dst) }), copy('replace'), true)
                .then(function (replace) {
                  if (replace !== true) {
                    skipped += 1
                    return
                  }
                  force = true
                  return send(true).then(succeed, function (failure) {
                    skipped += 1
                    notify((failure && failure.message) || copy('failed'))
                  })
                })
            })
          })
        })
        chain.then(function () {
          transferCancelRef.current = null
          update({ status: cancelled ? 'cancelled' : 'done' })
          refresh()
          if (done) done()
          if (skipped > 0) notify(copy('skipped', { n: skipped }))
          window.setTimeout(function () {
            setTransfers(function (list) {
              return list.filter(function (item) { return item.key !== key })
            })
          }, 2500)
        })
      }

      /** A Windows-style "name - 副本.ext" name that no current entry takes. */
      var freeName = function (name, taken) {
        var dot = name.lastIndexOf('.')
        var stem = dot > 0 ? name.slice(0, dot) : name
        var extension = dot > 0 ? name.slice(dot) : ''
        var candidate = stem + ' - 副本' + extension
        var index = 2
        while (taken[candidate] === true) {
          candidate = stem + ' - 副本 (' + index + ')' + extension
          index += 1
        }
        return candidate
      }

      var pasteInto = function (targetDirectory) {
        var clip = clipboard
        if (clip === null) return
        var target = slashes(targetDirectory || dirRef.current)
        var op = clip.op === 'copy' ? 'copy' : 'move'
        api('list', { sessionId: sessionId, path: target }).then(function (value) {
          var taken = {}
          value.entries.forEach(function (entry) { taken[entry.name] = true })
          var items = []
          clip.paths.forEach(function (source) {
            if (op === 'move' && dirName(source) === target) return
            var name = baseName(source)
            if (op === 'copy' && (dirName(source) === target || taken[name] === true)) name = freeName(name, taken)
            taken[name] = true
            items.push({ src: source, dst: joinPath(target, name) })
          })
          if (items.length === 0) {
            notify(copy('sameFolder'))
            return
          }
          transfer(op, items, function () {
            if (op === 'move') setClipboard(null)
            notify(op === 'copy' ? copy('pasted') : copy('moved'), 'success')
          })
        }, function (error) {
          notify((error && error.message) || copy('failed'))
        })
      }

      var copySelection = function (op) {
        var names = Object.keys(selected).filter(function (name) { return selected[name] === true })
        if (names.length === 0) {
          notify(copy('needSelection'))
          return
        }
        setClipboard({ op: op, paths: names.map(absoluteOf) })
        notify(copy(op === 'copy' ? 'copied' : 'cutDone', { n: names.length }))
      }

      /** Finish an in-panel drag by moving the dragged rows into one folder. */
      var moveInto = function (targetDirectory) {
        var names = dragNames.current
        dragNames.current = null
        if (!names || names.length === 0) return
        var target = slashes(targetDirectory)
        var items = names.map(function (name) {
          return { src: absoluteOf(name), dst: joinPath(target, name) }
        }).filter(function (item) {
          return dirName(item.src) !== target
        })
        if (items.length === 0) {
          notify(copy('sameFolder'))
          return
        }
        transfer('move', items, function () { notify(copy('moved'), 'success') })
      }

      /** `report (2).md` — the name Windows gives the second item of a batch rename. */
      var numberedName = function (value, index, ownName) {
        var dot = value.lastIndexOf('.')
        var stem = dot > 0 ? value.slice(0, dot) : value
        var typedExtension = dot > 0 ? value.slice(dot) : ''
        var ownDot = ownName.lastIndexOf('.')
        var ownExtension = ownDot > 0 ? ownName.slice(ownDot) : ''
        var extension = typedExtension !== '' ? typedExtension : ownExtension
        return index === 0 ? stem + extension : stem + ' (' + index + ')' + extension
      }

      /** The characters and shapes Windows refuses in a file name. */
      var renameProblem = function (value) {
        if (String(value).trim() === '') return copy('nameEmpty')
        if (/[\\/:*?"<>|]/.test(value) || /[\u0000-\u001f]/.test(value)) return copy('nameIllegal')
        if (/[. ]$/.test(value)) return copy('nameTrailing')
        if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(value)) return copy('nameReserved')
        return null
      }

      /** Start the in-place editor; a multi-selection renames every item. */
      var startRename = function (entry) {
        var names = Object.keys(selected).filter(function (name) { return selected[name] === true })
        if (names.indexOf(entry.name) === -1) names = [entry.name]
        var state = { name: entry.name, value: entry.name, names: names }
        renamingRef.current = state
        setRenaming(state)
      }

      var cancelRename = function () {
        renamingRef.current = null
        setRenaming(null)
      }

      var commitRename = function () {
        var state = renamingRef.current
        if (state === null) return
        var value = String(state.value).trim()
        var problem = renameProblem(value)
        if (problem !== null) {
          notify(problem)
          return
        }
        renamingRef.current = null
        setRenaming(null)
        var targets = []
        state.names.forEach(function (name, index) {
          var finalName = numberedName(value, index, name)
          if (finalName !== name) targets.push({ from: name, to: finalName })
        })
        if (targets.length === 0) return
        var force = false
        var skipped = 0
        var chain = Promise.resolve()
        targets.forEach(function (item) {
          chain = chain.then(function () {
            var send = function (overwrite) {
              return api('move', {}, {
                sessionId: sessionId,
                from: absoluteOf(item.from),
                to: joinPath(dirRef.current, item.to),
                overwrite: overwrite,
              })
            }
            return send(force).then(null, function (error) {
              if (error.code !== 'exists') {
                skipped += 1
                notify((error && error.message) || copy('renameFailed'))
                return
              }
              return askConfirm(copy('conflictTitle'), copy('conflictMessage', { name: item.to }), copy('replace'), true)
                .then(function (replace) {
                  if (replace !== true) {
                    skipped += 1
                    return
                  }
                  force = true
                  return send(true).then(null, function (failure) {
                    skipped += 1
                    notify((failure && failure.message) || copy('renameFailed'))
                  })
                })
            })
          })
        })
        chain.then(function () {
          selectByName(targets[0].to)
          refresh()
          if (skipped > 0) notify(copy('skipped', { n: skipped }))
        })
      }

      // Focus the editor and preselect the stem, the way F2 does.
      react.useEffect(function () {
        var input = renameInput.current
        if (input === null || renaming === null) return
        input.focus()
        var dot = input.value.lastIndexOf('.')
        input.setSelectionRange(0, dot > 0 ? dot : input.value.length)
      }, [renaming === null ? '' : renaming.name])

      var deleteEntries = function (names) {
        if (names.length === 0) return
        var message = names.length === 1
          ? copy('deleteConfirm', { name: names[0] })
          : copy('deleteSelectedConfirm', { n: names.length })
        askConfirm(copy('deleteTitle'), message, copy('delete'), true).then(function (confirmed) {
          if (confirmed !== true) return
          api('delete', {}, {
            sessionId: sessionId,
            paths: names.map(absoluteOf),
          }).then(function (value) {
            setSelected({})
            refresh()
            if (value.failures && value.failures.length > 0) {
              notify(value.failures[0].message || copy('deleteFailed'))
            }
          }, function (error) {
            notify((error && error.message) || copy('deleteFailed'))
          })
        })
      }

      var makeDirectory = function () {
        askInput(copy('mkdirTitle'), '').then(function (value) {
          if (value === null) return
          var next = String(value).trim()
          if (next === '') return
          if (/[\\/]/.test(next)) {
            notify(copy('nameInvalid'))
            return
          }
          api('mkdir', {}, { sessionId: sessionId, path: joinPath(dirRef.current, next) })
            .then(refresh, function (error) {
              notify((error && error.message) || copy('mkdirFailed'))
            })
        })
      }

      var menuItemsFor = function (name) {
        var canPaste = clipboard !== null
        var pasteItem = {
          id: 'paste',
          label: copy('paste'),
          icon: menuIcon('paste'),
          disabled: !canPaste,
          shortcut: { keys: ['Ctrl', 'V'], aria: 'Control+V' },
        }
        if (name === null) {
          return [
            pasteItem,
            { id: 'mkdir', label: copy('mkdirTitle'), icon: menuIcon('folderPlus') },
            { id: 'upload', label: copy('uploadFiles'), icon: menuIcon('upload') },
            { id: 'uploadFolder', label: copy('uploadFolder'), icon: menuIcon('folderPlus') },
            { type: 'separator', id: 'sep-empty' },
            { id: 'refresh', label: copy('refresh'), icon: menuIcon('refresh') },
          ]
        }
        var entry = findEntry(name)
        if (entry === null) return []
        var items = [
          {
            id: 'open',
            label: (function () {
              var count = Object.keys(selected).filter(function (item) { return selected[item] === true }).length
              if (entry.type === 'directory' && count <= 1) return copy('open')
              return count > 1 ? copy('openPreview') + ' ' + count + ' 项' : copy('openPreview')
            })(),
            icon: menuIcon(entry.type === 'directory' ? 'folderOpen' : 'file'),
            shortcut: { keys: ['Enter'], aria: 'Enter' },
          },
          entry.type === 'directory' && Object.keys(selected).filter(function (item) { return selected[item] === true }).length <= 1
            ? { id: 'zip', label: copy('folderZip'), icon: menuIcon('archive') }
            : { id: 'download', label: copy('download'), icon: menuIcon('download') },
          { type: 'separator', id: 'sep-top' },
          { id: 'copy', label: copy('copy'), icon: menuIcon('copy'), shortcut: { keys: ['Ctrl', 'C'], aria: 'Control+C' } },
          { id: 'cut', label: copy('cut'), icon: menuIcon('cut'), shortcut: { keys: ['Ctrl', 'X'], aria: 'Control+X' } },
          { id: 'copyPath', label: copy('copyPath'), icon: menuIcon('copy') },
        ]
        if (entry.type === 'directory') {
          items.push({ id: 'pasteInto', label: copy('pasteHere'), icon: menuIcon('paste'), disabled: !canPaste })
        }
        items.push(
          { type: 'separator', id: 'sep-mid' },
          { id: 'rename', label: copy('renameTitle'), icon: menuIcon('edit'), shortcut: { keys: ['F2'], aria: 'F2' } },
          { id: 'delete', label: copy('delete'), icon: menuIcon('trash'), danger: true, shortcut: { keys: ['Delete'], aria: 'Delete' } },
          { type: 'separator', id: 'sep-props' },
          { id: 'properties', label: copy('properties'), icon: menuIcon('file'), shortcut: { keys: ['Alt', 'Enter'], aria: 'Alt+Enter' } },
        )
        return items
      }

      var openMenuAt = function (event, name) {
        event.preventDefault()
        event.stopPropagation()
        if (name !== null && selected[name] !== true) {
          var single = {}
          single[name] = true
          setSelected(single)
        }
        // Shift+F10 and the menu key report (0,0); anchor those on the row.
        var x = event.clientX
        var y = event.clientY
        if (x === 0 && y === 0) {
          var anchor = name === null
            ? document.querySelector('.dsfm-list')
            : document.querySelector('.dsfm-row[data-fm-name="'
              + (window.CSS && window.CSS.escape ? window.CSS.escape(name) : name) + '"]')
          var rect = anchor && anchor.getBoundingClientRect()
          if (rect) {
            x = rect.left + 16
            y = rect.top + 18
          }
        }
        setMenu({ x: x, y: y, name: name, items: menuItemsFor(name) })
      }

      var runMenuAction = function (id) {
        var name = menu === null ? null : menu.name
        var entry = name === null ? null : findEntry(name)
        if (id === 'mkdir') makeDirectory()
        else if (id === 'upload') { if (uploadInput.current) uploadInput.current.click() }
        else if (id === 'uploadFolder') { if (folderInput.current) folderInput.current.click() }
        else if (id === 'refresh') refresh()
        else if (id === 'paste') pasteInto(dirRef.current)
        else if (entry !== null && id === 'pasteInto') pasteInto(absoluteOf(entry.name))
        else if (entry === null) return
        else if (id === 'open') openSelection(entry)
        else if (id === 'zip') zipEntry(entry)
        else if (id === 'download') downloadSelection(entry)
        else if (id === 'copy') copySelection('copy')
        else if (id === 'cut') copySelection('cut')
        else if (id === 'rename') startRename(entry)
        else if (id === 'copyPath') copyPathOf(entry)
        else if (id === 'properties') showProperties(entry)
        else if (id === 'delete') deleteEntries(menuSelection(entry))
        setMenu(null)
      }

      var moveSelection = function (step) {
        var names = listing.entries.map(function (item) { return item.name })
        if (names.length === 0) return
        var current = names.indexOf(selectedNames.length > 0 ? selectedNames[0] : anchorRef.current)
        var next = current
        if (step === 'home') next = 0
        else if (step === 'end') next = names.length - 1
        else if (current === -1) next = step > 0 ? 0 : names.length - 1
        else next = Math.min(names.length - 1, Math.max(0, current + step))
        var name = names[next]
        anchorRef.current = name
        var single = {}
        single[name] = true
        setSelected(single)
        var row = document.querySelector('.dsfm-row[data-fm-name="'
          + (window.CSS && window.CSS.escape ? window.CSS.escape(name) : name.replace(/"/g, '\\"')) + '"]')
        if (row !== null && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' })
      }

      var onKeyDown = function (event) {
        if (typeof event.key !== 'string') return
        var key = event.key
        var modified = event.ctrlKey || event.metaKey
        var names = Object.keys(selected).filter(function (name) { return selected[name] === true })
        if (event.altKey && key === 'ArrowUp') {
          event.preventDefault()
          goUp()
          return
        }
        if (event.altKey && (key === 'ArrowLeft' || key === 'ArrowRight')) {
          event.preventDefault()
          goTo(null, key === 'ArrowLeft' ? 'back' : 'forward')
          return
        }
        if (event.altKey && key === 'Enter' && names.length === 1) {
          event.preventDefault()
          var inspected = findEntry(names[0])
          if (inspected !== null) showProperties(inspected)
          return
        }
        if (key === 'ArrowDown' || key === 'ArrowUp') {
          event.preventDefault()
          moveSelection(key === 'ArrowDown' ? 1 : -1)
          return
        }
        if (key === 'Home' || key === 'End') {
          event.preventDefault()
          moveSelection(key === 'Home' ? 'home' : 'end')
          return
        }
        if (key === 'PageDown' || key === 'PageUp') {
          event.preventDefault()
          moveSelection(key === 'PageDown' ? 10 : -10)
          return
        }
        if (key === 'F5') {
          event.preventDefault()
          refresh()
          return
        }
        if (key === 'Backspace') {
          event.preventDefault()
          goUp()
          return
        }
        if (modified && (key === 'a' || key === 'A')) {
          event.preventDefault()
          var all = {}
          listing.entries.forEach(function (entry) {
            if (entry.type !== 'other') all[entry.name] = true
          })
          setSelected(all)
        } else if (modified && (key === 'c' || key === 'C')) {
          event.preventDefault()
          copySelection('copy')
        } else if (modified && (key === 'x' || key === 'X')) {
          event.preventDefault()
          copySelection('cut')
        } else if (modified && (key === 'v' || key === 'V')) {
          event.preventDefault()
          pasteInto(dirRef.current)
        } else if (key === 'Delete') {
          event.preventDefault()
          deleteEntries(names)
        } else if (key === 'F2' && names.length >= 1) {
          event.preventDefault()
          var only = findEntry(names[0])
          if (only !== null) startRename(only)
        } else if (key === 'Enter' && names.length >= 1) {
          var target = findEntry(names[0])
          if (target !== null) openSelection(target)
        } else if (key === 'Escape') {
          setSelected({})
          setMenu(null)
        }
      }

      /** Rubber-band selection: press on empty space and drag across rows. */
      var onListMouseDown = function (event) {
        if (event.button !== 0) return
        if (event.target.closest('.dsfm-row, .dsfm-head, .dsfm-btn, .dsfm-act')) return
        var listEl = listRef.current
        if (listEl === null) return
        event.preventDefault()
        listEl.focus()
        var rect = listEl.getBoundingClientRect()
        marqueeStart.current = {
          x: event.clientX - rect.left + listEl.scrollLeft,
          y: event.clientY - rect.top + listEl.scrollTop,
        }
        setSelected({})
        setMarquee({ x: marqueeStart.current.x, y: marqueeStart.current.y, w: 0, h: 0 })
      }

      react.useEffect(function () {
        if (marquee === null) return
        var listEl = listRef.current
        if (listEl === null) return
        var onMove = function (event) {
          var start = marqueeStart.current
          if (start === null) return
          var rect = listEl.getBoundingClientRect()
          var x = event.clientX - rect.left + listEl.scrollLeft
          var y = event.clientY - rect.top + listEl.scrollTop
          var box = {
            x: Math.min(start.x, x),
            y: Math.min(start.y, y),
            w: Math.abs(x - start.x),
            h: Math.abs(y - start.y),
          }
          setMarquee(box)
          var picked = {}
          var rows = listEl.querySelectorAll('.dsfm-row')
          for (var index = 0; index < rows.length; index += 1) {
            var row = rows[index]
            var rowRect = row.getBoundingClientRect()
            var top = rowRect.top - rect.top + listEl.scrollTop
            var left = rowRect.left - rect.left + listEl.scrollLeft
            if (left < box.x + box.w && left + rowRect.width > box.x
              && top < box.y + box.h && top + rowRect.height > box.y) {
              picked[row.getAttribute('data-fm-name')] = true
            }
          }
          setSelected(picked)
        }
        var onUp = function () {
          // The browser sends a click after the drag; swallow exactly that one.
          suppressClick.current = marqueeStart.current !== null
          marqueeStart.current = null
          setMarquee(null)
          window.setTimeout(function () { suppressClick.current = false }, 300)
        }
        document.addEventListener('mousemove', onMove)
        document.addEventListener('mouseup', onUp)
        return function () {
          document.removeEventListener('mousemove', onMove)
          document.removeEventListener('mouseup', onUp)
        }
      }, [marquee !== null])

      var onDrop = function (event) {
        event.preventDefault()
        setDragging(false)
        if (dragNames.current !== null) return
        var target = dirRef.current
        droppedFiles(event).then(function (pairs) { enqueue(pairs, target) })
      }

      selectedRef.current = selected
      var selectedNames = Object.keys(selected).filter(function (name) { return selected[name] === true })

      var crumbs = []
      if (cwd) {
        var root = slashes(cwd).replace(/\/+$/, '')
        crumbs.push({ name: baseName(root) || root, path: root })
        var relative = relativeOf(root, dir || root)
        if (relative !== '') {
          var accumulated = root
          relative.split('/').forEach(function (part) {
            if (part === '') return
            accumulated = accumulated + '/' + part
            crumbs.push({ name: part, path: accumulated })
          })
        }
      }

      /** Explorer-style selection: plain click replaces, Ctrl toggles, Shift extends. */
      var selectEntry = function (entry, event) {
        var names = listing.entries.map(function (item) { return item.name })
        if (event.shiftKey && anchorRef.current !== null) {
          var from = names.indexOf(anchorRef.current)
          var to = names.indexOf(entry.name)
          if (from !== -1 && to !== -1) {
            var range = {}
            var low = Math.min(from, to)
            var high = Math.max(from, to)
            for (var index = low; index <= high; index += 1) range[names[index]] = true
            setSelected(event.ctrlKey || event.metaKey ? Object.assign({}, selected, range) : range)
            return
          }
        }
        anchorRef.current = entry.name
        if (event.ctrlKey || event.metaKey) {
          setSelected(function (previous) {
            var next = Object.assign({}, previous)
            if (next[entry.name] === true) delete next[entry.name]
            else next[entry.name] = true
            return next
          })
          return
        }
        var single = {}
        single[entry.name] = true
        setSelected(single)
      }

      var cutPathSet = {}
      if (clipboard !== null && clipboard.op === 'cut') {
        clipboard.paths.forEach(function (path) { cutPathSet[path] = true })
      }

      var rows = listing.entries.map(function (entry) {
        var checked = selected[entry.name] === true
        var cut = cutPathSet[absoluteOf(entry.name)] === true
        var isFolder = entry.type === 'directory'
        return h('div', {
          key: entry.name,
          'data-fm-name': entry.name,
          className: 'dsfm-row' + (checked ? ' checked' : '') + (cut ? ' cut' : '')
            + (isFolder && dragTarget === entry.name ? ' drop-target' : ''),
          draggable: !(renaming !== null && renaming.name === entry.name),
          onMouseDown: function (event) {
            if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) return
            if (selected[entry.name] !== true) {
              var single = {}
              single[entry.name] = true
              selectedRef.current = single
              setSelected(single)
            }
          },
          onDragStart: function (event) {
            var current = selectedRef.current
            var names = current[entry.name] === true
              ? Object.keys(current).filter(function (name) { return current[name] === true })
              : [entry.name]
            dragNames.current = names
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData('text/plain', names.join('\n'))
            var badge = document.createElement('div')
            badge.textContent = names.length > 1 ? names.length + ' 项' : names[0]
            badge.style.cssText = 'position:fixed;top:-200px;left:-200px;z-index:1;padding:3px 8px;border-radius:6px;'
              + 'background:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff;font:12px/1.5 system-ui,sans-serif'
            document.body.appendChild(badge)
            event.dataTransfer.setDragImage(badge, 10, 10)
            window.setTimeout(function () { badge.remove() }, 0)
          },
          onDragEnd: function () {
            dragNames.current = null
            setDragTarget('')
          },
          onClick: function (event) {
            if (event.target.closest('.dsfm-act')) return
            selectEntry(entry, event)
          },
          onDoubleClick: function (event) {
            if (event.target.closest('.dsfm-act')) return
            openEntry(entry)
          },
          onContextMenu: function (event) { openMenuAt(event, entry.name) },
          onDragOver: isFolder ? function (event) {
            var internal = dragNames.current !== null
            var transfer = event.dataTransfer
            var carriesFiles = transfer !== null && transfer !== undefined
              && Array.prototype.indexOf.call(transfer.types || [], 'Files') !== -1
            if (!internal && !carriesFiles) return
            event.preventDefault()
            event.stopPropagation()
            if (internal) setDragTarget(entry.name)
          } : undefined,
          onDragLeave: isFolder ? function () {
            if (dragTarget === entry.name) setDragTarget('')
          } : undefined,
          onDrop: isFolder ? function (event) {
            if (dragNames.current !== null) {
              event.preventDefault()
              event.stopPropagation()
              setDragTarget('')
              moveInto(joinPath(dirRef.current, entry.name))
              return
            }
            var transfer = event.dataTransfer
            var carriesFiles = transfer !== null && transfer !== undefined
              && Array.prototype.indexOf.call(transfer.types || [], 'Files') !== -1
            if (!carriesFiles) return
            event.preventDefault()
            event.stopPropagation()
            setDragging(false)
            var folder = absoluteOf(entry.name)
            droppedFiles(event).then(function (pairs) { enqueue(pairs, folder) })
          } : undefined,
        }, [
          h('span', { key: 'icon', className: 'dsfm-ico' }, entryGlyph(entry)),
          renaming !== null && renaming.name === entry.name
            ? h('input', {
              key: 'name',
              ref: renameInput,
              className: 'dsfm-rename',
              value: renaming.value,
              spellCheck: false,
              'aria-label': copy('renameTitle'),
              onChange: function (event) {
                var next = { name: renaming.name, value: event.target.value, names: renaming.names }
                renamingRef.current = next
                setRenaming(next)
              },
              onKeyDown: function (event) {
                event.stopPropagation()
                if (event.key === 'Enter') {
                  event.preventDefault()
                  commitRename()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  cancelRename()
                }
              },
              onBlur: function () { commitRename() },
              onClick: function (event) { event.stopPropagation() },
              onDoubleClick: function (event) { event.stopPropagation() },
              onMouseDown: function (event) { event.stopPropagation() },
              onDragStart: function (event) { event.preventDefault() },
            })
            : h('button', {
              key: 'name',
              type: 'button',
              className: 'dsfm-name' + (entry.type === 'directory' ? ' dir' : '') + (entry.symlink ? ' symlink' : ''),
              title: entry.name + (entry.symlink ? '（符号链接）' : '') + '\n单击选中，双击打开；Ctrl / Shift 多选',
              'data-fm-open': true,
            }, h('span', null, entry.name)),
          h('span', { key: 'size', className: 'dsfm-size', title: timeText(entry.mtimeMs) },
            entry.type === 'directory' ? '—' : sizeText(entry.size)),
          h('span', { key: 'actions', className: 'dsfm-actions' }, [
            entry.type === 'directory'
              ? h(IconButton, { key: 'zip', icon: 'archive', title: copy('folderZip'), onClick: function () { zipEntry(entry) } })
              : h(IconButton, { key: 'download', icon: 'download', title: copy('download'), onClick: function () { downloadEntry(entry) } }),
            h(IconButton, { key: 'rename', icon: 'edit', title: copy('renamePrompt'), onClick: function () { renameEntry(entry) } }),
            h(IconButton, { key: 'delete', icon: 'trash', title: copy('delete'), danger: true, onClick: function () { deleteEntries([entry.name]) } }),
          ]),
        ])
      })

      var transfersPanel = transfers.length === 0 ? null : h('div', { className: 'dsfm-uploads' }, [
        h('div', { key: 'head', className: 'dsfm-uploads-head' }, [
          h('span', { key: 'label' }, copy('transfer')),
        ]),
        h('div', { key: 'list' }, transfers.map(function (item) {
          var percent = item.total > 0 ? Math.round((item.done / item.total) * 100) : 0
          return h('div', { key: item.key, className: 'dsfm-up' }, [
            h('span', { key: 'name', className: 'dsfm-up-name' },
              (item.status === 'done' ? '已完成' : item.label)
              + (item.total > 1 && item.status !== 'done' ? ' ' + item.done + '/' + item.total : '')),
            h('span', { key: 'status', className: 'dsfm-up-status' }, item.status === 'running'
              ? h('button', {
                key: 'cancel',
                type: 'button',
                className: 'dsfm-btn',
                style: { height: '18px', padding: '0 5px', fontSize: '10px' },
                onClick: function () {
                  if (transferCancelRef.current !== null) transferCancelRef.current()
                },
              }, copy('cancel'))
              : item.status === 'cancelled' ? copy('cancelled') : '✓'),
            h('span', { key: 'bar', className: 'dsfm-bar' }, h('i', {
              style: { width: (item.status === 'done' ? 100 : percent) + '%' },
            })),
          ])
        })),
      ])

      var uploadsPanel = uploads.length === 0 ? null : h('div', { className: 'dsfm-uploads' }, [
        h('div', { key: 'head', className: 'dsfm-uploads-head' }, [
          h('span', { key: 'label' }, copy('uploading') + ' (' + uploads.filter(function (item) { return item.status !== 'done' && item.status !== 'error' }).length + ')'),
          h('button', {
            key: 'clear',
            type: 'button',
            className: 'dsfm-btn',
            onClick: function () {
              setUploads(function (list) {
                return list.filter(function (item) { return item.status !== 'done' && item.status !== 'error' })
              })
            },
          }, copy('clearDone')),
        ]),
        h('div', { key: 'list' }, uploads.map(function (item) {
          var percent = item.size > 0 ? Math.min(100, Math.round((item.loaded / item.size) * 100)) : 0
          var statusText = item.status === 'queued' ? copy('queued')
            : item.status === 'uploading' ? copy('uploading') + ' ' + percent + '%'
              : item.status === 'done' ? '✓ ' + copy('done')
                : '✕ ' + (item.message || copy('failed'))
          return h('div', { key: item.key, className: 'dsfm-up' }, [
            h('span', { key: 'name', className: 'dsfm-up-name', title: item.name }, item.name),
            h('span', {
              key: 'status',
              className: 'dsfm-up-status' + (item.status === 'error' ? ' err' : ''),
            }, [
              item.status === 'uploading' && handlesRef.current[item.key]
                ? h('button', {
                  key: 'cancel',
                  type: 'button',
                  className: 'dsfm-btn',
                  style: { height: '18px', padding: '0 5px', fontSize: '10px', marginRight: '4px' },
                  onClick: function () { handlesRef.current[item.key].abort() },
                }, copy('cancel'))
                : null,
              statusText,
            ]),
            h('span', { key: 'bar', className: 'dsfm-bar' + (item.status === 'error' ? ' err' : '') },
              h('i', { style: { width: (item.status === 'done' ? 100 : percent) + '%' } })),
          ])
        })),
      ])

      var body = []
      if (!cwd) {
        body.push(h('div', { key: 'noworkspace', className: 'dsfm-note' }, copy('noWorkspace')))
      } else {
        body.push(h('div', { key: 'toolbar', className: 'dsfm-toolbar' }, [
          h(ToolButton, {
            key: 'back',
            icon: 'chevronLeft',
            iconOnly: true,
            title: copy('back'),
            disabled: historyRef.current.index <= 0,
            onClick: function () { goTo(null, 'back') },
          }),
          h(ToolButton, {
            key: 'forward',
            icon: 'chevronRight',
            iconOnly: true,
            title: copy('forward'),
            disabled: historyRef.current.index >= historyRef.current.entries.length - 1,
            onClick: function () { goTo(null, 'forward') },
          }),
          h(ToolButton, {
            key: 'up',
            icon: 'up',
            iconOnly: true,
            title: copy('up'),
            disabled: atWorkspaceRoot(),
            onClick: goUp,
          }),
          h(ToolButton, {
            key: 'upload',
            icon: 'upload',
            label: copy('upload'),
            primary: true,
            onClick: function () { if (uploadInput.current) uploadInput.current.click() },
          }),
          h(ToolButton, {
            key: 'folder',
            icon: 'upload',
            label: copy('uploadFolder'),
            onClick: function () { if (folderInput.current) folderInput.current.click() },
          }),
          h(ToolButton, { key: 'mkdir', icon: 'folderPlus', label: copy('mkdir'), onClick: makeDirectory }),
          h(ToolButton, {
            key: 'paste',
            icon: 'paste',
            label: copy('paste'),
            disabled: clipboard === null,
            title: clipboard === null
              ? copy('paste')
              : (clipboard.op === 'copy' ? '已复制 ' : '已剪切 ') + clipboard.paths.length + ' 项',
            onClick: function () { pasteInto(dirRef.current) },
          }),
          h(ToolButton, {
            key: 'zip',
            icon: 'archive',
            label: copy('zipHere'),
            title: copy('folderZip'),
            onClick: function () {
              triggerDownload(transferUrl('zip', { sessionId: sessionId, path: dirRef.current }))
            },
          }),
          h(ToolButton, { key: 'refresh', icon: 'refresh', iconOnly: true, title: copy('refresh'), onClick: refresh }),
          h('input', {
            key: 'upload-input',
            ref: uploadInput,
            type: 'file',
            multiple: true,
            hidden: true,
            onChange: function (event) {
              uploadInto(event.target.files, dirRef.current)
              event.target.value = ''
            },
          }),
          h('input', {
            key: 'folder-input',
            ref: folderInput,
            type: 'file',
            multiple: true,
            hidden: true,
            webkitdirectory: '',
            directory: '',
            onChange: function (event) {
              uploadInto(event.target.files, dirRef.current)
              event.target.value = ''
            },
          }),
        ]))
        body.push(h('div', { key: 'crumbs', className: 'dsfm-crumbs' }, crumbs.map(function (crumb, index) {
          var isLast = index === crumbs.length - 1
          var parts = [h('button', {
            key: crumb.path,
            type: 'button',
            className: 'dsfm-crumb' + (isLast ? ' last' : ''),
            title: crumb.path,
            onClick: function () { navigate(crumb.path) },
          }, crumb.name)]
          if (!isLast) parts.push(h('span', { key: 'sep-' + index, className: 'dsfm-sep' }, '/'))
          return parts
        })))
        if (listing.error) {
          body.push(h('div', { key: 'error', className: 'dsfm-error' }, [
            listing.error.message || copy('failed'),
            h('div', { key: 'hint', className: 'dsfm-hint' },
              '路径：' + (listing.error.details && listing.error.details.path ? listing.error.details.path : dirRef.current)),
          ]))
        }
        body.push(h('div', {
          key: 'list',
          className: 'dsfm-list' + (dragging ? ' dragging' : ''),
          tabIndex: 0,
          ref: listRef,
          onMouseDown: onListMouseDown,
          onKeyDown: onKeyDown,
          onClick: function (event) {
            // Clearing happens on mousedown; a click after a rubber-band drag must
            // not wipe the rows the band just selected.
            if (suppressClick.current) {
              suppressClick.current = false
              return
            }
            if (event.target.closest('.dsfm-row, .dsfm-head, .dsfm-btn, .dsfm-act')) return
            setSelected({})
          },
          onContextMenu: function (event) { openMenuAt(event, null) },
          onDragOver: function (event) {
            if (dragNames.current !== null) return
            event.preventDefault()
            if (!dragging) setDragging(true)
          },
          onDragLeave: function (event) {
            if (event.currentTarget.contains(event.relatedTarget)) return
            setDragging(false)
          },
          onDrop: onDrop,
        }, [
          marquee === null ? null : h('div', {
            key: 'marquee',
            className: 'dsfm-marquee',
            style: {
              left: marquee.x + 'px',
              top: marquee.y + 'px',
              width: marquee.w + 'px',
              height: marquee.h + 'px',
            },
          }),
          h('div', { key: 'head', className: 'dsfm-head' }, [
            h('span', { key: 'spacer' }),
            h('span', { key: 'name' }, copy('name')),
            h('span', { key: 'size' }, copy('size')),
            h('span', { key: 'actions', style: { textAlign: 'right' } }, copy('actions')),
          ]),
          listing.status === 'loading' ? h('div', { key: 'loading', className: 'dsfm-note' }, copy('loading')) : null,
          listing.status !== 'loading' && rows.length === 0
            ? h('div', { key: 'empty', className: 'dsfm-note' }, [copy('empty'), h('div', { key: 'hint', className: 'dsfm-hint' }, copy('emptyHint'))])
            : null,
          listing.truncated ? h('div', { key: 'truncated', className: 'dsfm-note' }, copy('truncated')) : null,
          rows,
        ]))
        if (transfersPanel) body.push(react.cloneElement(transfersPanel, { key: 'transfers' }))
        if (uploadsPanel) body.push(react.cloneElement(uploadsPanel, { key: 'uploads' }))
        body.push(h('div', { key: 'status', className: 'dsfm-status' }, [
          h('span', { key: 'items' }, copy('itemCount', { n: listing.entries.length })),
          selectedNames.length > 0
            ? h('span', { key: 'selected', className: 'dsfm-status-selected' }, copy('selectedCount', { n: selectedNames.length }))
            : null,
        ]))
      }

      body.push(h(DialogHost, {
        key: dialog === null ? 'closed' : 'dialog-' + dialog.seq,
        state: dialog,
        onClose: function () { setDialog(null) },
      }))
      body.push(h(ContextMenuHost, {
        key: menu === null ? 'closed' : 'menu-' + menu.x + ':' + menu.y + ':' + String(menu.name),
        state: menu,
        onSelect: runMenuAction,
        onClose: function () { setMenu(null) },
      }))
      body.push(h(ToastHost, {
        key: 'toast',
        state: toast,
        onDone: function () { setToast(null) },
      }))

      return h('div', { className: 'dsfm' }, body)
    }

    // --------------------------------------------------------------- plugin

    /** Required client services: the slot registry, the tab registry and the sidebar service. */
    var inject = ['slots', 'sidebarRightTabs', 'sidebarRight']

    /**
     * Client plugin body.
     *
     * The shipped Files tab is taken over rather than duplicated: this
     * implementation answers the same `files` kind, keeps its guide entry and
     * type label, and adds the transfer and editing controls inside the one
     * panel. The document preview gains a matching download button.
     * @param {import('@deepseek-ai/cordis').Context} ctx browser root context.
     */
    function apply(ctx) {
      installStyles()
      openResource = function (address) {
        ctx.sidebarRight.openResource(address)
      }

      var definition = {
        id: TAB_ID,
        kind: FILES_KIND,
        priority: 'extension',
        // Explorer keeps a window's folder, selection and clipboard when you
        // switch tabs; keeping the body mounted does the same here.
        keepMounted: true,
        title: function () { return COPY.typeLabel },
        guide: [{
          id: 'workspace',
          commandId: 'workspace.files',
          order: 10,
          title: function () { return COPY.guideTitle },
          description: function () { return COPY.guideDescription },
          icon: primitives !== null && primitives.GuideArtworkFiles !== undefined ? primitives.GuideArtworkFiles : undefined,
        }],
      }

      ctx.effect(function () {
        return ctx.sidebarRightTabs.register(definition)
      }, 'dsh-file-manager: files tab type')

      ctx.effect(function () {
        return ctx.slots.inject('sidebar.right.pane.tab', function () {
          return ctx.slots.register({
            name: 'sidebar.right.pane.tab',
            key: TAB_ID,
          }, FileManagerBody)
        })
      }, 'dsh-file-manager: files tab body')

      ctx.effect(function () {
        return ctx.slots.inject('sidebar.right.tab.document.actions', function () {
          return ctx.slots.register({
            name: 'sidebar.right.tab.document.actions',
            id: TAB_ID,
            order: 40,
            label: COPY.download,
          }, DocumentActions)
        })
      }, 'dsh-file-manager: document download action')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
