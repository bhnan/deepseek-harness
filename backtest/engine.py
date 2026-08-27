"""回测引擎：两阶段时间轴执行 + 护栏强制。

两阶段（护栏 §3.2）：
  t 日收盘后：signal = strategy(data.as_of(t), t)   ← 只能看 ≤t 的数据
  t+1 日开盘：按 signal 与昨日持仓差集执行交易       ← 成交价 = t+1 开盘价

可交易性（护栏 T1/T2/T3）：
  - 涨停价无法买入（开盘价 ≥ 涨停价 → 拒单）、跌停价无法卖出
  - 停牌日（无行情行）→ 不成交；委托在下一信号日按最新目标组合重算
  - T+1：当日买入不可当日卖出 → 结构上保证（买入 t+1、最早卖出 t+2）+ 防御性 fail-fast 断言

泄漏自检（护栏 §3.4）：run 结束后扫描访问日志，任何取数日期 > 对应决策日 → 告警。
费用（Execution 配置默认值）：买入佣金/卖出佣金+印花税，在成交时按全仓比例计入净值。
"""
from __future__ import annotations

from dataclasses import dataclass

import pandas as pd


class GuardrailError(Exception):
    """护栏违规：fail-fast，绝不静默跳过。"""


@dataclass
class TradeRecord:
    date: pd.Timestamp
    symbol: str
    side: str          # buy / sell
    price: float
    reason: str = ""   # filled / limit_up_rejected / limit_down_rejected / suspended_skipped


@dataclass
class BacktestResult:
    equity: pd.Series                       # index=交易日，组合净值（收盘计）
    trades: list[TradeRecord]
    guardrails: dict                        # as_of / t_plus_1_execution / leak_check 三项盖章
    access_log: list


DEFAULT_EXECUTION = {
    "commission_open": 0.0005,
    "commission_close": 0.0015,
    "stamp_tax": 0.0005,
    "slippage": 0.0,
    "min_commission": 5.0,
    "t_plus_1": True,
    "limit_up_down": True,
    "suspend_skip": True,
    "min_lot": 100,
}


