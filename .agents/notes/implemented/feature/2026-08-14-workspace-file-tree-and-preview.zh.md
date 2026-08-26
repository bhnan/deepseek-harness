# Agent Note: 工作区文件树与应用内文件预览

Status: implemented

[English](2026-08-14-workspace-file-tree-and-preview.md) | 中文

## 问题

web GUI 展示会话与工具输出，却没有工作区文件的视图：操作者跟进 agent（智能体）的工作时，得离开浏览器去终端或编辑器里看磁盘上有什么、某个文件现在的内容。侧边栏需要一棵以当前活动 Workspace 为根的只读文件树，外加快速的应用内预览——既不能新造一套与宿主已有服务重复的文件系统协议面，也不能把 GUI 浏览耦合到模型的 `ctx.fs` 约束栈上。现有原语差在两处：`host.listDirectory` 只返回目录（它为[工作区选择对话框](../architecture/2026-07-28-directory-picker-capability-seam.zh.md)而建），而读取文件内容的协议方法根本不存在——会话日志承载的是工具输出，从不是任意文件。

## 决策

### 列举以增量方式搭载 browse 能力

`DirectoryPickerBrowseCapability.list` 增加第三个参数 `DirectoryListOptions`；`{ files: true }` 让列举额外携带该层级的直接子常规文件，即 `DirectoryListing` 上可选的 `files`／`filesTruncated` 字段，`host.listDirectory` 也获得对应的可选布尔 `files`。请求与响应两侧的新增全部可选，因此选择对话框、其协议 schema 往返以及所有既有消费方均不受影响——这次 seam 扩展纯属增量，忽略该选项的后端只要省略字段就仍满足约定。

### 两个有界窗口

在 `BrowseDirectoryPicker` 中，文件走目录窗口旁自己的 `maxEntries + 1` 流式窗口，遵循同一套纪律（按名排序的头部、O(maxEntries) 内存、二分插入且满窗尾部单次比较即拒绝、隐藏 = POSIX 点前缀约定）。窗口分开意味着文件众多的层级不会驱逐目录行，反之亦然；每组各报自己的截断（`truncated`／`filesTruncated`）。文件窗口只收 dirent 已直接证明是常规文件的行：跟随文件符号链接会给每次列举的每个候选加一次 stat 探测，因此链接后的文件不会出现（目录符号链接保留既有的「跟随以判定可进入」探测）。

### 预览是 HostApi 上的特权网关读取

`host.readFile` 位于网关的 `HostApi` 上，而不是选择器能力上：为展示读取文件不是选目录交互，预览也绝不能随组合的选择器后端而改变行为。它同样不属于 `ctx.fs`——沿用选择器 seam 记录过的权限域裁决；模型的约束栈永远不得改变 GUI 行为。读取在能知道完整结果的服务端设界：至多 256 KiB 的 UTF-8 文本头部并以 `truncated` 标注截断，按扩展名识别的图片整幅 base64 编码、不超过 8 MiB 并附 `mime`，其余一切——头部含 NUL、超限图片——以 `kind: 'binary'` 拒绝且不带内容，客户端对此以 `host.openPath` 系统打开兜底应答。非完全限定的路径（与 browse 列举同一道栅栏：任何协议值都不得针对宿主进程 cwd 或 Windows 当前盘符解析）、不可读或非常规文件的目标以新错误码 `file-unreadable` 失败；中止映射为 `cancelled`。该方法加入 dsh-client-connection 的 `PRIVILEGED_METHODS`：读取任意宿主文件系统内容，敏感度不低于其旁的 settings／credentials 面，因此回环可直接访问，已声明的 `trustedHosts` 权威则要求部署在 RPC bridge 前完成鉴权。

### 侧边栏区带与面板

