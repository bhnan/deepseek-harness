/** 前端读入校验（测试点 X1 TS 侧）：zod 核心字段守卫。
 *  解析失败 → 抛错 → 页面降级显示"数据异常"占位，绝不带病渲染。
 *  覆盖当前 7 页消费的资产；完整 29 schema 镜像为 P1 加固项（验收报告 L2 说明）。
 */
import { z } from "zod";

const num = z.number();
const code = z.string();

const indexItem = z.object({ 代码: code, 名称: z.string(), 最新价: num, 涨跌幅: num }).passthrough();
const stockItem = z.object({ 代码: code, 名称: z.string(), 最新价: num, 涨跌幅: num }).passthrough();
const industryItem = z.object({
  指数代码: z.union([z.string(), z.number()]),
  指数名称: z.string(),
  最新价: num,
  derived: z.object({ change_pct: num }).passthrough(),
}).passthrough();
const signalStrategy = z.object({
  strategy_id: z.string(),
  strategy_name: z.string(),
  derived: z.object({}).passthrough(),
}).passthrough();

const schemas = {
  index_spot: z.object({ data: z.object({ indices: z.array(indexItem) }) }),
  a_spot: z.object({
    data: z.object({
      stocks: z.array(stockItem),
      derived: z.object({ market_breadth: z.object({}).passthrough() }).passthrough(),
    }),
  }),
  sw_l1_spot: z.object({ data: z.object({ industries: z.array(industryItem) }) }),
  review: z.object({
    data: z.object({
      summary: z.string(),
      regime: z.string(), trend: z.string(), risk_level: z.string(),
      market: z.object({ amount: num, breadth: z.object({}).passthrough() }).passthrough(),
      news: z.array(z.object({}).passthrough()),
      sector: z.object({ leading_sectors: z.array(z.object({}).passthrough()),
                         lagging_sectors: z.array(z.object({}).passthrough()) }).passthrough(),
    }).passthrough(),
  }),
  signals: z.object({
    data: z.object({
      status: z.string(),
      scanned_count: z.number(),
      strategies: z.array(signalStrategy),
    }),
  }),
  announcements: z.object({
    data: z.object({
      announcements: z.array(z.object({ 公告标题: z.string() }).passthrough()),
      flashes: z.array(z.object({}).passthrough()),
      derived: z.object({ coverage_note: z.string() }).passthrough(),
    }),
  }),
};

export function assetNameOf(path) {
  return String(path).split("/").pop().replace(".json", "");
}

/** 按资产名校验；未知资产放行（如 latest/lab 端点）。失败抛 ZodError。 */
export function parseAsset(name, json) {
  const schema = schemas[name];
  if (!schema) return json;
  return schema.parse(json);
}


const SEV_ORDER = { high: 0, medium: 1, low: 2 };

/** 公告 + 快讯合并为统一时间线（纯函数，可单测）。 */
export function mergeNewsItems(data) {
  const d = data?.data || data || {};
  const anns = (d.announcements || [])
    .slice()
    .sort((a, b) => (SEV_ORDER[a.derived?.severity] ?? 2) - (SEV_ORDER[b.derived?.severity] ?? 2))
    .map((a) => ({
      kind: "news",
      date: String(a["公告时间"] || "").slice(0, 10),
      title: a["公告标题"],
      source: "cninfo",
      summary: a.derived?.note,
      symbol: a.derived?.symbol || "",
    }));
  const flashes = (d.flashes || []).map((f) => ({
    kind: "news",
    date: String(f["发布日期"] || ""),
    title: f["标题"],
    source: f["发布日期"] ? "快讯" : "新浪快讯",
    summary: f.derived?.note || String(f["内容"] || "").slice(0, 60),
    symbol: "",
  }));
  return [...anns, ...flashes].sort((a, b) => String(b.date).localeCompare(String(a.date)));
}
