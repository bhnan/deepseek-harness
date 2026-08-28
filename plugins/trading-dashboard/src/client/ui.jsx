/** 公共 UI 与 viz 渲染器（10 种，字段与 schemas/viz/*.json 对齐）。
 *  浅色高对比主题：白卡片 + 深灰文字 + 红涨绿跌（A股习惯）。所有颜色走 C 调色板。
 */
import { createElement as h, Fragment } from "react";

export const C = {
  bg: "#eef1f6",        // 页面底色（不透明）
  panel: "#ffffff",     // 卡片
  border: "#d8dfe8",    // 边框
  text: "#1f2733",      // 主文字
  sub: "#55617a",       // 次级文字
  up: "#d43d32",        // 涨（红）
  down: "#1f9d55",      // 跌（绿）
  accent: "#2f6fdb",    // 强调蓝
  warn: "#b7791f",      // 警示橙
  fill: "#e9edf3",      // 输入框/按钮底色
  fillActive: "#d6e1f2",
  hairline: "#eef1f5",  // 表格分隔线
};

export const fmt = (v, digits = 2) => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(digits) : "--";
};
export const fmtPct = (v) => (Number.isFinite(Number(v)) ? (v > 0 ? "+" : "") + Number(v).toFixed(2) + "%" : "--");
export const toneColor = (v) => (Number(v) > 0 ? C.up : Number(v) < 0 ? C.down : C.sub);

export function Card({ title, children, style }) {
  return h("section", { style: { background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, ...style } },
    title ? h("h3", { style: { fontSize: 13, color: C.sub, fontWeight: 600, margin: "0 0 12px" } }, title) : null,
    children);
}

export function Badge({ text, kind }) {
  const bg = { ok: "#e4f6ec", warn: "#fdf3e0", bad: "#fde8e6", info: "#e7effb" }[kind] || C.fill;
  const fg = { ok: "#1f7a4d", warn: "#9a6a12", bad: "#b3372c", info: "#2f5fa8" }[kind] || C.sub;
  return h("span", { style: { background: bg, color: fg, borderRadius: 5, padding: "1px 8px", fontSize: 12 } }, text);
}

export function Stat({ label, value, color }) {
  return h("div", { style: { flex: "0 0 auto" } },
    h("div", { style: { fontSize: 16, fontWeight: 700, color: color || C.text } }, value),
    h("div", { style: { fontSize: 12, color: C.sub } }, label));
}

export function Empty({ text }) {
  return h("div", { style: { color: C.sub, padding: 28, textAlign: "center", fontSize: 13 } }, text || "暂无数据");
}

export function Table({ columns, rows, rowKey, onRowClick, selectedKey }) {
  return h("table", { style: { width: "100%", borderCollapse: "collapse", fontSize: 13 } },
    h("thead", null, h("tr", null, columns.map((c) =>
      h("th", { key: c.key, style: { color: C.sub, textAlign: "left", fontWeight: 600, padding: "8px", borderBottom: `1px solid ${C.border}` } }, c.label)))),
    h("tbody", null, rows.map((r, i) => {
      const selected = selectedKey != null && r[rowKey] === selectedKey;
      return h("tr", { key: rowKey ? r[rowKey] : i, "data-table-row": rowKey ? String(r[rowKey]) : undefined,
          onClick: onRowClick ? () => onRowClick(r) : undefined,
          style: {
            cursor: onRowClick ? "pointer" : undefined,
            background: selected ? C.fillActive : undefined,
            boxShadow: selected ? `inset 3px 0 0 ${C.accent}` : undefined,
          } },
        columns.map((c) => h("td", { key: c.key, style: { padding: "9px 8px", borderBottom: `1px solid ${C.hairline}`, fontWeight: selected ? 700 : undefined } },
          c.render ? c.render(r) : String(r[c.key] ?? "--"))));
    })));
}

/* ================= viz 渲染器（{kind, payload}） ================= */

