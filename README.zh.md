# dsh-file-manager

给 DeepSeek Harness Web 自带的「文件」补上写方向：**上传、下载、打包下载、重命名、删除、新建文件夹**，日常改文件不必再开 SFTP。

自带的工作区文件面板只做「列目录 + 预览」。本插件不新增页签、不新增按钮，而是直接接管这一个面板（`extension` 优先级的 `files` 类型覆盖自带 `builtin` 实现），在原位长出上传/下载等能力；关掉插件时自带实现自动恢复。

## 功能

| 位置 | 能力 |
|---|---|
| 自带的「文件」页签（同一入口、同一标题） | 面包屑导航、目录优先排序、多选、拖拽上传（含文件夹上传）、上传进度与取消、下载文件、打包下载文件夹、**复制 / 剪切 / 粘贴**、**拖拽移动**、重命名、删除、新建文件夹；单击选中、双击打开（文件夹双击进入、文件双击预览） |
| 导航 | 后退 / 前进 / 上一级按钮与历史记录，面包屑；`Backspace`、`Alt+↑` 上一级，`Alt+←/→` 历史，`F5` 只刷新列表 |
| 行内右键菜单 | 打开、下载/打包下载、复制、剪切、复制路径、粘贴到此处、重命名、删除、属性（`Alt+Enter`）；空白处右键是粘贴、新建文件夹、上传文件、上传文件夹、刷新（浏览器自带菜单已屏蔽） |
| 鼠标 | 单击选中、`Ctrl`/`Meta` 单击加减选、`Shift` 单击连选、双击打开；拖拽行到文件夹即移动 |
| 重命名 | `F2` / 右键「重命名」直接**行内编辑**（默认只选中主文件名，保留扩展名）；`Enter` 提交、`Esc` 取消、点别处提交；多选时按 Windows 规则批量改名（`名字 (1).ext`，扩展名各自保留）；拒绝 `\ / : * ? " < > |`、结尾空格/句点、`CON/PRN/AUX/NUL/COM1-9/LPT1-9` |
| 传输进度 | 复制/移动在面板下方显示「传输」进度条，可**取消**（在下一个项目边界停止） |
| 键盘 | `Ctrl+C/X/V/A`、`Delete`、`F2`、`Enter`、`Esc`、方向键 / `Home` / `End` / `PageUp` / `PageDown` 移动选择、`Alt+Enter` 属性 |
| 文档预览页签的操作行 | 「下载」当前文件 |

上传走流式接收（不把整个文件读进内存），下载支持 HTTP `Range`（可续传/拖动播放），文件夹打包是边遍历边输出的流式 ZIP。

切到别的页签再回来会保留当前目录、选中和剪贴板（`keepMounted`）；文件夹同名复制是**合并**语义（目标里独有的文件保留），不再先删后拷。

粘贴到当前目录的副本按 Windows 习惯命名：`名字 - 副本.ext`、`名字 - 副本 (2).ext`；目标目录里有同名项时弹「替换 / 取消」确认。移动/复制/删除/重命名/新建都用 DSH 自己的 Modal 弹窗与 Toast 提示，不再用浏览器 `alert/confirm/prompt`。

## 安装

本插件是一个标准的 DSH profile 组合包（`dsh.bundle.patch` + `dsh.client`）。

```bash
# 1) 放到 profile 的依赖里（以本机 web profile 为例）
cd ~/.dsh/profiles/web
pnpm add file:/path/to/dsh-file-manager

# 2) 让 profile 选择这个组合包：package.json 的 dsh.profile.bundles 追加
#    "dsh-file-manager"
```

或者不跑 pnpm，手动把源码目录链接进 profile：

```bash
ln -s /path/to/dsh-file-manager ~/.dsh/profiles/web/node_modules/dsh-file-manager
# 再把 "dsh-file-manager" 写进 package.json 的 dsh.profile.bundles
```

重启 `dsh web`（或让 profile 配置热重载生效）后刷新页面即可。插件自带的 `cordis.patch.yml` 会插入一条 host 行：

```yaml
- insert:
    - id: file-manager
      name: dsh-file-manager
```

