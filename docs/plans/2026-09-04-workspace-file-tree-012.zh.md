# 工作区文件树与预览实现计划

[English](2026-09-04-workspace-file-tree-012.md) | 中文

> **给 Claude：** 必须使用子技能：用 superpowers:executing-plans 逐项执行本计划。

**目标：** 为 0.1.2 Web 侧栏添加一个已认证、有边界的工作区文件树与应用内预览。

**架构：** 在现有 workspace-controller 包内添加 `workspaceFiles` Remote controller，使列出与预览独立于原生或浏览 picker 的选择。添加一个侧栏槽位和一个仅浏览器端的 `ui-file-tree` 包；它消费生成的 Remote API，并复用 session controller 现有的系统打开动作。保持 0.1.2 BrowserAuth 和信任栅栏不变。

**技术栈：** TypeScript、Cordis、Typert Remote、Node `fs/promises`、React、Vitest、pnpm。

---

### 任务 1：用失败测试建立 Host 文件浏览合约

**文件：**

- 新建：`packages/api/workspace-controller/tests/workspace-files.host.spec.ts`
- 修改：`packages/api/workspace-controller/src/types.ts`

**步骤 1：编写失败测试**

添加一个 Host Remote 测试 fixture，它加载 `WorkspaceController` 并调用生成的 `workspaceFiles` namespace。覆盖以下可观察结果：

```text
list(<absolute temp directory>) returns independently sorted dirs and files
list() caps each group at maxEntries and marks each truncated group
list() includes an enterable directory symlink but excludes a file symlink
read(<text file>) returns a UTF-8 head and truncated=true after 256 KiB
read(<small recognised image>) returns image/base64/MIME
read(<binary or oversized image>) returns binary without content
read(<relative or directory path>) returns workspace-files/unreadable
an aborted list/read returns gateway/cancelled
```

**步骤 2：运行测试以确认它失败**

运行：`pnpm exec vitest run packages/api/workspace-controller/tests/workspace-files.host.spec.ts`

预期：失败，因为 `ctx.remote.workspaceFiles` 及其结果类型尚不存在。

**步骤 3：仅添加客户端安全的负载类型**

将 `WorkspaceFileEntry`、`WorkspaceFileLevel` 与 `WorkspaceFilePreview` 添加到 `src/types.ts`。它们只能包含 JSON 安全字段，并区分文本、图片和二进制预览种类。

**步骤 4：重新运行聚焦测试**

运行：`pnpm exec vitest run packages/api/workspace-controller/tests/workspace-files.host.spec.ts`

预期：它仍因缺少 Host service 而失败，证明该测试执行的是计划中的 Remote API 而不是一个本地 helper。

**步骤 5：提交红色合约测试**

运行：

```text
git add packages/api/workspace-controller/tests/workspace-files.host.spec.ts packages/api/workspace-controller/src/types.ts
git commit -m "test: specify bounded workspace file remote"
```

### 任务 2：实现有边界的 `workspaceFiles` Remote controller

**文件：**

- 新建：`packages/api/workspace-controller/src/workspace-files.ts`
- 修改：`packages/api/workspace-controller/src/index.ts`
- 修改：`packages/api/workspace-controller/package.json`
- 修改：`packages/api/workspace-controller/tsconfig.host.json`
- 修改：`packages/api/workspace-controller/tsconfig.client.json`

**步骤 1：实现能让任务 1 变绿的最小 Host service**

创建 `WorkspaceFilesController extends TypertRemoteService`，service key 为 `workspaceFilesController`，namespace 为 `workspaceFiles`。从 `WorkspaceController` 通过 `ctx.plugin(WorkspaceFilesController)` 挂载它。

```text
@Remote('list') list(path, signal) -> WorkspaceFileLevel
@Remote('read') read(path, signal) -> WorkspaceFilePreview
```

两个方法都拒绝当前平台上不是完整路径的 path。`list` 将目录条目流式写入两个独立、按名称排序且有上限的窗口。`read` 读取不超过文本/图片策略所要求的字节数，并把本地错误转换为 `RemoteError`；在分类本地错误前检查 abort signal。

**步骤 2：运行聚焦 Host 测试**

运行：`pnpm exec vitest run packages/api/workspace-controller/tests/workspace-files.host.spec.ts`

预期：通过。

**步骤 3：运行相邻 controller 套件**

运行：`pnpm exec vitest run packages/api/workspace-controller/tests`

预期：通过，工作区命令或 directory-picker transport 没有回归。

**步骤 4：提交 Host 实现**

运行：