export function VizBlock({ block, onItemClick }) {
  if (!block || !block.kind) return h(Empty, { text: "空 viz 块" });
  const { kind, payload = {} } = block;
  try {
    switch (kind) {
      case "kpi_row": return h(KpiRow, { payload });
      case "hbar_rank": return h(HbarRank, { payload });
      case "line": return h(LineChart, { payload });
      case "table": return h(TableViz, { payload });
      case "sparkline": return h(Sparkline, { payload });
      case "donut": return h(Donut, { payload });
      case "quote_card": return h(QuoteCard, { payload });
      case "timeline": return h(Timeline, { payload, onItemClick });
      case "bar": return h(BarChart, { payload });
      case "price_kline": return h(PriceKline, { payload });
      default:
        return h("div", { style: { color: C.warn } }, `未知 viz kind: ${kind}（护栏：明确报错）`);
    }
  } catch (e) {
    return h("details", { style: { color: C.sub, fontSize: 12 } },
      h("summary", null, "viz 渲染失败，已降级为原始数据"),
      h("pre", { style: { maxHeight: 160, overflow: "auto" } }, JSON.stringify(block, null, 1)));
  }
}

function KpiRow({ payload }) {
  return h("div", { style: { display: "flex", gap: 18, flexWrap: "wrap" } },
    (payload.items || []).map((it, i) => {
      const color = it.tone === "positive" ? C.up : it.tone === "negative" ? C.down : C.text;
      return h("div", { key: i, style: { flex: "0 0 auto" } },
        h("div", { style: { fontSize: 12, color: C.sub } }, it.label),
        h("div", { style: { fontSize: 17, fontWeight: 700, color } }, it.value ?? "--"),
        it.delta ? h("div", { style: { fontSize: 12, color: C.sub } }, it.delta) : null);
    }));
}

function Hbar({ items, color }) {
  const max = Math.max(...items.map((i) => Math.abs(Number(i.value))), 1);
  return h("div", null, items.map((it, i) => h("div", { key: i, style: { display: "flex", alignItems: "center", gap: 8, padding: "4px 0" } },
    h("span", { style: { width: 90, fontSize: 13, flex: "0 0 auto", overflow: "hidden", whiteSpace: "nowrap" } }, it.label),
    h("div", { style: { flex: 1, height: 9, background: C.fill, borderRadius: 4, overflow: "hidden" } },
      h("div", { style: { width: `${(Math.abs(Number(it.value)) / max) * 100}%`, height: "100%", background: color, borderRadius: 4 } })),
    h("span", { style: { width: 58, textAlign: "right", fontSize: 13, flex: "0 0 auto", color } }, fmtPct(it.value)))));
}

function HbarRank({ payload }) {
  return h("div", { style: { display: "flex", gap: 24, flexWrap: "wrap" } },
    payload.gainers?.length ? h("div", { style: { flex: 1, minWidth: 220 } },
      h("div", { style: { fontSize: 12, color: C.sub, marginBottom: 6 } }, "领涨"),
      h(Hbar, { items: payload.gainers, color: C.up })) : null,
    payload.losers?.length ? h("div", { style: { flex: 1, minWidth: 220 } },
      h("div", { style: { fontSize: 12, color: C.sub, marginBottom: 6 } }, "领跌"),
      h(Hbar, { items: payload.losers, color: C.down })) : null);
}

function LineChart({ payload }) {
  const series = payload.series || [];
  const all = series.flatMap((s) => s.points || []);
  if (!all.length) return h(Empty, { text: "无序列数据" });
  const min = Math.min(...all.map((p) => Number(p.value)));
  const max = Math.max(...all.map((p) => Number(p.value)));
  const span = max - min || 1;
  const n = Math.max(...series.map((s) => (s.points || []).length));
  const W = 560, H = 180, PAD = 24;
  const x = (i) => PAD + (i / (n - 1 || 1)) * (W - 2 * PAD);
  const y = (v) => H - PAD - ((Number(v) - min) / span) * (H - 2 * PAD);
  return h("div", null,
    h("svg", { width: "100%", viewBox: `0 0 ${W} ${H}`, style: { display: "block" } },
      series.map((s, si) => h("polyline", {
        key: si, fill: "none",
        stroke: [C.accent, C.up, C.down, C.warn][si % 4], strokeWidth: 1.8,
        points: (s.points || []).map((p, i) => `${x(i)},${y(p.value)}`).join(" "),
      })),
      h("line", { x1: PAD, y1: H - PAD, x2: W - PAD, y2: H - PAD, stroke: C.border })),
    h("div", { style: { display: "flex", gap: 14, fontSize: 12, color: C.sub, marginTop: 6 } },
      series.map((s, si) => h("span", { key: si }, `■ ${s.label}`))));
}

function TableViz({ payload }) {
  return h(Table, {
    columns: (payload.columns || []).map((c) => ({ key: c.key, label: c.label })),
    rows: payload.rows || [],
  });
}