想关掉时，在 profile 的 `cordis.patch.yml` 里加 `- id: file-manager` + `disabled: true` 即可（浏览器半边随 host 条目一起消失，自带文件面板恢复原样）。

## 服务端路由

全部挂在 `/api2/dsh-file-manager/*`（不走反射拥有的 `/api` 通道）：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/info?sessionId` | 会话工作区根 |
| GET | `/list?sessionId&path` | 列一层目录（目录优先，符号链接解析出类型） |
| POST | `/upload?sessionId&path&name&overwrite` | 请求体按 `application/octet-stream` 流式落盘；`name` 可带 `a/b/c` 子路径 |
| GET | `/download?sessionId&path[&inline=1]` | 下载文件，支持 `Range` |
| GET | `/zip?sessionId&path` | 把目录打成流式 ZIP 下载 |
| POST | `/mkdir` | JSON `{sessionId, path}` |
| POST | `/move` | JSON `{sessionId, from, to, overwrite?}` |
| POST | `/copy` | JSON `{sessionId, from, to, overwrite?}` |
| POST | `/delete` | JSON `{sessionId, paths: []}` |

成功统一回 `{ "ok": true, "value": … }`，失败回 `{ "ok": false, "error": { code, message, details } }` 并带对应状态码（`outside-workspace` 403、`exists` 409、`upload-too-large` 413…）。

## 安全模型

- **认证与来源**：每条路由先向组合的 `connection.requestRejection()` 要一次裁决——Host/Origin 栅栏 + 浏览器会话 cookie，和官方 `/api` 同一道门；没有 `connection` 的组合作拒绝处理而不是裸奔。
- **CSRF**：所有变更类请求还要求自定义头 `x-dsh-fm: 1`，跨站表单设不了这个头。
- **工作区约束**：路径按会话 `cwd`（无则 `sandboxPolicy.workspaceRoot`）解析，绝对路径同样要落在根内；`..` 爬不出去；解析后还会对现实路径复核，**指向工作区外的符号链接一律拒绝**（下载、打包、删除、重命名都走同一套判定）。
- **覆盖**：上传/移动默认不覆盖，冲突回 `exists`，由浏览器侧确认后显式 `overwrite`。
- **上限**：单次上传 16 GiB（`maxUploadBytes`）、列目录 5000 条、ZIP 最多 60000 项 / 4 GiB（ZIP32 限制）。

## 配置

profile patch 里按条目改（`config` 是整表替换，按需抄齐）：

```yaml
- id: file-manager
  config:
    maxUploadBytes: 17179869184
    maxListEntries: 5000
    zipMaxEntries: 60000
    zipMaxBytes: 4294967294
```

## 已知限制

- **不做断点续传**：上传失败只能整文件重传；下载靠浏览器 + `Range` 自行续。
- **`/copy` 未加载时的回落**：宿主半边的 `/copy` 路由要随 dsh 重启生效；未生效前粘贴会退回「下载 + 重新上传」的方式（目录会逐层递归），结果一致但慢，重启后自动走服务端复制。
- **ZIP 是 ZIP32**：超过 4 GiB 或 60000 项会明确报错，而不是产出坏包。
- **没有权限位/属主编辑**：SFTP 的 `chmod/chown` 不在范围内。
- **跟随工作区**：只管理当前会话的工作区；管理别的目录需要该会话把 `cwd` 指过去。
- **接管而非并列**：面板是同一个 `files` 类型，自带实现被覆盖到插件卸载为止；两者不会同时出现两个文件面板。

## 开发

```bash
cd dsh-file-manager
ln -s ~/.dsh/profiles/web/node_modules node_modules   # 只为跑测试取 schemastery
node --test test/*.test.mjs
```

- `test/host.test.mjs`：起真实 HTTP 服务、真实临时工作区，覆盖上传/覆盖/越界/符号链接/下载 Range/ZIP 解压校验/改名/删除/上限。
- `test/client.test.mjs`：用假 `__ModuleLoader__` + 迷你 React 桩验证页签与两个动作席位的注册、注入与渲染。
