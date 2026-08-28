# TODO List

## 侧边栏

- [ ] 调整展开状态下的底部入口顺序：其他插件入口 → 文件 → 设置。
  - 当前顺序：文件 → 其他插件入口 → 设置。
  - 修改 `packages/client/ui-sidebar/src/client/SidebarRoot.tsx` 中 `sidebar.footer.action`、`sidebar.filetree` 与 `sidebar.settings` 的渲染位置，并同步更新样式、测试、快照和双语文档。
  - 保持文件树仅在展开状态显示、高度不超过侧边栏的 40%、内部可滚动；折叠状态不显示文件树。
