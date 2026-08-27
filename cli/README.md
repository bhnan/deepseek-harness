# tc —— 教学日历 + 学生成长档案 统一 Agent CLI

一句话：`tc` 让 AI Agent（和你）不查任何接口文档，就能安全操作教学日历（:8787）与学生成长档案（:8797）。所有写操作走应用 API（自动进撤销栈），业务正确性由服务端裁决。

## 0. Agent 使用姿势（三步）

```bash
node cli/tc.mjs discover        # ① 拿到全部命令、参数约定、退出码、信封格式
node cli/tc.mjs health          # ② 确认两个后端在线
node cli/tc.mjs schedule show -s 2026年秋季 --week 1   # ③ 直接干活（名称可模糊，多义会给候选清单）
```

- stdout **恒为单个 JSON**：成功 `{ok:true,...}`；失败 `{ok:false,error:{code,message,detail}}`
- 退出码：`0` 成功｜`2` 用法错误｜`3` 服务端拒绝/校验失败｜`4` 服务不可达｜`5` 名称多义
- 写命令一律先加 `--dry-run` 看将提交什么，确认后去掉重跑即真正落库（可经 GUI/undo 撤销）

## 1. 命令速查（16 个）

```text
tc discover                                    # 能力自描述（Agent 永远从这里开始）
tc health                                      # 双服务连通性
tc semester list                               # 学期列表 + 当前学期
tc semester create --name N --start-date D --end-date D
tc schedule show  -s <学期> [--week N | --date D | --current]
tc course add     -s <学期> -c <班级> --weekday 1-7 --period N [--week odd|even|N|N,M]
tc content batch  -s <学期> --rows <JSON> | --file <JSON文件>     # 支持 class_name
tc content prefill -s <学期> -c <班级> --contents "<a;b;c>" | --file <文件>
tc docx import    --file <手册.docx> [--semester-name N --semester-start D --semester-end D] [--dry-run]
tc class list     [--role homeroom|subject] [--stage primary|middle]
tc student list   -c <班级> [--keyword K]
tc exam list      -c <班级> [--type placement|weekly|monthly|midterm|final|mock|subject|other]
tc exam create    -c <班级> --name N --type T --date D [--note 注]
tc grades import  -c <班级> (--exam-id ID | --exam-name 名称 [--create] [--type T] [--date D])
                  (--rows '<JSON>' | --csv 成绩表.csv) [--dry-run]
tc analysis student -c <班级> --student 张三
tc analysis class   -c <班级> [--exam-id ID]
```

通用参数：`-s`=学期、`-c`=班级、`--semester=...`、`--class=...` 等价；环境变量
`TC_CALENDAR_API` / `TC_PORTFOLIO_API` 可覆盖服务地址；`--pretty` 美化 JSON 输出。

## 2. 成绩导入的三种喂法

```bash
# A. 长表 CSV：姓名,科目,分数[,班级排名,年级排名]
tc grades import -c 初一(3)班 --exam-name 道法随堂2 --create --type weekly --date 2026-11-12 --csv scores.csv

# B. 宽表 CSV：首列姓名，其余列名=科目（缺考留空自动跳过）
tc grades import -c 初一(3)班 --exam-id pf_exm_xxx --csv 宽表成绩.csv --dry-run

# C. 直接给 JSON（与服务端 batch 同构，支持 question_scores 题型分）
tc grades import -c 初一(3)班 --exam-id pf_exm_xxx --rows '[{"student_name":"郑一","subject":"道法","score":88,"question_scores":{"选择":30}}]'
```

导入是**整批原子**的：CLI 先本地预检（未知学生/分数越界/同名冲突一次性全量列出，不发请求），
通过后由服务端二次整批校验（任何行非法 → 整批拒绝零落库）。成功后自动附各科 count/avg 回读摘要。

## 3. 测试

```bash
node cli/selftest.mjs            # 离线 20 项（零依赖，任何机器可跑）；加 --live 附带连通探测
npm test -- tests/cli.test.mjs   # 仓库 vitest 双保险
```

## 4. DSH 原生工具

`@bhn/teacher-tools` 插件（`~/.dsh/plugins/teacher-tools/`）把核心 8 命令注册为会话原生工具
（`tc_*` 前缀），实现上只是转发本 CLI——逻辑唯一来源仍是这里。注册与重启说明见
`docs/agent-cli/` 产物文档。

## 5. 已知边界

- docx 导入的目标学期可用参数覆盖（缺省沿用历史 2025 春季映射）；仓库暂无样例 docx，
  A1 冒烟该行记 SKIP，提供真实手册文件后可补全量验证
- 名称解析：精确 → 包含，唯一命中即用；多义返回候选清单（exit 5），**绝不猜测**
- `schedule show` 命中的节假日顺延同步是服务端幂等行为（只读查询可能触发一次顺延落库）
- `--file/--csv` 可读取本进程权限内任意路径（单机信任环境的既定约定；子进程均为数组式
  参数、无 shell 注入面）
- 撤销端点未包装为 tc 命令：需要时直接 `POST /api/calendar/undo {current_semester_id}`
- 仅一次考试时 `analysis student` 的 status 标签不构成趋势判断（CLI 会附 note 提醒）
