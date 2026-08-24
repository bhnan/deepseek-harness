# 教师教学工作日历（Teacher Calendar）

道德与法治教师专用教学日历：跨年级授课（初一、小学四年级）、多班级排班备课、固定课表 + 临时调课。
以 DSH 插件形态长进 Web GUI（当前为独立可运行版本，后端路由与插件 host 半边同构，迁移零改动）。

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 启动后端 API（http://127.0.0.1:8787，首次启动自动写入种子数据）
npm run dev

# 3. 另开终端启动前端（http://localhost:5173）
npm run dev:web
```

首次启动自动生成 `data/` 目录（学期注册表 + 全局资产 + 学期隔离目录），含示例数据（2026 秋季第一学期、8 个班级、固定课表、师生生日、素养词库 25 条）。

## 运行测试

```bash
npm test        # vitest：日历核心引擎 20 条单测（周数/进度/顺延/临时调课合并/日期工具）
```

## 目录结构

```text
teacher-calendar/
├── src/
│   ├── engine/            # 日历核心引擎（纯函数，无 IO；前后端共用）
│   │   ├── date.js        #   日期工具（ISO 语义，防时区偏移）
│   │   ├── week.js        #   R1 周数计算 + R6 学期进度
│   │   ├── shift.js       #   R3 授课内容序列顺延（单班链式后移）
│   │   └── merge.js       #   R4 临时调课合并（当周生效，临时优先）
│   ├── components/        # React 组件（TopBar / WeekView / MonthView / SemesterView / Modal）
│   ├── api.js             # 前端唯一数据通道（未来迁移 DSH host 路由仅改 base）
│   ├── App.jsx            # 应用骨架（视图切换/学期/主题/撤销恢复）
│   └── styles.css         # 五套主题 token + 日期底色三层级
├── server/
│   ├── index.mjs          # Express API（/api/calendar/*，与 DSH host 半边同构）
│   ├── storage.mjs        # JSON 存储：原子写入（tmp+rename）+ manifest 完整性 + 撤销栈
│   └── seed.mjs           # 种子数据（默认学期/班级/课表/生日/素养词库/节假日表）
├── tests/                 # 引擎单测（对齐规则护栏文档验收标准）
├── docs/                  # 需求文档集（唯一开发标准，与工作台原件同步）
└── data/                  # 运行时数据（git 忽略，学期隔离目录）
```

## 核心业务语义

- **学期总周数口径**（R1）：第 1 周 = 开学日所在周（周一起始），开学前不计数，跨年连续累加。
- **授课内容序列顺延**（R3）：某班某课时内容被替换 → 该班后续内容链式后移一个课时位，最后一条追加到该班下一课时位；仅影响该班，其他班级与课时槽位不动；整条链原子（越界即拒绝）。
- **临时调课**（R4）：绑定生效周，仅当周生效，下周自动恢复固定排课；当周视图 = 固定排课 ⊕ 临时调课（引擎合并输出）。
- **撤销/恢复**（R5）：所有写操作入撤销栈（操作快照，上限 100），按学期隔离；顺延/批量导入为单个栈项。
- **素养推送**（C2）：按日期键控（`by_date[当日]`），无重复推送持久化承诺，类别轮转 + 类内随机。

## 热插拔（改代码不重启）

| 层 | 机制 | 生效方式 |
|----|------|---------|
| 独立应用后端 | `node --watch`（npm run dev） | 改 `server/` 自动重启 |
| 独立应用前端 | Vite HMR | 改 `src/` 浏览器即时热更 |
| 引擎单测 | `vitest` watch | 改动自动重跑 |
| DSH 插件条目 | cordis HMR（已覆盖启用，见 docs/plugin-hotplug） | 改 `cordis.patch.yml` 热加载/卸载，无需重启 dsh（激活需一次性重启） |
| 桥接插件更新 | `node scripts/build-bridge.mjs --install` | 刷新浏览器页面生效 |

详见 `docs/2026-08-19-teacher-calendar-plugin-hotplug.md`。

## 需求文档

完整需求规范见 `docs/`（9 份文档：总览 / 前端需求 / 数据需求 / Schema 规范 / 规则护栏 / 内容库规范 / 用户故事 / 测试点清单 / 热插拔规范）。