function Sparkline({ payload }) {
  const pts = payload.points || [];
  const vals = pts.map((p) => Number(p.value));
  if (vals.length < 2) return h(Empty, { text: "数据不足" });
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const W = 120, H = 34;
  const xy = vals.map((v, i) => `${(i / (vals.length - 1)) * W},${H - 4 - ((v - min) / span) * (H - 8)}`).join(" ");
  const color = vals[vals.length - 1] >= vals[0] ? C.up : C.down;
  return h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
    h("svg", { width: W, height: H }, h("polyline", { fill: "none", stroke: color, strokeWidth: 1.6, points: xy })),
    payload.change_percent != null ? h("span", { style: { fontSize: 13, color: toneColor(payload.change_percent) } }, fmtPct(payload.change_percent)) : null);
}

function Donut({ payload }) {
  const slices = payload.slices || [];
  const total = Math.max(slices.reduce((a, s) => a + Math.abs(Number(s.value)), 0), 1e-9);
  const R = 56, r = 30, Cx = 66, Cy = 66;
  let angle = 0;
  const arcs = slices.map((s) => {
    const frac = Math.abs(Number(s.value)) / total;
    const a0 = angle, a1 = angle + frac * Math.PI * 2;
    angle = a1;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (a, rr) => `${Cx + rr * Math.cos(a - Math.PI / 2)},${Cy + rr * Math.sin(a - Math.PI / 2)}`;
    return h("path", { key: s.key, d: `M ${p(a0, R)} A ${R} ${R} 0 ${large} 1 ${p(a1, R)} L ${p(a1, r)} A ${r} ${r} 0 ${large} 0 ${p(a0, r)} Z`, fill: [C.accent, C.up, C.down, C.warn, "#7a6ff0"][slices.indexOf(s) % 5] });
  });
  return h("div", { style: { display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" } },
    h("svg", { width: 132, height: 132 }, arcs),
    h("div", null, slices.map((s) => h("div", { key: s.key, style: { fontSize: 13, padding: "3px 0" } },
      `${s.label}  ${(Math.abs(Number(s.value)) / total * 100).toFixed(1)}%`))));
}

function QuoteCard({ payload }) {
  return h(Card, { title: payload.name_zh || payload.ticker },
    h("div", { style: { display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" } },
      h("span", { style: { fontSize: 22, fontWeight: 700 } }, fmt(payload.last_price)),
      h("span", { style: { fontSize: 14, color: toneColor(payload.change_percent) } }, fmtPct(payload.change_percent)),
      h("span", { style: { fontSize: 12, color: C.sub } }, `${payload.ticker}.${(payload.market || "").toUpperCase()}`)),
    payload.pe != null || payload.pb != null ? h("div", { style: { display: "flex", gap: 14, marginTop: 10, fontSize: 13, color: C.sub } },
      payload.pe != null ? h("span", null, `PE(TTM) ${fmt(payload.pe)}`) : null,
      payload.pb != null ? h("span", null, `PB ${fmt(payload.pb)}`) : null,
      payload.market_cap != null ? h("span", null, `市值 ${fmt(payload.market_cap / 1e8, 0)} 亿`) : null) : null);
}

function Timeline({ payload, onItemClick }) {
  return h("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
    (payload.items || []).map((it, i) => h("div", { key: i, onClick: onItemClick ? () => onItemClick(it) : undefined,
      style: { borderLeft: `3px solid ${C.border}`, paddingLeft: 12, fontSize: 13, cursor: onItemClick ? "pointer" : "default" } },
      h("div", { style: { color: C.sub, fontSize: 12, marginBottom: 2 } }, `${it.date} · ${it.source || it.kind || ""}`),
      h("div", { style: { color: onItemClick ? C.accent : C.text } }, it.title),
      it.summary ? h("div", { style: { color: C.sub, fontSize: 12, marginTop: 2 } }, it.summary) : null)));
}

function BarChart({ payload }) {
  const cats = payload.categories || [];
  const series = payload.series || [];
  if (!cats.length) return h(Empty, { text: "无分类数据" });
  const max = Math.max(...series.flatMap((s) => s.values || []).map(Math.abs), 1);
  return h("div", { style: { display: "flex", gap: 8, alignItems: "flex-end", height: 140, paddingTop: 22 } },
    cats.map((c, i) => h("div", { key: c, style: { display: "flex", flexDirection: "column", alignItems: "center", gap: 4, flex: 1 } },
      h("div", { style: { display: "flex", gap: 2, alignItems: "flex-end", height: 100 } },
        series.map((s, si) => h("div", { key: si, title: `${s.label}: ${s.values?.[i]}`, style: { width: 12, height: `${(Math.abs(Number(s.values?.[i])) / max) * 100}px`, background: [C.accent, C.up][si % 2], borderRadius: "3px 3px 0 0" } }))),
      h("span", { style: { fontSize: 11, color: C.sub, transform: "rotate(-20deg)", whiteSpace: "nowrap" } }, c))));
}

function PriceKline({ payload }) {
  const bars = payload.bars || [];
  if (bars.length < 2) return h(Empty, { text: "K线数据不足" });
  const W = 640, H = 220, PAD = 10;
  const min = Math.min(...bars.map((b) => Number(b.low)));
  const max = Math.max(...bars.map((b) => Number(b.high)));
  const span = max - min || 1;
  const bw = Math.max(2, (W - 2 * PAD) / bars.length * 0.6);
  const x = (i) => PAD + (i + 0.5) * ((W - 2 * PAD) / bars.length);
  const y = (v) => 10 + (1 - (Number(v) - min) / span) * (H - 30);
  return h("svg", { width: "100%", viewBox: `0 0 ${W} ${H}`, style: { display: "block" } },
    bars.map((b, i) => {
      const up = Number(b.close) >= Number(b.open);
      const color = up ? C.up : C.down;
      const top = y(Math.max(Number(b.open), Number(b.close)));
      const hgt = Math.max(1, Math.abs(y(Number(b.open)) - y(Number(b.close))));
      return h("g", { key: i },
        h("line", { x1: x(i), y1: y(b.high), x2: x(i), y2: y(b.low), stroke: color, strokeWidth: 1 }),
        h("rect", { x: x(i) - bw / 2, y: top, width: bw, height: hgt, fill: color, opacity: 0.9 }));
    }),
    h("text", { x: 8, y: 14, fontSize: 11, fill: C.sub }, `${payload.ticker} ${bars[0].date} ~ ${bars[bars.length - 1].date}`));
}


/** 日线 → 周/月聚合（前端 resample，聚合只改显示不改数据）。 */
export function resampleBars(bars, granularity) {
  if (granularity === "day" || !bars || bars.length < 2) return bars;
  const key = (d) => {
    const dt = new Date(d + "T00:00:00");
    if (granularity === "week") {
      const onejan = new Date(dt.getFullYear(), 0, 1);
      const w = Math.ceil(((dt - onejan) / 86400000 + onejan.getDay() + 1) / 7);
      return `${dt.getFullYear()}-W${String(w).padStart(2, "0")}`;
    }
    return d.slice(0, 7);
  };
  const groups = new Map();
  for (const b of bars) {
    const k = key(b.date);
    const g = groups.get(k) || { date: b.date, open: b.open, high: -Infinity, low: Infinity, close: b.close, volume: 0 };
    g.high = Math.max(g.high, Number(b.high));
    g.low = Math.min(g.low, Number(b.low));
    g.close = b.close;
    g.volume += Number(b.volume || 0);
    g.date = b.date;   // 期末日
    groups.set(k, g);
  }
  return [...groups.values()].map((g) => ({ date: g.date, open: g.open, high: g.high, low: g.low, close: g.close, volume: g.volume || undefined }));
}

/** 日/周/月粒度切换。 */
export function GranularitySwitch({ value, onChange }) {
  const labels = { day: "日", week: "周", month: "月" };
  return h("div", { style: { display: "inline-flex", gap: 4, background: C.fill, borderRadius: 8, padding: 3 } },
    Object.keys(labels).map((g) => h("button", {
      key: g, onClick: () => onChange(g),
      style: { background: value === g ? C.panel : "transparent", border: 0, borderRadius: 6,
               color: value === g ? C.text : C.sub, padding: "4px 12px", cursor: "pointer",
               fontSize: 12, fontWeight: value === g ? 700 : 400,
               boxShadow: value === g ? "0 1px 2px rgba(31,39,51,0.15)" : "none" },
    }, labels[g])));
}


/** 粒度感知显示窗口：日线约1年、周线约4年、月线约10年。 */
export function sliceByGran(bars, gran) {
  const n = { day: 250, week: 200, month: 120 }[gran] || 250;
  return (bars || []).slice(-n);
}