class BacktestEngine:
    """v0：做多、等权、全仓目标组合；信号 = 目标持仓清单（list[str]）。"""

    def __init__(self, data, execution: dict | None = None):
        self.data = data
        self.exec = {**DEFAULT_EXECUTION, **(execution or {})}

    # ---------- 行情辅助 ----------
    def _open_price(self, day: pd.Timestamp, symbol: str) -> float | None:
        try:
            value = self.data.opens.loc[day, symbol]
        except KeyError:
            return None
        if pd.isna(value):
            return None
        return float(value)

    def _close_of(self, day: pd.Timestamp, symbol: str) -> float | None:
        try:
            value = self.data.closes.loc[day, symbol]
        except KeyError:
            return None
        if pd.isna(value):
            return None
        return float(value)

    def _prev_close(self, day: pd.Timestamp, symbol: str) -> float | None:
        idx = self.data.closes.index
        pos = idx.get_loc(day)
        if pos == 0:
            return None
        return self._close_of(idx[pos - 1], symbol)

    def _limit_price(self, prev_close: float, up: bool) -> float:
        return round(prev_close * (1 + (0.1 if up else -0.1)), 2)

    def _can_buy(self, day: pd.Timestamp, symbol: str, open_price: float) -> tuple[bool, str]:
        if not self.exec["limit_up_down"]:
            return True, "filled"
        prev_close = self._prev_close(day, symbol)
        if prev_close is None:
            return True, "filled"  # 新股首日无昨收，无法判定涨停，放行
        if open_price >= self._limit_price(prev_close, up=True):
            return False, "limit_up_rejected"
        return True, "filled"

    def _can_sell(self, day: pd.Timestamp, symbol: str, open_price: float) -> tuple[bool, str]:
        if not self.exec["limit_up_down"]:
            return True, "filled"
        prev_close = self._prev_close(day, symbol)
        if prev_close is None:
            return True, "filled"
        if open_price <= self._limit_price(prev_close, up=False):
            return False, "limit_down_rejected"
        return True, "filled"

    @staticmethod
    def assert_t_plus_1(held: dict, sells: list, day: pd.Timestamp) -> None:
        """T+1 防御性校验（fail-fast）：卖出日必须严格晚于买入日。

        held: symbol -> (买入日, 买入价)
        """
        for s in sells:
            if s in held and held[s][0] >= day:
                raise GuardrailError(
                    f"T+1 违规：{s} 于 {held[s][0].date()} 买入，{day.date()} 即卖出（fail-fast）")

    # ---------- 主流程 ----------
    def run(self, strategy, start, end) -> BacktestResult:
        days = [d for d in self.data.closes.index if start <= d <= end]
        if len(days) < 2:
            raise ValueError("回测区间过短：至少需要两个交易日")

        held: dict[str, tuple[pd.Timestamp, float]] = {}   # symbol -> (买入日, 买入价)
        equity = pd.Series(1.0, index=days)
        trades: list[TradeRecord] = []
        nav = 1.0
        target_list: list[str] = []
        target_set: set[str] = set()

        for i, day in enumerate(days):
            if i >= 1:
                # ---- 阶段 1：开盘执行（承接上一收盘信号的目标组合）----
                sells = [s for s in held if s not in target_set]
                self.assert_t_plus_1(held, sells, day)
                # 先卖后买（v0 全仓：卖出/买入按当前净值整体计费）
                if sells:
                    sold = False
                    for s in sells:
                        op = self._open_price(day, s)
                        if op is None:
                            trades.append(TradeRecord(day, s, "sell", float("nan"), "suspended_skipped"))
                            continue
                        ok, reason = self._can_sell(day, s, op)
                        if not ok:
                            trades.append(TradeRecord(day, s, "sell", op, reason))
                            continue
                        trades.append(TradeRecord(day, s, "sell", op, "filled"))
                        del held[s]
                        sold = True
                    if sold:
                        nav *= 1 - self.exec["commission_close"] - self.exec["stamp_tax"]
                buys = [s for s in target_list if s not in held]
                if buys:
                    bought = False
                    for s in buys:
                        op = self._open_price(day, s)
                        if op is None:
                            trades.append(TradeRecord(day, s, "buy", float("nan"), "suspended_skipped"))
                            continue
                        ok, reason = self._can_buy(day, s, op)
                        if not ok:
                            trades.append(TradeRecord(day, s, "buy", op, reason))
                            continue
                        trades.append(TradeRecord(day, s, "buy", op, "filled"))
                        held[s] = (day, op)
                        bought = True
                    if bought:
                        nav *= 1 - self.exec["commission_open"]

            # ---- 阶段 2：收盘按持仓 close-to-close 计净值 ----
            if held:
                rets = []
                for s, (buy_day, buy_price) in held.items():
                    today_close = self._close_of(day, s)
                    if today_close is None:
                        continue  # 停牌：持仓冻结计价（护栏 T2）
                    if buy_day == day:
                        # 买入当日：收益基准 = 买入价（开盘），不得计隔夜跳空
                        rets.append(today_close / buy_price - 1.0)
                    elif i >= 1:
                        prev_close = self._close_of(days[i - 1], s)
                        if prev_close is None:
                            continue  # 复牌首日无昨收行，不产生虚假盈亏
                        rets.append(today_close / prev_close - 1.0)
                    else:
                        rets.append(0.0)
                if rets:
                    nav *= 1 + float(pd.Series(rets).mean())
            equity.iloc[i] = nav

            # ---- 阶段 3：收盘后算信号（只能看 ≤day 数据）----
            target_list = list(strategy(self.data.as_of(day), day))
            target_set = set(target_list)

        # ---- 泄漏自检（护栏 §3.4）----
        violations = [entry for entry in self.data.access_log()
                      if entry[1] is not None and entry[2] > entry[1]]
        guardrails = {
            "as_of": True,
            "t_plus_1_execution": True,
            "leak_check": len(violations) == 0,
        }
        return BacktestResult(equity=equity, trades=trades, guardrails=guardrails,
                              access_log=self.data.access_log())