ui-sidebar 新声明一个 `single` 根作用域的洞 `sidebar.filetree`——位于浏览区域与页脚之间、仅宽态渲染、高度不超过栏高 40% 的区带，空置时不渲染任何内容。新包 `@deepseek-ai/dsh-client-ui-file-tree` 经 `ctx.slots.inject` 注册面板，以基于 `ctx.workspaces` 的普通回调注入 `listLevel`／`readFile`／`openPath`，并注册 `filetree` locale 命名空间（zh 默认／en）。树根是当前活动 Session 所属 Workspace 的路径，否则该 Session 记录的 cwd，再否则什么都没有；层级在展开时惰性加载，每个树根生命周期内每层只取一次（显式重试除外），树根变化硬重置缓存。展开状态、缓存层级与打开的预览都是组件本地查看状态——不持久，也不进任何 store。

### 原生选择器缺口及其后续方向

`host.listDirectory` 只在 `browse` 能力下受理，因此在 `native` 后端下面板的首次拉取应答 `directory-picker-unavailable`，渲染为可重试的错误行。[`-auto` 选择器](2026-07-29-directory-picker-adaptive-default.zh.md)在桌面回环部署上解析为 `native`——这正是出厂默认——于是默认桌面组合看到的恰是该错误态。后续方向是把层级列举与选择 seam 解耦：能力联合辨识的是操作者如何*挑选*目录，而只读树什么都不挑，因此列举原语要么归入所有后端都能受理的能力（Node 标准库对它们全都可用），要么与 `host.readFile` 一起放到网关上。在此落地之前，该限制记录于[包 README](../../../../packages/client/ui-file-tree/README.zh.md)。

## 考虑过的替代方案

**用文件树与预览读取扩展 `ctx.fs`。** 否决，理由选择器 seam 已记录过：更换模型的文件系统后端绝不能改变 GUI 行为，且用于展示的列举／预览不是存储原语。

**新开一个列举 RPC，而不是在 `host.listDirectory` 上加选项。** 否决：第二个方法会复制有界窗口扫描、完全限定路径栅栏和错误映射，区别只在是否包含文件；增量选项复用这一切，选择对话框对该变化毫无感知。

**为带文件的浏览新增一个选择器能力 kind。** 否决：联合类型辨识的是操作者交互形态，带文件的浏览与浏览是同一种交互；新 kind 会迫使组合在选择对话框与文件树之间二选一。

**用静态文件路由而非 RPC 提供预览。** 否决：GET 路由会落在 `/api` 一元路径之外，而按方法划分的特权集与请求 schema 都在那里；RPC 原样搭载既有载体、校验、中止传播与特权方法信任策略。

**在客户端截断预览。** 按现行的设界规则否决：限制施加在能知道完整结果之处，把不设界的文件送过协议线再在浏览器里截断，正是该规则点名的漏洞。

**在文件窗口中跟随符号链接文件。** 否决：每次列举每个候选一次 stat 探测，让所有消费方为树并不区别渲染的行买单；改记为包的已知限制。

**持久化展开状态。** 暂且否决：面板是对随时在变的文件系统的实时查看辅助，恢复一份深层展开会重新拉取没人要的过期层级；组件本地状态让缓存生命周期等于挂载生命周期。

## 后果

- 协议新增一个可选请求字段、两个可选列举字段、`host.readFile` 方法与 `file-unreadable` 错误码；每项新增要么可选要么全新，既有客户端与后端无需重新校验。
- 变更全程冻结选择对话框的约定——增量选项让选目录消费方观察不到这次扩展。
- 在原生选择器下，文件树显示可重试错误而非内容，而这恰是 auto 选择器默认瞄准的部署；列举解耦的后续工作负责修复。
- `host.readFile` 使用特权方法信任策略：回环可直接访问，已声明的 `trustedHosts` 权威则只能在部署鉴权层之后访问。

## 测试

connection fixture（测试前置数据）对 `host.readFile` 应答确定性的文本头部，让无密钥的组装浏览器覆盖可回放；test-support 的 workspaces 测试替身记录 `readFile` 调用，并可为图片、二进制与错误流程打桩。覆盖遵循 GUI 分层图：browse 后端套件在既有目录窗口用例旁钉住第二个窗口的界限、分组独立截断与符号链接文件排除；网关套件钉住预览界限、限定路径栅栏与 `file-unreadable`／`cancelled` 映射；组件规格经测试替身驱动面板的惰性加载、重试、重置与预览各状态。
