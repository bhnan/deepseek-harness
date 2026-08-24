# 教师教学工作日历 —— 热插拔规范（DSH 集成与开发热重载）

日期：2026-08-19
状态：v1。定义"改代码/改配置不重启服务"的分层机制与操作规范。

## 1. 分层热更新总览

| 层 | 机制 | 生效方式 | 状态 |
|----|------|---------|------|
| 日历独立应用 · 后端 | `node --watch`（npm run dev） | 改 `server/` 代码 → 自动重启（PID 不变，子进程重启） | ✅ 已启用 |
| 日历独立应用 · 前端 | Vite HMR | 改 `src/` 代码 → 浏览器即时热更（组件局部更新，不刷新页面） | ✅ 已启用 |
| 日历独立应用 · 单测 | `vitest` / `npm run test:watch` | 改引擎代码 → 自动重跑 | ✅ 已启用 |
| DSH 插件条目（热插拔） | cordis-plugin-hmr | 改 `cordis.patch.yml` 增删插件条目 → 热加载/卸载，**无需重启 dsh** | ✅ 已实测（隔离实例验证） |
| DSH 插件 bundle 更新 | client-hmr / 页面刷新 | 重建 bundle → 刷新浏览器页面生效 | ✅ 页面刷新即可 |

## 2. DSH 侧热插拔（配置层）

### 2.1 机制

DSH 的 cordis loader 支持配置级热重载（`cordis-plugin-hmr`），但 **web-app bundle 默认禁用了它**（`dsh-web-app/cordis.patch.yml` 中 `- id: hmr / disabled: true`，官方 TODO：reload 生命周期测试通过后再启用）。

本 profile 已在 `cordis.patch.yml` **覆盖启用**：

```yaml
- id: hmr
  disabled: false
```

**一次性激活要求**：HMR 无法热加载它自己——本条目生效需要 dsh 重启一次。重启后：

- `cordis.patch.yml` 中新增插件条目 → 自动热加载（无需重启）
- 删除插件条目 → 自动热卸载（unload 自动恢复样式/资源）
- 修改插件 config → 热重载该条目

### 2.2 桥接插件（teacher-calendar-bridge）

- 包位置：**profile node_modules**（`~/.dsh/profiles/web/node_modules/@bhn/teacher-calendar-bridge/`）——实测确认 cordis loader 从 profile 目录解析插件（`imported from <profile>/`），npx 运行时 node_modules 不是解析位置
- 职责：侧栏 `sidebar.footer.action` 注册「📅 教学日历」入口 + `shell.overlay` 注册全屏面板（iframe 嵌入 `http://localhost:5173` 独立应用）
- client 半边导出形态对齐内部插件：`module.exports = { apply, inject }`（`__ModuleLoader__.load` 包装）；host 半边 `function apply() {}` 空实现
- **list 型 slot 注册必须带 `options.id`**（`sidebar.footer.action`/`shell.overlay` 均为 list kind），且 React 需经 `import React from 'react'`（esbuild external → `require("react")`）
- **更新流程**：改 `plugins/bridge/src/` → `node scripts/build-bridge.mjs --install` → 刷新浏览器页面（无需重启 dsh）

### 2.3 实测验证记录（2026-08-19，隔离实例 DSH_HOME=/tmp/dsh-test，端口 3081）

| 验证项 | 结果 |
|--------|------|
| 桥插件进入 roster（`window.__DSH_BOOT__.entries`） | ✅ 39 条含 `@bhn/teacher-calendar-bridge` |
| 侧栏「📅 教学日历」入口 | ✅ 出现 |
| 点击入口 → shell.overlay 全屏面板 | ✅ iframe 嵌入 `http://localhost:5173`，标题 + 关闭按钮正常 |
| 日历应用在 iframe 内加载 | ✅ CDP target 可见 `iframe | http://localhost:5173/` |
| 关闭面板 | ✅ 正常移除 |
| 控制台错误 | ✅ 零错误 |
| **热卸载**：删除 cordis.patch.yml 条目 → roster 39→38 | ✅ 无需重启 |
| **热加载**：加回条目 → roster 38→39 | ✅ 无需重启 |

### 2.4 回滚

```bash
# 备份恢复
cp /tmp/cordis.patch.yml.bak ~/.dsh/profiles/web/cordis.patch.yml
# 或仅移除桥插件条目 + 包
rm -rf /Users/bhn/.npm/_npx/6c7f445d1bf61956/node_modules/@bhn/teacher-calendar-bridge
```

## 3. 独立应用热重载（开发主循环）

```bash
npm run dev        # 后端：node --watch（改 server/ 自动重启）
npm run dev:web    # 前端：Vite（改 src/ 自动 HMR）
npm run test:watch # 引擎单测：改动自动重跑
```

日历功能迭代**全部走独立应用热重载**（秒级生效）；DSH 侧只承载入口与面板壳，极少改动。

## 4. 操作清单

| 场景 | 操作 | 重启？ |
|------|------|--------|
| 改日历功能代码 | 编辑 `src/` / `server/` | ❌ 无（HMR / --watch） |
| 增删日历相关插件 | 编辑 `cordis.patch.yml` | ❌ 无（HMR，激活后） |
| 更新桥接插件 UI | `node scripts/build-bridge.mjs --install` + 刷新页面 | ❌ 无 |
| 首次启用 HMR 机制 | （一次性）重启 dsh | ✅ 仅此一次 |

## 5. 风险与注意事项

- HMR 为官方 TODO 项（web reload 生命周期未完整测试）；如重载后出现异常，回滚方式见 §2.3，或恢复 `disabled: true`。
- 插件条目热加载失败时只影响该条目（guard facade + unload 恢复机制），不扩散到其他插件。
- `data/` 为运行时数据（git 忽略），热重载不影响数据安全（原子写入）。
