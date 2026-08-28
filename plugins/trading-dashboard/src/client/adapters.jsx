/** 资产 → 统一实体模型适配（schema 规范 §2.8：叶子/聚合实体四件套）。
 *  存储层源字段原样；呈现层统一为 {name, market?, ticker?, change_percent, last_price,
 *  pe?, pb?, market_cap?, sparkline?, member_count?, members?}。
 */

export function adaptIndex(row) {
  // index_spot：代码 sh000001 / 名称 / 最新价 / 涨跌幅 / 成交额
  return {
    kind: "index",
    ticker: String(row["代码"]).slice(2),
    market: String(row["代码"]).slice(0, 2),
    name: row["名称"],
    last_price: Number(row["最新价"]),
    change_percent: Number(row["涨跌幅"]),
    amount: Number(row["成交额"]),
    volume: Number(row["成交量"]),
  };
}

export function adaptIndustry(row) {
  // sw_l1_spot：指数代码 801080 / 指数名称 / 最新价 / derived.change_pct / 成份个数 / 估值
  return {
    kind: "sector",
    ticker: String(row["指数代码"]),
    name: row["指数名称"],
    last_price: Number(row["最新价"]),
    change_percent: Number(row["derived"]?.change_pct),
    pe: Number(row["TTM(滚动)市盈率"]),
    pb: Number(row["市净率"]),
    member_count: Number(row["成份个数"]),
    amount: Number(row["成交额"]),
    dividend_yield: Number(row["静态股息率"]),
  };
}

export function adaptStock(row) {
  // a_spot：代码 sh600519 / 名称 / 最新价 / 涨跌幅 / 昨收 / 成交额 / 换手？(无)
  return {
    kind: "stock",
    ticker: String(row["代码"]).slice(2),
    market: String(row["代码"]).slice(0, 2),
    name: row["名称"],
    last_price: Number(row["最新价"]),
    change_percent: Number(row["涨跌幅"]),
    prev_close: Number(row["昨收"]),
    amount: Number(row["成交额"]),
    volume: Number(row["成交量"]),
  };
}

export function adaptStrategy(s) {
  // signals：strategy_id/strategy_name/derived{change_pct?, constituents?, signal_note?, dsl_status?}
  return {
    kind: "strategy",
    ticker: s.strategy_id,
    name: s.strategy_name,
    change_percent: s.derived?.change_pct != null ? Number(s.derived.change_pct) : null,
    signal_note: s.derived?.signal_note,
    dsl_status: s.derived?.dsl_status,
    dsl_rules: s.derived?.dsl_rules,
    members: (s.derived?.constituents || []).map((c) => ({
      ticker: String(c.symbol), name: c.name, weight: c.weight,
    })),
  };
}

/** 统一实体卡（叶子/聚合共用）：名称 + 现价 + 涨跌幅 + 指标 + 聚合成员数/成员。 */
export function EntityCard({ e, onClick }) {
  const color = e.change_percent == null ? null : e.change_percent > 0 ? C.up : e.change_percent < 0 ? C.down : C.sub;
  const style = {
    flex: "1 1 170px", maxWidth: 270, minWidth: 170, background: C.panel,
    border: `1px solid ${C.border}`, borderRadius: 10, padding: 14,
    cursor: onClick ? "pointer" : "default",
    boxShadow: "0 1px 2px rgba(31,39,51,0.05)",
  };
  return onClick ? hx("div", { style, onClick },
    hx("div", { style: { fontSize: 14, color: C.text } }, e.name),
    hx("div", { style: { fontSize: 20, fontWeight: 700, margin: "6px 0 2px", color: C.text } },
      e.last_price != null ? (e.last_price >= 100 ? Number(e.last_price).toFixed(1) : Number(e.last_price).toFixed(2)) : "--"),
    hx("div", { style: { fontSize: 13, color: color || C.sub, fontWeight: 600 } },
      e.change_percent == null ? "--" : (e.change_percent > 0 ? "+" : "") + Number(e.change_percent).toFixed(2) + "%"),
    hx("div", { style: { fontSize: 12, color: C.sub, marginTop: 8 } },
      [
        e.pe != null ? `PE ${Number(e.pe).toFixed(1)}` : null,
        e.pb != null ? `PB ${Number(e.pb).toFixed(1)}` : null,
        e.amount != null ? `额 ${(Number(e.amount) / 1e8).toFixed(0)}亿` : null,
        e.member_count != null ? `${e.member_count} 只成分` : null,
      ].filter(Boolean).join(" · ")),
    e.signal_note ? hx("div", { style: { fontSize: 12, color: C.warn, marginTop: 6 } }, e.signal_note) : null,
    e.members?.length ? hx("div", { style: { fontSize: 12, color: C.sub, marginTop: 6 } },
      "成分: " + e.members.map((m) => m.name || m.ticker).slice(0, 4).join("、") + (e.members.length > 4 ? "…" : "")) : null
  ) : null;
}

import { createElement as hx } from "react";
import { C } from "./ui.jsx";
