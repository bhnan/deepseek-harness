# @bhn/trading-dashboard — DeepSeek Harness 交易看板插件

嵌入 DeepSeek Harness Web 的 **A 股盘后看板插件**：侧边栏底部 📈 按钮展开覆盖面板，
把盘后数据管道每日产出的行情 / 板块 / 事件 / 信号 / 复盘数据，与 lab 研究仓库的
策略生命周期对象，组织成可点击下钻的可视化界面。只读，不写任何数据。

## 功能页签（8 个）

| 页签 | 内容 |
|---|---|
| 大盘概览 | 指数卡、市场宽度、Agent 盘后复盘（regime/trend/risk 徽标）、申万一级行业涨跌榜（点击下钻板块） |
| 板块 | 31 申万一级行业列表（涨跌幅/PE/成交额）+ 行业 K 线（日/周/月）+ 成分股领涨领跌与涨跌家数统计，点击成分股下钻个股 |
| 个股 | 代码/名称搜索、K 线、简单技术分析（近 5/20/60 日、MA 形态）、相关公告/新闻 |
| 组合 | 自选分组等权聚合净值 K 线 + 模拟盘净值 vs 基准与持仓表 |
| 信号 | DSL 策略扫描状态与规则、配对候选板块（可跳转）、前向跟踪候选、聚合 K 线 |
| 新闻 | 公告（自选范围）+ 快讯合并时间线，点击弹详情 |
| 实验室 | Idea → Signal → Experiment → Conclusion（→ Strategy）生命周期浏览；点击结论摘要弹出完整详情（支撑证据/局限/适用条件/失败条件/下一步实验/回测路径） |
| 定时 | dsh 进程内定时任务表：立即运行 / 启用停用 |

## 目录结构

```text
├── build.mjs              # esbuild 打包 → client.js（__ModuleLoader__.load 自注册包装）
├── src/
│   ├── index.jsx          # client 入口：sidebar 按钮 + 模块级单例看板（杜绝多实例堆叠）
│   ├── app.jsx            # 8 页签应用（页面/弹层/布局手术）
│   ├── ui.jsx             # 通用 UI 组件 + 10 种 viz 渲染器（浅色高对比，红涨绿跌）
│   ├── adapters.jsx       # 数据资产 → 统一实体模型适配
│   ├── validate.js        # zod 前端守卫（异常降级空态，不带病渲染）+ 新闻时间线合并
│   ├── report.js          # 客户端错误上报（host 落文件日志）
│   ├── host.js            # host 半边：/api/trading 路由注册、定时任务、热插拔、日志
│   ├── route.js           # 数据路由：data/ 只读 JSON + lab 白名单 + 日线导出（路径越界防护）
│   ├── cron.js            # dsh 进程内定时任务服务（交易日感知）
│   ├── hotreload.js       # client 源码变更 → 自动 rebuild → 客户端版本轮询热刷新
│   └── logger.js          # 按天文件日志
```

## 安装与运行

1. 依赖构建：`pnpm install && node build.mjs`（产物 `client.js`，被 .gitignore 忽略，由构建/热插拔维护）。
2. 作为 cordis 插件加载本目录（或安装到 `~/.dsh/profiles/web/node_modules/@bhn/trading-dashboard`）。
3. host 默认配置（可在插件 config 覆盖）：
   - `dataRoot`：数据根目录（默认 `/root/bhn/trading/data`）
   - `repoRoot`：研究仓库根（默认 `/root/bhn/trading`，日线导出脚本所在）
   - `python`：导出脚本用的解释器（默认 `.venv/bin/python`）
   - `labRoot`：生命周期仓库（默认 `${repoRoot}/lab`）
   - `hotReload`：默认开启，监听 `src/client` 变更自动重建

## 数据约定

- 只读：`/api/trading/*` 仅暴露 `data/` 下的 JSON 资产、lab 白名单列表、个股/行业/聚合日线导出。
- 板块成分股行情来自管道预计算的 `sector/<date>/members_spot.json`；自选与信号成分行情来自
  `market/<date>/quotes_subset.json`（两者结构均为 `{schema_version, data: {...}}`，前端解两层 `.data`）。
- 板块成交额（申万实时快照）单位为**百万元**，前端换算为亿展示。
- 旧日期缺失的资产自动回退最近有数据交易日；核心资产经 schema 校验，异常时显示空态而非带病渲染。
