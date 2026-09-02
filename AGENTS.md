# 本目录即源码真身（Git 管理，单源）

`/root/apps/teacher-calendar/` 是 8787（教学日历）与 8797（学生成长档案，`portfolio/`）两个 systemd 服务的实际运行目录，**同时是受 Git 管理的唯一源码**（master 分支）。不要再把它当作"部署副本"去别处同步——2026-09-02 起运行时仓库即单源真身，历史仓库 `dsh-github/teacher-dashboard/` 仅为归档。

## 修改流程（单源后简化）

1. 直接在本目录改代码（改完 `git status` 检查，`git diff` 自查）。
2. 前端改动：`npm run build`（两个 vite.config 已内置 `base=/calendar/`、`/portfolio/`，勿删）。
3. server 改动：`systemctl restart teacher-calendar` / `systemctl restart student-portfolio`；
   `cli/tc.mjs` 改动：无需重启（teacher-tools 每次现调）。
4. 提交：`git commit`（勿提交 `data/`、`node_modules/`、`dist/`、备份目录——学生隐私数据已在 .gitignore）。
5. 双路验证：直连端口 + GUI 前缀路径（`/calendar/*`、`/portfolio/*` 经 apps-proxy 剥前缀转发）。

## 关联组件（不在本仓库，见 `/root/.dsh/plugins/AGENTS.md`）

- teacher-tools / apps-proxy 等插件源：`/root/.dsh/plugins/`（同样新建了 Git 仓库）
- GUI 面板桥：源与构建产物在 `/root/.dsh/plugins/teacher-*-bridge/`，profile 内为 symlink
- 插件挂载注册表：`/root/.dsh/profiles/web/cordis.patch.yml`
- 自启动：`/etc/systemd/system/dsh-web.service`（GUI 3080）