```text
git add packages/api/workspace-controller
git commit -m "feat: expose bounded workspace file remote"
```

### 任务 3：组装生成的 Remote contribution 和客户端 double

**文件：**

- 修改：`packages/api/remotes/src/client/index.ts`
- 修改：`packages/api/remotes/package.json`
- 修改：`packages/api/remotes/tsconfig.client.json`
- 修改：`packages/client/connection/src/client/fixture.ts`
- 修改：`packages/client/connection/tests/fixture.client.spec.ts`
- 修改：`tsconfig.client.json`

**步骤 1：编写失败的客户端 fixture 断言**

断言浏览器 fixture 暴露确定性的 `workspaceFiles.list` 和 `workspaceFiles.read` 回答，包括精确的生成 Remote 结果形状。

**步骤 2：运行聚焦 fixture 测试以确认它失败**

运行：`pnpm exec vitest run packages/client/connection/tests/fixture.client.spec.ts`

预期：失败，因为 namespace 尚未挂载，或 fixture 尚无 handler。

**步骤 3：让 contribution 可达**

经 `api-remotes` 重新导出 workspace-file 类型，更新其 client 项目引用，并仅为浏览器组装扩展确定性的 connection fixture。保持 `api-remotes` 选择既有 workspace-controller contribution；不要添加手写 RPC bridge。

**步骤 4：重新运行 fixture 与生成构建检查**

运行：

```text
pnpm exec vitest run packages/client/connection/tests/fixture.client.spec.ts
pnpm exec tsc -b packages/api/workspace-controller/tsconfig.host.json packages/api/remotes/tsconfig.client.json
```

预期：通过。

**步骤 5：提交 Remote 组装**

运行：

```text
git add packages/api/remotes packages/client/connection tsconfig.client.json
git commit -m "feat: assemble workspace file remote for clients"
```

### 任务 4：用失败的 shell 测试声明侧栏文件树槽位

**文件：**

- 修改：`packages/client/ui-sidebar/src/client/contract/slots.ts`
- 修改：`packages/client/ui-sidebar/src/client/index.ts`
- 修改：`packages/client/ui-sidebar/src/client/SidebarRoot.tsx`
- 修改：`packages/client/ui-sidebar/src/client/SidebarRoot.module.css`
- 修改：`packages/client/ui-sidebar/tests/apply.client.spec.tsx`
- 修改：`packages/client/ui-sidebar/tests/sidebar-root.client.spec.tsx`
- 修改：`packages/client/ui-sidebar/tests/sidebar-snapshot.client.spec.tsx`
- 修改：`packages/client/ui-sidebar/tests/__snapshots__/sidebar-snapshot.client.spec.tsx.snap`

**步骤 1：编写失败测试**

规定 `sidebar.filetree` 是 `sidebar` 的一个 root-scope `single` 子项，只在侧栏宽屏时渲染，且无人占用时不留下布局空隙。

**步骤 2：验证 shell 测试为红色**

运行：`pnpm exec vitest run packages/client/ui-sidebar/tests/sidebar-root.client.spec.tsx packages/client/ui-sidebar/tests/apply.client.spec.tsx`

预期：失败，因为槽位还没有被声明或渲染。

**步骤 3：实现最小槽位和布局**

添加槽位 owner 合约，并在工作区浏览器和页脚之间渲染它。让其区域成为列宽最多 40%、内部可滚动的带状区域；在折叠窄栏中省略该区域。

**步骤 4：验证侧栏包**

运行：`pnpm exec vitest run packages/client/ui-sidebar/tests`

预期：在有意审查 snapshot 更新后通过。

**步骤 5：提交 shell 变更**

运行：

```text
git add packages/client/ui-sidebar
git commit -m "feat: reserve sidebar file tree slot"
```

### 任务 5：以测试优先方式添加文件树 UI 包

**文件：**

- 新建：`packages/client/ui-file-tree/package.json`
- 新建：`packages/client/ui-file-tree/tsconfig.json`
- 新建：`packages/client/ui-file-tree/tsdown.config.ts`
- 新建：`packages/client/ui-file-tree/src/index.ts`
- 新建：`packages/client/ui-file-tree/src/client/index.ts`
- 新建：`packages/client/ui-file-tree/src/client/contract/slots.ts`
- 新建：`packages/client/ui-file-tree/src/client/FileTreePanel.tsx`
- 新建：`packages/client/ui-file-tree/src/client/FileTreePanel.module.css`
- 新建：`packages/client/ui-file-tree/src/client/locales.ts`
- 新建：`packages/client/ui-file-tree/src/css-modules.d.ts`
- 新建：`packages/client/ui-file-tree/tests/apply.client.spec.ts`
- 新建：`packages/client/ui-file-tree/tests/file-tree-panel.client.spec.tsx`
- 修改：`tsconfig.client.json`

