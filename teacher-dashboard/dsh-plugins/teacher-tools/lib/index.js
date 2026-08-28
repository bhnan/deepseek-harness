/**
 * @bhn/teacher-tools — 把教师工作台 CLI（tc）注册为 DSH 原生工具。
 *
 * 设计（spec.md §6）：仅转发。每个工具 = execFile node <cliPath> <args>，stdout JSON 原样回传。
 * CLI 自身保证：stdout 恒为 {ok:true,...} / {ok:false,error:{code,message,detail}} 信封，
 * 逻辑与业务校验唯一来源是 tc.mjs（走应用 HTTP API，撤销栈/原子写在服务端）。
 */
import { execFileSync } from "node:child_process";
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";

const name = "teacher-tools";
const inject = ["tools"];

const Config = z.object({
  cliPath: z.string().default("/root/apps/teacher-calendar/cli/tc.mjs"),
  timeoutMs: z.number().default(60000),
});

// 工具定义表：tool 名 / 描述 / 参数（与 tc discover 输出一致）
// b=布尔开关（出现即 true）；其余为字符串取值参数
const TOOLS = [
  {
    tool: "tc_discover",
    cli: [],
    description: "输出 tc CLI 全部命令能力清单（命令/参数约定/JSON信封/退出码）。第一次使用 tc 体系前先调这个。",
    args: [],
  },
  {
    tool: "tc_health",
    cli: ["health"],
    description: "教学日历(8787)与学生成长档案(8797)两个后端服务的连通性与摘要。",
    args: [],
  },
  {
    tool: "tc_semester_list",
    cli: ["semester", "list"],
    description: "学期列表（含当前学期标记）。返回 id/名称/起止日期。",
    args: [],
  },
  {
    tool: "tc_schedule_show",
    cli: ["schedule", "show"],
    description: "查询某学期的周课表合并视图（固定排课⊕临时调课⊕节假日停课⊕内容/事件/生日）。semester 可传 id 或名称子串（如「2026年秋季」）。",
    args: [
      { key: "semester", flag: "--semester", required: true, description: "学期 id / 名称子串 / current" },
      { key: "week", flag: "--week", description: "周数（1 起）" },
      { key: "date", flag: "--date", description: "YYYY-MM-DD，自动换算所在周" },
      { key: "current", flag: "--current", b: true, description: "按今天所在周查询" },
    ],
  },
  {
    tool: "tc_content_batch",
    cli: ["content", "batch"],
    description: "授课内容批量 upsert。rows 为 JSON 数组：[{class_name|class_id, week, weekday(1-7), period, content}]。服务端部分成功语义：返回 success/failed/errors 明细。",
    args: [
      { key: "semester", flag: "--semester", required: true, description: "学期 id / 名称子串" },
      { key: "rows", flag: "--rows", description: "JSON 数组字符串" },
      { key: "file", flag: "--file", description: "或传 JSON 文件路径" },
      { key: "dry_run", flag: "--dry-run", b: true, description: "只解析与校验，零写入" },
    ],
  },
  {
    tool: "tc_grades_import",
    cli: ["grades", "import"],
    description: "成绩导入：学生姓名自动解析 ID（同名会要求消歧）；本地预检全量报错（不发请求）；服务端整批原子（任一行非法整批拒绝）；成功后自动附各科均分摘要。rows 元素：{student_name|student_id, subject, score, class_rank?, grade_rank?, question_scores?}。",
    args: [
      { key: "class", flag: "--class", required: true, description: "档案班级 id / 名称" },
      { key: "exam_id", flag: "--exam-id", description: "已存在考试 id" },
      { key: "exam_name", flag: "--exam-name", description: "或按名称匹配考试" },
      { key: "create", flag: "--create", b: true, description: "考试不存在时自动创建（配合 type/date）" },
      { key: "type", flag: "--type", description: "weekly/monthly/midterm/final/mock/subject/placement/other" },
      { key: "date", flag: "--date", description: "YYYY-MM-DD（create 用）" },
      { key: "rows", flag: "--rows", description: "JSON 数组字符串" },
      { key: "csv", flag: "--csv", description: "或传 CSV 文件路径（长表/宽表自动识别）" },
      { key: "note", flag: "--note", description: "考试备注（create 用）" },
      { key: "dry_run", flag: "--dry-run", b: true, description: "零写入，返回将提交行数与样例" },
    ],
  },
  {
    tool: "tc_analysis_class",
    cli: ["analysis", "class"],
    description: "班级学情分析：平均分/优秀率/及格率/分数段分布/各科统计（缺省最近一次考试）。",
    args: [
      { key: "class", flag: "--class", required: true, description: "档案班级 id / 名称" },
      { key: "exam_id", flag: "--exam-id", description: "指定考试" },
    ],
  },
  {
    tool: "tc_analysis_student",
    cli: ["analysis", "student"],
    description: "学生个人学情分析：历次成绩趋势/进退步/薄弱点。student 传姓名（同班会要求消歧）。",
    args: [
      { key: "class", flag: "--class", required: true, description: "档案班级 id / 名称" },
      { key: "student", flag: "--student", required: true, description: "学生姓名 / 学号 / id" },
    ],
  },
];

function runCli(cliPath, args, timeoutMs) {
  try {
    const out = execFileSync(process.execPath, [cliPath, ...args], {
      timeout: timeoutMs,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: process.env,
    });
    try { return JSON.parse(out); }
    catch { return { ok: false, error: { code: "UPSTREAM_ERROR", message: "CLI 输出非 JSON", detail: { stdout: out.slice(0, 400) } } }; }
  } catch (e) {
    // CLI 约定：失败时 stdout 仍是合法信封 → 优先透传
    if (e.stdout) {
      try { return JSON.parse(e.stdout); } catch { /* fallthrough */ }
    }
    return {
      ok: false,
      error: {
        code: e.killed ? "UPSTREAM_ERROR" : "UPSTREAM_ERROR", // 超时(killed)按 spec §8 统一归 UPSTREAM_ERROR
        message: String(e.stderr || e.message || "tc 执行失败").trim().slice(0, 400),
        detail: { exit_code: e.status ?? null, ...(e.killed ? { reason: "timeout" } : {}) },
      },
    };
  }
}

function apply(ctx, config = {}) {
  const cliPath = config.cliPath || "/root/apps/teacher-calendar/cli/tc.mjs";
  const timeoutMs = config.timeoutMs || 60000;

  const disposers = TOOLS.map((t) => {
    const parameters = {};
    for (const a of t.args) {
      parameters[a.key] = a.b
        ? { type: "boolean", description: a.description }
        : { type: "string", description: a.description, ...(a.required ? { required: true } : {}) };
    }
    return ctx.tools.register(defineTool({
      name: t.tool,
      description: t.description,
      parameters,
      output: {
        schema: { type: "object", additionalProperties: true },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 1) }],
      },
      execute: async (args = {}) => {
        const argv = [...t.cli];
        for (const a of t.args) {
          const v = args[a.key];
          if (a.b) { if (v === true) argv.push(a.flag); continue; }
          if (v === undefined || v === null || v === "") continue;
          argv.push(a.flag, String(v));
        }
        return runCli(cliPath, argv, timeoutMs);
      },
    }));
  });

  ctx.on("dispose", () => {
    for (const d of disposers) {
      if (typeof d === "function") d();
    }
  });
}

export { Config, apply, inject, name };
export default { Config, apply, inject, name };
