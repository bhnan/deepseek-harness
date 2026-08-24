"""观察假设验证：银行 ↔ 科技跷跷板（+ 煤炭延续性对比）。

用户观察：
1. 中国银行上涨 ↔ 科技股下跌（跷跷板/负相关）
2. 科技下跌阶段，银行涨幅较好
3. 煤炭在科技下跌期也涨，但延续性不如银行

验证设计（数据：data/sector/sw_daily.parquet，31 申万一级 2014~2026）：
- 科技合成 = 电子(801080) + 通信(801770) + 计算机(801750) 等权日收益
- 银行 = 801780，煤炭 = 801950
- 检验一（相关性）：银行 vs 科技 日收益相关系数（全期 + 近 3 年 + 近 1 年）
- 检验二（条件收益，跷跷板机制）：
  a) 科技大跌日（日收益 < -1%）：银行当日/次日平均收益 vs 全期
  b) 银行大涨日（日收益 > +1%）：科技当日平均收益
  c) 科技连跌 2 日阶段：银行阶段后 t+1 收益
- 检验三（延续性，银行 vs 煤炭）：
  科技下跌阶段（≤-2% 单日或连续 2 日跌）后，t+1~t+5 累计收益：
  银行 vs 煤炭（均值/中位数/胜率），对比谁的延续性更强

用法：python scripts/validate_bank_vs_tech.py

扩展（不改动上述三组检验的既有逻辑，仅新增）：
- 检验一·分阶段稳定性：按每 2 年一段（2014-2015 / 2016-2017 / 2018-2019 /
  2020-2021 / 2022-2023 / 2024-2026）输出银行 vs 科技日收益相关系数与样本天数，
  基于仅按 银行+科技 对齐的长窗（2014-02-21 起），不受其余板块 NaN 截断影响。
- 检验二/三·基准相对口径：若本地存在 data/market/index_daily.parquet 中的
  sh000905（中证500），新增超额收益口径（板块日收益 - 中证500日收益）下的
  条件收益与延续性统计；无本地文件则跳过并注明。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
SECTOR_DAILY = ROOT / "data" / "sector" / "sw_daily.parquet"
BENCH_INDEX = ROOT / "data" / "market" / "index_daily.parquet"
BANK, COAL, TECH = "801780", "801950", ["801080", "801770", "801750"]


def load() -> pd.DataFrame:
    df = pd.read_parquet(SECTOR_DAILY)
    df["日期"] = pd.to_datetime(df["日期"])
    closes = df.pivot_table(index="日期", columns="code", values="收盘", aggfunc="last").sort_index()
    closes.columns = closes.columns.astype(str)
    rets = closes.pct_change().dropna()
    rets["TECH"] = rets[TECH].mean(axis=1)
    return rets


def load_benchmark() -> pd.Series:
    """本地中证500（sh000905）日线收盘（data/market/index_daily.parquet）。

    若本地文件缺失返回空 Series，由调用方决定是否跳过基准相对口径。
    """
    if not BENCH_INDEX.exists():
        return pd.Series(dtype=float)
    idx = pd.read_parquet(BENCH_INDEX)
    idx["date"] = pd.to_datetime(idx["date"])
    zz = idx.loc[idx["code"] == "sh000905", ["date", "close"]].set_index("date")["close"].sort_index()
    return zz


def ttest(cond_rets: pd.Series, base_rets: pd.Series) -> dict:
    """条件样本 vs 全期基准：均值差 + t 统计量。"""
    c = cond_rets.dropna()
    b = base_rets.dropna()
    if len(c) < 10 or len(b) < 10:
        return {"n": len(c), "cond_mean_pct": None, "base_mean_pct": None, "diff_pct": None, "t": None}
    diff = c.mean() - b.mean()
    se = np.sqrt(c.var() / len(c) + b.var() / len(b))
    t = diff / se if se > 0 else 0.0
    return {"n": len(c), "cond_mean_pct": round(c.mean() * 100, 3),
            "base_mean_pct": round(b.mean() * 100, 3),
            "diff_pct": round(diff * 100, 3), "t": round(float(t), 2)}


def main():
    rets = load()
    r = rets
    print(f"样本: {r.index[0].date()} ~ {r.index[-1].date()}，{len(r)} 交易日\n")

    out = {}

    # ---- 检验一：相关性 ----
    corr_full = r[BANK].corr(r["TECH"])
    corr_3y = r[BANK].corr(r["TECH"]) if False else r.loc[r.index >= "2023-08-01"].pipe(lambda d: d[BANK].corr(d["TECH"]))
    corr_1y = r.loc[r.index >= "2025-08-01"].pipe(lambda d: d[BANK].corr(d["TECH"]))
    corr_coal = r[COAL].corr(r["TECH"])
    print("【检验一】日收益相关性（负=跷跷板）")
    print(f"  银行 vs 科技: 全期 {corr_full:.3f} | 近3年 {corr_3y:.3f} | 近1年 {corr_1y:.3f}")
    print(f"  煤炭 vs 科技: 全期 {corr_coal:.3f}")
    out["correlation"] = {"bank_tech_full": round(corr_full, 3), "bank_tech_3y": round(corr_3y, 3),
                          "bank_tech_1y": round(corr_1y, 3), "coal_tech_full": round(corr_coal, 3)}

    # ---- 检验一扩展：分阶段稳定性（每 2 年一段） ----
    # 长窗：仅按 银行+科技 对齐（不要求其余 26 板块同时有效），2014-02-21 起
    df0 = pd.read_parquet(SECTOR_DAILY)
    df0["日期"] = pd.to_datetime(df0["日期"])
    closes0 = df0.pivot_table(index="日期", columns="code", values="收盘", aggfunc="last").sort_index()
    closes0.columns = closes0.columns.astype(str)
    bt0 = closes0[[BANK] + TECH].dropna()
    bt_ret = bt0.pct_change().dropna()
    bt_ret["TECH"] = bt_ret[TECH].mean(axis=1)
    periods = [(2014, 2015), (2016, 2017), (2018, 2019), (2020, 2021), (2022, 2023), (2024, 2026)]
    corr_period = []
    print("\n【检验一·分阶段稳定性】银行 vs 科技 日收益相关系数（每 2 年一段）")
    for y0, y1 in periods:
        seg = bt_ret.loc[(bt_ret.index.year >= y0) & (bt_ret.index.year <= y1)]
        if len(seg) < 20:
            corr_period.append({"period": f"{y0}-{y1}", "n": len(seg), "corr": None})
            print(f"  {y0}-{y1}: n={len(seg)}（样本不足）")
            continue
        c = seg[BANK].corr(seg["TECH"])
        corr_period.append({"period": f"{y0}-{y1}", "n": len(seg), "corr": round(float(c), 3)})
        print(f"  {y0}-{y1}: corr {c:.3f} (n={len(seg)})")
    c_long = bt_ret[BANK].corr(bt_ret["TECH"])
    print(f"  长窗全期 {bt_ret.index[0].date()}~{bt_ret.index[-1].date()}: corr {c_long:.3f} (n={len(bt_ret)})")
    out["corr_by_period"] = {"window_start": str(bt_ret.index[0].date()), "window_end": str(bt_ret.index[-1].date()),
                             "n_total": len(bt_ret), "full_corr": round(float(c_long), 3), "periods": corr_period}

    # ---- 检验二：条件收益（跷跷板机制） ----
    base_bank = r[BANK]
    base_coal = r[COAL]
    print("\n【检验二】科技大跌日（<-1%）银行表现")
    tech_down = r[r["TECH"] < -0.01]
    bank_same = ttest(tech_down[BANK], base_bank)
    bank_next = ttest(r[BANK].shift(-1).loc[tech_down.index], base_bank)
    coal_same = ttest(tech_down[COAL], base_coal)
    print(f"  科技大跌日 {bank_same['n']} 天：银行当日 {bank_same['cond_mean_pct']}% (基准 {bank_same['base_mean_pct']}%, t={bank_same['t']})")
    print(f"  次日银行 {bank_next['cond_mean_pct']}% (t={bank_next['t']})；煤炭当日 {coal_same['cond_mean_pct']}% (t={coal_same['t']})")

    print("\n【检验二b】银行大涨日（>+1%）科技表现")
    bank_up = r[r[BANK] > 0.01]
    tech_same = ttest(bank_up["TECH"], r["TECH"])
    print(f"  银行大涨日 {tech_same['n']} 天：科技当日 {tech_same['cond_mean_pct']}% (基准 {tech_same['base_mean_pct']}%, t={tech_same['t']})")

    print("\n【检验二c】科技连跌 2 日后次日银行")
    tech2 = r[(r["TECH"] < 0) & (r["TECH"].shift(1) < 0)]
    bank_after = ttest(r[BANK].shift(-1).loc[tech2.index], base_bank)
    print(f"  科技连跌 2 日 {bank_after['n']} 次：次日银行 {bank_after['cond_mean_pct']}% (t={bank_after['t']})")
    out["conditional"] = {"tech_down_day_bank": bank_same, "bank_next": bank_next, "coal_same": coal_same,
                          "bank_up_day_tech": tech_same, "tech_2down_next_bank": bank_after}

    # ---- 检验二扩展：基准相对口径（vs 中证500 sh000905，本地 data/market/index_daily.parquet） ----
    zz = load_benchmark()
    bench_ok = len(zz) > 100
    if bench_ok:
        zz_ret = zz.pct_change(fill_method=None).dropna()
        zz_ret = zz_ret.reindex(bt_ret.index).dropna()
        ex = pd.DataFrame(index=bt_ret.index)
        ex["BANK"] = bt_ret[BANK] - zz_ret
        ex["TECH"] = bt_ret["TECH"] - zz_ret
        ex = ex.dropna()
        print("\n【检验二·基准相对（vs 中证500，本地 sh000905）】样本 "
              f"{ex.index[0].date()}~{ex.index[-1].date()}，{len(ex)} 天")
        # 事件定义与原检验一致（基于原始收益），被评估口径换为超额收益
        tech_down_ex = ex.loc[bt_ret["TECH"].reindex(ex.index) < -0.01]
        bank_same_ex = ttest(tech_down_ex["BANK"], ex["BANK"])
        bank_next_ex = ttest(ex["BANK"].shift(-1).loc[tech_down_ex.index], ex["BANK"])
        bank_up_ex = ex.loc[bt_ret[BANK].reindex(ex.index) > 0.01]
        tech_same_ex = ttest(bank_up_ex["TECH"], ex["TECH"])
        tech2_ex_mask = (bt_ret["TECH"].reindex(ex.index) < 0) & (bt_ret["TECH"].reindex(ex.index).shift(1) < 0)
        tech2_ex = ex.loc[tech2_ex_mask]
        bank_after_ex = ttest(ex["BANK"].shift(-1).loc[tech2_ex.index], ex["BANK"])
        print(f"  科技大跌日 {bank_same_ex['n']} 天：银行超额当日 {bank_same_ex['cond_mean_pct']}% (基准 {bank_same_ex['base_mean_pct']}%, t={bank_same_ex['t']})")
        print(f"  次日银行超额 {bank_next_ex['cond_mean_pct']}% (t={bank_next_ex['t']})")
        print(f"  银行大涨日 {tech_same_ex['n']} 天：科技超额当日 {tech_same_ex['cond_mean_pct']}% (t={tech_same_ex['t']})")
        print(f"  科技连跌 2 日 {bank_after_ex['n']} 次：次日银行超额 {bank_after_ex['cond_mean_pct']}% (t={bank_after_ex['t']})")
        out["conditional_excess"] = {"note": "超额=板块日收益-中证500日收益；事件定义同原检验(原始收益)",
                                     "tech_down_day_bank_excess": bank_same_ex, "bank_next_excess": bank_next_ex,
                                     "bank_up_day_tech_excess": tech_same_ex, "tech_2down_next_bank_excess": bank_after_ex}

        # 检验二扩展·分年段：科技大跌日银行当日相对中证500 超额（2024-01-01 前后 + 近1年）
        seg_defs = [
            ("pre_2024", ex.index < "2024-01-01"),
            ("post_2024", ex.index >= "2024-01-01"),
            ("last_1y", ex.index >= "2025-08-01"),
        ]
        by_period = []
        print("\n【检验二·基准相对·分年段】科技大跌日(TECH<-1%)银行当日超额（段内基准检验）")
        for label, mask in seg_defs:
            seg_ex = ex[mask]
            if len(seg_ex) < 10:
                by_period.append({"period": label, "n": len(seg_ex), "cond_mean_pct": None,
                                  "base_mean_pct": None, "diff_pct": None, "t": None})
                print(f"  [{label}] 样本不足：n={len(seg_ex)}")
                continue
            seg_tech = bt_ret["TECH"].reindex(seg_ex.index)
            seg_down = seg_ex.loc[seg_tech < -0.01]
            res = ttest(seg_down["BANK"], seg_ex["BANK"])
            res["period"] = label
            res["window"] = f"{seg_ex.index[0].date()}~{seg_ex.index[-1].date()}"
            by_period.append(res)
            print(f"  [{label}] {res['window']}：科技大跌日 {res['n']} 天，银行超额当日 "
                  f"{res['cond_mean_pct']}% (段内基准 {res['base_mean_pct']}%, t={res['t']})")
        out["conditional_excess_by_period"] = {"note": "科技大跌日(TECH<-1%)银行当日相对中证500超额，按段内基准检验",
                                               "segments": by_period}

        # 检验二扩展·同日事件延续性：科技大跌日后银行相对中证500 未来累计超额（与当日效应完全同一样本）
        # 事件日 = tech_down_ex.index（TECH<-1%），从事件日次日开始累计，不含事件日当天，剔除缺口
        # 前向累计统一在完整日历（ex 全序列）上计算；分段只决定事件归属，不截断前向窗口
        seg_defs_cont = [("full", ex.index >= ex.index[0]),
                         ("pre_2024", ex.index < "2024-01-01"),
                         ("post_2024", ex.index >= "2024-01-01")]
        fwd_by_h = {}
        for h in (1, 2, 3, 5):
            fwd_vals = np.full(len(ex), np.nan)
            for i in range(len(ex) - h):
                seg_ret = ex["BANK"].iloc[i + 1: i + 1 + h]
                if len(seg_ret.dropna()) != h:  # 剔除数据缺口
                    continue
                fwd_vals[i] = (1 + seg_ret).prod() - 1
            fwd_by_h[h] = pd.Series(fwd_vals, index=ex.index)
        cont_out = []
        print("\n【检验二·基准相对·同日事件延续性】科技大跌日(TECH<-1%)后银行超额累计（从次日开始，不含事件日）")
        for label, mask in seg_defs_cont:
            seg_idx = ex.index[mask]
            ev_idx = tech_down_ex.index.intersection(seg_idx)
            for h, hname in ((1, "t+1"), (2, "t+1~t+2"), (3, "t+1~t+3"), (5, "t+1~t+5")):
                base_cums = fwd_by_h[h].loc[seg_idx].dropna()
                cond_cums = fwd_by_h[h].loc[ev_idx].dropna()
                res = ttest(cond_cums, base_cums)
                res["period"] = label
                res["horizon"] = hname
                res["median_pct"] = round(float(np.median(cond_cums)) * 100, 3) if len(cond_cums) >= 10 else None
                res["win_rate"] = round((cond_cums > 0).mean() * 100, 1) if len(cond_cums) >= 10 else None
                cont_out.append(res)
                print(f"  [{label}] {hname}: n={res['n']} 超额均值 {res['cond_mean_pct']}% / "
                      f"中位 {res['median_pct']}% / 胜率 {res['win_rate']}% (基准 {res['base_mean_pct']}%, t={res['t']})")
        out["continuation_excess_same_event"] = {
            "note": "事件日=科技大跌日(TECH<-1%)，与 conditional_excess.tech_down_day_bank_excess 完全同一样本；"
                    "银行相对中证500超额未来累计(次日开始，不含事件日)；前向累计在完整日历上计算；"
                    "基准=该段全期同窗口超额累计均值",
            "segments": cont_out}
    else:
        print("\n【检验二·基准相对】跳过：本地无 sh000905 日线")
        out["conditional_excess"] = {"note": "跳过：本地无 sh000905 日线（data/market/index_daily.parquet）"}

    # ---- 检验三：延续性（科技下跌阶段后 银行 vs 煤炭 t+1~t+5） ----
    print("\n【检验三】科技下跌阶段后延续性：银行 vs 煤炭")
    # 阶段 = 单日科技 ≤ -2% 或连续 2 日跌
    phase_mask = (r["TECH"] <= -0.02) | ((r["TECH"] < 0) & (r["TECH"].shift(1) < 0))
    phase_days = r.index[phase_mask]
    rows = []
    for sym, name in ((BANK, "银行"), (COAL, "煤炭")):
        for h in (1, 3, 5):
            fwd = []
            for d in phase_days:
                pos = r.index.get_loc(d)
                if pos + h < len(r):
                    seg = r[sym].iloc[pos + 1: pos + h + 1]
                    if len(seg) == h:
                        fwd.append((1 + seg).prod() - 1)
            s = pd.Series(fwd)
            rows.append({"name": name, "horizon": f"t+{h}", "n": len(s),
                         "mean_pct": round(s.mean() * 100, 3), "median_pct": round(s.median() * 100, 3),
                         "win_rate": round((s > 0).mean() * 100, 1) if len(s) else None})
    for row in rows:
        print(f"  {row['name']} {row['horizon']}: 均值 {row['mean_pct']}% / 中位 {row['median_pct']}% / 胜率 {row['win_rate']}% (n={row['n']})")
    out["continuation"] = rows

    # ---- 检验三扩展：基准相对口径（vs 中证500，2014-02-21 起长窗，含煤炭 NaN 缺口处理） ----
    if bench_ok:
        zz_ret = zz.pct_change(fill_method=None).dropna()
        # 银行+煤炭+科技 对齐（fill_method=None 保留煤炭 2017-2021 缺口为 NaN，勿用默认 pad 填充）
        btc = closes0[[BANK, COAL] + TECH].pct_change(fill_method=None)
        btc["TECH"] = btc[TECH].mean(axis=1)
        cal = closes0.index  # 完整交易日历（与板块文件一致）
        zz_cal = zz_ret.reindex(cal)
        ex_bank = (btc[BANK] - zz_cal).dropna()
        ex_coal = (btc[COAL] - zz_cal).dropna()
        ex_tech = (btc["TECH"] - zz_cal).dropna()
        # 阶段定义同原检验：单日科技 ≤ -2% 或连续 2 日跌；要求银行/科技有效（不依赖煤炭）
        phase_ok = pd.DataFrame({"tech": ex_tech, "bank": ex_bank}).dropna()
        phase_mask = (phase_ok["tech"] <= -0.02) | ((phase_ok["tech"] < 0) & (phase_ok["tech"].shift(1) < 0))
        phase_days = phase_ok.index[phase_mask]
        ex_rows = []
        for sym, name in ((BANK, "银行"), (COAL, "煤炭")):
            for h in (1, 3, 5):
                fwd = []
                for d in phase_days:
                    pos = cal.get_loc(d)
                    if pos + h >= len(cal):
                        continue
                    nxt = cal[pos + 1: pos + h + 1]
                    seg = ex_bank.reindex(nxt) if sym == BANK else ex_coal.reindex(nxt)
                    if len(seg.dropna()) != h:  # 跨越缺口则放弃该样本
                        continue
                    fwd.append((1 + seg).prod() - 1)
                s = pd.Series(fwd)
                ex_rows.append({"name": name, "horizon": f"t+{h}", "n": len(s),
                                "mean_pct": round(s.mean() * 100, 3), "median_pct": round(s.median() * 100, 3),
                                "win_rate": round((s > 0).mean() * 100, 1) if len(s) else None})
        print(f"\n【检验三·基准相对（vs 中证500，本地 sh000905）】阶段数 {len(phase_days)}，"
              f"样本 {phase_ok.index[0].date()}~{phase_ok.index[-1].date()}")
        for row in ex_rows:
            print(f"  {row['name']} {row['horizon']}: 均值 {row['mean_pct']}% / 中位 {row['median_pct']}% / 胜率 {row['win_rate']}% (n={row['n']})")
        out["continuation_excess"] = {"note": "超额=板块日收益-中证500日收益；阶段定义同原检验；阶段数基于银行/科技有效长窗",
                                      "n_phases": len(phase_days), "rows": ex_rows}
    else:
        out["continuation_excess"] = {"note": "跳过：本地无 sh000905 日线（data/market/index_daily.parquet）"}

    (ROOT / "lab" / "backtests" / "bank-vs-tech").mkdir(parents=True, exist_ok=True)
    import json
    (ROOT / "lab" / "backtests" / "bank-vs-tech" / "summary.json").write_text(
        json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print("\n报告已存 lab/backtests/bank-vs-tech/summary.json")

    persistence_2025plus()


def persistence_2025plus():
    """2025-01-01 以来"科技跌∩银行涨"事件的次日风格延续/反转描述性统计（可复现，独立落盘）。

    事件日：科技合成(TECH)日收益 < 0 且 银行(801780)日收益 > 0。
    输出：事件天数/占比、次日 2x2 四象限、三种延续/反转口径、无条件基准对照（卡方）、
    3 日口径（t+1~t+3 银行vs科技累计超额 >0 占比、3 日内跷跷板再发生 ≥1 天占比）、事件日期清单。
    落盘：lab/backtests/bank-vs-tech/persistence_2025plus.json
    """
    import json as _json

    df = pd.read_parquet(SECTOR_DAILY)
    df["日期"] = pd.to_datetime(df["日期"])
    closes = df.pivot_table(index="日期", columns="code", values="收盘", aggfunc="last").sort_index()
    closes.columns = closes.columns.astype(str)
    bt = closes[[BANK] + TECH].dropna()
    ret = bt.pct_change(fill_method=None).dropna()
    ret["TECH"] = ret[TECH].mean(axis=1)

    win = ret.loc["2025-01-01":]
    ev_mask = (win["TECH"] < 0) & (win[BANK] > 0)
    ev_days = win.index[ev_mask]
    n_win = len(win)
    n_ev = len(ev_days)

    # 次日收益：用全序列 shift(-1)（事件在数据最后一日则无次日，剔除）
    nxt = ret.shift(-1).loc[win.index]
    ev_with_next = ev_days[nxt[BANK].loc[ev_days].notna()]
    n_ev_next = len(ev_with_next)

    def cls(v):
        if v > 0:
            return "up"
        if v < 0:
            return "down"
        return "flat"

    # b) 次日四象限
    q = {"bank_up_tech_up": 0, "bank_up_tech_down": 0, "bank_down_tech_up": 0,
         "bank_down_tech_down": 0, "flat_other": 0}
    for d in ev_with_next:
        b, t = nxt[BANK].loc[d], nxt["TECH"].loc[d]
        key = f"bank_{cls(b)}_tech_{cls(t)}"
        if key in q:
            q[key] += 1
        else:
            q["flat_other"] += 1

    # c) 延续/反转口径（基于事件日的次日）
    cont1 = sum(1 for d in ev_with_next if nxt["TECH"].loc[d] < 0 and nxt[BANK].loc[d] > 0)   # 跷跷板持续
    cont2 = sum(1 for d in ev_with_next if nxt[BANK].loc[d] > 0)                              # 银行单边延续
    rev = sum(1 for d in ev_with_next if nxt["TECH"].loc[d] > 0 and nxt[BANK].loc[d] < 0)     # 变风格
    same_up = q["bank_up_tech_up"]
    same_down = q["bank_down_tech_down"]

    # d) 无条件基准对照（全窗口，含所有非事件日）
    nxt_all = nxt.dropna()
    p_bank_up_base = float((nxt_all[BANK] > 0).mean())
    p_tech_down_base = float((nxt_all["TECH"] < 0).mean())
    p_bank_up_cond = cont2 / n_ev_next
    p_tech_down_cond = sum(1 for d in ev_with_next if nxt["TECH"].loc[d] < 0) / n_ev_next

    from scipy.stats import chi2_contingency

    def _chi2(outcome_cond: int, n_cond: int, col: str, gt: bool) -> dict:
        """事件日 vs 非事件日 × 次日该结果是否发生 的 2x2 卡方（事件日从无条件样本中剔除，保证独立）。"""
        non_ev_mask = ~nxt_all.index.isin(ev_with_next)
        non_ev = nxt_all[non_ev_mask]
        o_non = int((non_ev[col] > 0).sum()) if gt else int((non_ev[col] < 0).sum())
        table = [[outcome_cond, n_cond - outcome_cond],
                 [o_non, len(non_ev) - o_non]]
        chi2, p, dof, _ = chi2_contingency(table)
        return {"chi2": round(float(chi2), 3), "p": round(float(p), 4),
                "cond_share": round(outcome_cond / n_cond, 3),
                "non_event_share": round(o_non / len(non_ev), 3)}

    chi2_bank_up = _chi2(int(cont2), n_ev_next, BANK, gt=True)
    chi2_tech_down = _chi2(sum(1 for d in ev_with_next if nxt["TECH"].loc[d] < 0), n_ev_next, "TECH", gt=False)

    # e) 3 日口径：t+1~t+3 银行 vs 科技累计超额 >0；3 日内跷跷板再发生 ≥1 天
    three_ok, bank_win3, seesaw_re = 0, 0, 0
    for d in ev_days:
        pos = ret.index.get_loc(d)
        if pos + 3 >= len(ret):
            continue
        seg = ret.iloc[pos + 1: pos + 4]
        three_ok += 1
        bank_cum = (1 + seg[BANK]).prod() - 1
        tech_cum = (1 + seg["TECH"]).prod() - 1
        if bank_cum - tech_cum > 0:
            bank_win3 += 1
        if ((seg["TECH"] < 0) & (seg[BANK] > 0)).any():
            seesaw_re += 1

    out = {
        "window": f"2025-01-01~{win.index[-1].date()}",
        "n_window_days": n_win,
        "n_events": n_ev,
        "event_share_pct": round(n_ev / n_win * 100, 2),
        "next_day": {
            "n_events_with_next": n_ev_next,
            "quadrants": {k: {"n": v, "share_of_events_pct": round(v / n_ev_next * 100, 1)} for k, v in q.items()},
            "continuation1_seesaw": {"n": cont1, "share_pct": round(cont1 / n_ev_next * 100, 1)},
            "continuation2_bank_up": {"n": cont2, "share_pct": round(cont2 / n_ev_next * 100, 1)},
            "reversal_tech_up_bank_down": {"n": rev, "share_pct": round(rev / n_ev_next * 100, 1)},
            "other_same_up": {"n": same_up, "share_pct": round(same_up / n_ev_next * 100, 1)},
            "other_same_down": {"n": same_down, "share_pct": round(same_down / n_ev_next * 100, 1)},
            "baseline": {"bank_next_up_pct": round(p_bank_up_base * 100, 1),
                         "tech_next_down_pct": round(p_tech_down_base * 100, 1),
                         "bank_next_up_cond_pct": round(p_bank_up_cond * 100, 1),
                         "tech_next_down_cond_pct": round(p_tech_down_cond * 100, 1)},
            "chi2_bank_next_up": chi2_bank_up,
            "chi2_tech_next_down": chi2_tech_down,
        },
        "day3": {
            "n_events_with_3d": three_ok,
            "bank_minus_tech_cum_gt0_pct": round(bank_win3 / three_ok * 100, 1) if three_ok else None,
            "seesaw_reoccur_ge1day_pct": round(seesaw_re / three_ok * 100, 1) if three_ok else None,
        },
        "event_dates": [str(d.date()) for d in ev_days],
    }

    out_path = ROOT / "lab" / "backtests" / "bank-vs-tech" / "persistence_2025plus.json"
    out_path.write_text(_json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")

    print("\n【2025+ 持续性统计】科技跌∩银行涨 事件次日风格延续/反转")
    print(f"  事件日 {n_ev} 天 / 窗口 {n_win} 天 ({round(n_ev / n_win * 100, 1)}%)，有次日者 {n_ev_next} 天")
    print(f"  次日四象限: {q}")
    print(f"  延续①跷跷板持续 {cont1} ({round(cont1 / n_ev_next * 100, 1)}%) | 延续②银行单边 {cont2} "
          f"({round(cont2 / n_ev_next * 100, 1)}%) | 反转 {rev} ({round(rev / n_ev_next * 100, 1)}%) | "
          f"同涨 {same_up} | 同跌 {same_down}")
    print(f"  基准对照: 无条件银行次日涨 {p_bank_up_base * 100:.1f}% vs 事件后 {p_bank_up_cond * 100:.1f}% "
          f"(chi2 p={chi2_bank_up['p']})；无条件科技次日跌 {p_tech_down_base * 100:.1f}% vs 事件后 "
          f"{p_tech_down_cond * 100:.1f}% (chi2 p={chi2_tech_down['p']})")
    print(f"  3日口径(n={three_ok}): 银行-科技累计超额>0 {round(bank_win3 / three_ok * 100, 1) if three_ok else 'NA'}% | "
          f"3日内跷跷板再发生≥1天 {round(seesaw_re / three_ok * 100, 1) if three_ok else 'NA'}%")
    print(f"  事件日期清单: {', '.join(str(d.date()) for d in ev_days)}")
    print(f"  已存 lab/backtests/bank-vs-tech/persistence_2025plus.json")

    quadrant_2025plus()
    streaks_2025plus()


def _load_bt_rets() -> pd.DataFrame:
    """银行+科技 对齐日收益（fill_method=None 保留缺口为 NaN）。"""
    df = pd.read_parquet(SECTOR_DAILY)
    df["日期"] = pd.to_datetime(df["日期"])
    closes = df.pivot_table(index="日期", columns="code", values="收盘", aggfunc="last").sort_index()
    closes.columns = closes.columns.astype(str)
    bt = closes[[BANK] + TECH].dropna()
    ret = bt.pct_change(fill_method=None).dropna()
    ret["TECH"] = ret[TECH].mean(axis=1)
    return ret


def quadrant_2025plus():
    """任务A：2025-01-01~2026-08-18 科技合成 vs 银行 四象限占比（+ 2014-02~2024-12 反向占比对照）。"""
    import json as _json
    ret = _load_bt_rets()
    win = ret.loc["2025-01-01":]
    t, b = win["TECH"], win[BANK]
    n = len(win)
    q = {"same_up": int(((t > 0) & (b > 0)).sum()),
         "same_down": int(((t < 0) & (b < 0)).sum()),
         "tech_up_bank_down": int(((t > 0) & (b < 0)).sum()),
         "tech_down_bank_up": int(((t < 0) & (b > 0)).sum())}
    flat = int(((t == 0) | (b == 0)).sum())
    reverse = q["tech_up_bank_down"] + q["tech_down_bank_up"]
    same = q["same_up"] + q["same_down"]
    # 2014-02~2024-12 对照（同口径反向占比）
    pre = ret.loc["2014-02-24":"2024-12-31"]
    t2, b2 = pre["TECH"], pre[BANK]
    pre_rev = int(((t2 > 0) & (b2 < 0)).sum() + ((t2 < 0) & (b2 > 0)).sum())
    pre_rev_share = round(pre_rev / len(pre) * 100, 1)

    out = {
        "window": f"2025-01-01~{win.index[-1].date()}",
        "n_window_days": n,
        "n_flat_days": flat,
        "note_flat": "平盘日=科技或银行收益恰为0的交易日；四象限均以严格>0/<0定义",
        "quadrants": {k: {"n": v, "share_pct": round(v / n * 100, 1)} for k, v in q.items()},
        "reverse_sum": {"n": reverse, "share_pct": round(reverse / n * 100, 1),
                        "desc": "科技涨∩银行跌 + 科技跌∩银行涨"},
        "same_sum": {"n": same, "share_pct": round(same / n * 100, 1)},
        "contrast_pre_2025": {"window": "2014-02-24~2024-12-31", "n_days": len(pre),
                              "reverse_share_pct": pre_rev_share,
                              "note": "同口径反向(科技涨∩银行跌+科技跌∩银行涨)占比"},
    }
    out_path = ROOT / "lab" / "backtests" / "bank-vs-tech" / "quadrant_2025plus.json"
    out_path.write_text(_json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print("\n【任务A·象限占比】2025-01-01~2026-08-18")
    print(f"  同涨 {q['same_up']} ({round(q['same_up']/n*100,1)}%) | 同跌 {q['same_down']} "
          f"({round(q['same_down']/n*100,1)}%) | 科技涨∩银行跌 {q['tech_up_bank_down']} "
          f"({round(q['tech_up_bank_down']/n*100,1)}%) | 科技跌∩银行涨 {q['tech_down_bank_up']} "
          f"({round(q['tech_down_bank_up']/n*100,1)}%) | 平盘日 {flat}")
    print(f"  反向合计 {reverse} ({round(reverse/n*100,1)}%) vs 同向合计 {same} ({round(same/n*100,1)}%)")
    print(f"  对照 2014-02~2024-12 反向占比 {pre_rev_share}%")
    print(f"  已存 lab/backtests/bank-vs-tech/quadrant_2025plus.json")


def streaks_2025plus():
    """任务B：连续"科技跌∩银行涨"日合并为区间（streak），与反向"科技涨∩银行跌"对比。"""
    import json as _json
    ret = _load_bt_rets()
    win = ret.loc["2025-01-01":]
    t, b = win["TECH"], win[BANK]
    n = len(win)

    def _runs(cond):
        runs, i = [], 0
        vals = cond.values
        while i < n:
            if vals[i]:
                j = i
                while j < n and vals[j]:
                    j += 1
                runs.append((win.index[i], win.index[j - 1], j - i, i, j))
                i = j
            else:
                i += 1
        return runs

    def _cum(seg, col):
        return (1 + seg[col]).prod() - 1

    def _streak_stats(cond, cum_col, label):
        runs = _runs(cond)
        res = []
        for start, end, ln, i, j in runs:
            seg = win.iloc[i:j]
            bank_cum = _cum(seg, BANK)
            tech_cum = _cum(seg, "TECH")
            res.append({"start": str(start.date()), "end": str(end.date()), "length": ln,
                        "bank_cum_pct": round(bank_cum * 100, 3), "tech_cum_pct": round(tech_cum * 100, 3)})
        lens = [r["length"] for r in res]
        len_dist = {}
        for lo, hi, nm in ((1, 1, "1d"), (2, 2, "2d"), (3, 3, "3d"), (4, 10 ** 9, "ge4d")):
            cnt = sum(1 for L in lens if lo <= L <= hi)
            days = sum(L for L in lens if lo <= L <= hi)
            len_dist[nm] = {"n_streaks": cnt, "event_days": days}
        bank_cums = [r["bank_cum_pct"] for r in res]
        longest = max(res, key=lambda r: (r["length"], r["end"]))
        return res, len_dist, bank_cums, longest

    # 方向1：科技跌∩银行涨（事件方向，与 persistence 同事件）
    cond1 = (t < 0) & (b > 0)
    res1, len_dist1, bc1, longest1 = _streak_stats(cond1, BANK, "tD_bU")
    # 区间后次日
    nxt = ret.shift(-1).loc[win.index]
    after1 = []
    for r in res1:
        d = pd.Timestamp(r["end"])
        pos = ret.index.get_loc(d)
        if pos + 1 >= len(ret):
            continue
        nd = ret.index[pos + 1]
        after1.append(nd)
    a1 = nxt.loc[after1] if after1 else nxt.iloc[0:0]
    after1_bank_up = int((a1[BANK] > 0).sum()) if len(a1) else None
    after1_tech_up = int((a1["TECH"] > 0).sum()) if len(a1) else None
    after1_rev = int(((a1["TECH"] > 0) & (a1[BANK] < 0)).sum()) if len(a1) else None
    n_after1 = len(a1)

    # 方向2：科技涨∩银行跌（反向）
    cond2 = (t > 0) & (b < 0)
    res2, len_dist2, bc2, longest2 = _streak_stats(cond2, "TECH", "tU_bD")
    tech_cums2 = [r["tech_cum_pct"] for r in res2]

    def _summary(vals):
        return {"mean_pct": round(float(np.mean(vals)), 3), "median_pct": round(float(np.median(vals)), 3),
                "max_pct": round(float(np.max(vals)), 3), "min_pct": round(float(np.min(vals)), 3),
                "positive_share_pct": round((np.array(vals) > 0).mean() * 100, 1)}

    out = {
        "window": f"2025-01-01~{win.index[-1].date()}",
        "n_window_days": n,
        "direction1_tech_down_bank_up": {
            "n_event_days": int(cond1.sum()),
            "n_streaks": len(res1),
            "length_distribution": len_dist1,
            "streak_bank_cum": _summary(bc1),
            "longest_streak": longest1,
            "after_streak_end": {"n": n_after1,
                                 "bank_up_pct": round(after1_bank_up / n_after1 * 100, 1) if n_after1 else None,
                                 "tech_up_pct": round(after1_tech_up / n_after1 * 100, 1) if n_after1 else None,
                                 "reversal_tech_up_bank_down_pct": round(after1_rev / n_after1 * 100, 1) if n_after1 else None},
            "streaks": res1,
        },
        "direction2_tech_up_bank_down": {
            "n_event_days": int(cond2.sum()),
            "n_streaks": len(res2),
            "length_distribution": len_dist2,
            "streak_tech_cum": _summary(tech_cums2),
            "longest_streak": longest2,
            "streaks": res2,
        },
    }
    out_path = ROOT / "lab" / "backtests" / "bank-vs-tech" / "streaks_2025plus.json"
    out_path.write_text(_json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")

    s1 = _summary(bc1)
    s2 = _summary(tech_cums2)
    print("\n【任务B·区间合并】2025-01-01~2026-08-18")
    print(f"  方向1 科技跌∩银行涨: {int(cond1.sum())} 事件日 → {len(res1)} 个区间；"
          f"长度分布 1d:{len_dist1['1d']['n_streaks']} 2d:{len_dist1['2d']['n_streaks']} "
          f"3d:{len_dist1['3d']['n_streaks']} ≥4d:{len_dist1['ge4d']['n_streaks']}")
    print(f"    区间银行累计: 均值 {s1['mean_pct']}% / 中位 {s1['median_pct']}% / 最大 {s1['max_pct']}% / "
          f"最小 {s1['min_pct']}% / 正收益占比 {s1['positive_share_pct']}%")
    print(f"    最长区间: {longest1['start']}~{longest1['end']} ({longest1['length']}天), 银行累计 {longest1['bank_cum_pct']}%")
    print(f"    区间后次日(n={n_after1}): 银行涨 {out['direction1_tech_down_bank_up']['after_streak_end']['bank_up_pct']}% / "
          f"科技涨 {out['direction1_tech_down_bank_up']['after_streak_end']['tech_up_pct']}% / "
          f"反转 {out['direction1_tech_down_bank_up']['after_streak_end']['reversal_tech_up_bank_down_pct']}%")
    print(f"  方向2 科技涨∩银行跌: {int(cond2.sum())} 事件日 → {len(res2)} 个区间；"
          f"长度分布 1d:{len_dist2['1d']['n_streaks']} 2d:{len_dist2['2d']['n_streaks']} "
          f"3d:{len_dist2['3d']['n_streaks']} ≥4d:{len_dist2['ge4d']['n_streaks']}")
    print(f"    区间科技累计: 均值 {s2['mean_pct']}% / 中位 {s2['median_pct']}% / 最大 {s2['max_pct']}% / "
          f"最小 {s2['min_pct']}% / 正收益占比 {s2['positive_share_pct']}%")
    print(f"    最长区间: {longest2['start']}~{longest2['end']} ({longest2['length']}天), 科技累计 {longest2['tech_cum_pct']}%")
    print(f"  已存 lab/backtests/bank-vs-tech/streaks_2025plus.json")


if __name__ == "__main__":
    main()