**步骤 1：在包实现前编写组件和 apply 测试**

围绕 `ctx.remote.workspaceFiles.list/read` 与 `ctx.remote.session.openWorkspacePath` 定义一个小型注入面。覆盖根目录选择、惰性展开/折叠缓存、重试、刷新、根重置、在替代/卸载时中止请求、文本预览、图片预览、二进制回退、预览错误、Escape 关闭，以及尽力的系统打开。

**步骤 2：验证新测试正确地失败**

运行：`pnpm exec vitest run packages/client/ui-file-tree/tests`

预期：失败，因为包与 `sidebar.filetree` 注册者尚不存在。

**步骤 3：以最小方式实现包**

使用 `ctx.slots.inject('sidebar.filetree', ...)`，使加载顺序与 HMR 声明替换保持安全。通过标准 selector hook 读取 sessions 与 workspaces，把查看状态保留在 `FileTreePanel` 内，并在注入边界对 `RemoteResult.ok` 分支。不要持久化缓存层级，也不要经静态路由发送原始文件系统读取。

**步骤 4：运行包测试和客户端类型检查**

运行：

```text
pnpm exec vitest run packages/client/ui-file-tree/tests
pnpm exec tsc -b packages/client/ui-file-tree
```

预期：通过。

**步骤 5：提交 UI 包**

运行：

```text
git add packages/client/ui-file-tree tsconfig.client.json
git commit -m "feat: add workspace file tree preview UI"
```

### 任务 6：组合浏览器 bundle 并记录已交付设计

**文件：**

- 修改：`packages/bundle/web-app/cordis.patch.yml`
- 修改：`packages/bundle/web-app/package.json`
- 新建：`.agents/notes/implemented/feature/2026-09-04-workspace-file-tree-and-preview.md`
- 新建：`.agents/notes/implemented/feature/2026-09-04-workspace-file-tree-and-preview.zh.md`
- 新建：`.agents/notes/implemented/feature/2026-09-04-workspace-file-tree-and-preview.i18n.yaml`
- 修改：当其公开 Remote 合约改变时，修改所属 API Gateway 或包 README 及其中文/i18n 配对文件

**步骤 1：编写失败的浏览器组装测试，或扩展既有 Web 冒烟测试**

验证默认 Web bundle 暴露 client module，并且能在未改动、受 BrowserAuth 保护的 `/api` 路由旁挂载它。

**步骤 2：验证组装测试为红色**

运行：`pnpm exec vitest run packages/bundle/web-app/tests`

预期：失败，因为 bundle 既不依赖也未列出 `ui-file-tree`。

**步骤 3：组合并写文档**

添加浏览器 roster 行和 workspace 依赖。用现在时写一份配对的已实现 Agent Note：记录边界、活动根规则、使用 `session.openWorkspacePath`，以及所有调用仍穿过 0.1.2 BrowserAuth 与信任栅栏这一事实。

**步骤 4：运行聚焦及仓库要求的检查**

运行：

```text
pnpm run test:gui
DSH_SNAPSHOT=replay pnpm run test:web
pnpm run verify-doc-budgets
pnpm run verify-md-links
pnpm run verify-translation-pairing
```

预期：通过。如果浏览器 snapshot 有变动，在接受前检查它。

**步骤 5：提交组合与文档**

运行：

```text
git add packages/bundle/web-app .agents/notes packages/api/workspace-controller/README.md packages/api/remotes/README.md docs
git commit -m "feat: compose workspace file tree in web app"
```

### 任务 7：最终验证与交接

**文件：**

- 只验证；不新增生产变更。

**步骤 1：检查分支 diff 和工作树**

运行：

```text
git status --short --branch
git diff dsh-v0.1.2-rc.1...HEAD --check
git log --oneline dsh-v0.1.2-rc.1..HEAD
```

预期：只有上面的六个限定 commit、没有空白错误，也没有无关的用户变更。

**步骤 2：显式确认认证保留**

运行：`git diff dsh-v0.1.2-rc.1...HEAD -- packages/client/connection`

预期：没有 diff。该功能必须继续使用当前 `/api` BrowserAuth 路由。

**步骤 3：在交接中记录最终测试证据**

报告分支名、commit range、聚焦测试结果、GUI/Web 结果，以及任何剩余的手动浏览器检查。未经用户批准，不要推送分支。
