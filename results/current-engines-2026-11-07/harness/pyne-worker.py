"""Run the synthetic strategy through the PyneCore ScriptRunner API."""

import json
from importlib.metadata import version
import math
from pathlib import Path
import sys
from time import perf_counter_ns

from pynecore.core.script_runner import ScriptRunner
from pynecore.core.syminfo import SymInfo
from pynecore.types.ohlcv import OHLCV


CAPITAL = 10000


def read_feed(path):
    bars = []
    with path.open() as feed:
        for row in feed:
            time, *prices = row.split()
            bars.append(OHLCV(int(time), *map(float, prices)))
    return bars


def plot_value(value):
    number = float(value)
    if math.isinf(number):
        raise ValueError("infinite plot value")
    return None if math.isnan(number) else number


def run(script, feed, syminfo, overrides, config):
    titles = ("SMA", "Offset", "Position") if script.stem == "periodic" else ("Fast", "Slow", "Position")
    plots = {title: [] for title in titles}
    trades, equity = [], []
    runner = ScriptRunner(script, feed, syminfo, inputs=overrides, config_dir=config)
    position = runner.script.position
    for _, values, new_trades in runner.run_iter(copy_results=False):
        for title, column in plots.items():
            column.append(plot_value(values[title]))
        equity.append(float(position.equity))
        for trade in new_trades:
            trades.append({
                "entryId": trade.entry_id,
                "direction": 1 if trade.size > 0 else -1,
                "quantity": abs(trade.size),
                "entryBar": trade.entry_bar_index,
                "exitBar": trade.exit_bar_index,
                "entryPrice": trade.entry_price,
                "exitPrice": trade.exit_price,
                "profit": trade.profit,
                "commission": trade.commission,
            })
    if len(equity) != len(feed):
        raise ValueError(f"incomplete run: {len(equity)} of {len(feed)} bars")
    peak = CAPITAL
    drawdown = 0
    for value in equity:
        peak = max(peak, value)
        drawdown = max(drawdown, peak - value)
    profits = [trade["profit"] for trade in trades]
    metrics = {
        "initialCapital": CAPITAL,
        "netProfit": sum(profits),
        "grossProfit": sum(max(0, value) for value in profits),
        "grossLoss": sum(max(0, -value) for value in profits),
        "closedTrades": len(trades),
        "totalCommission": sum(trade["commission"] for trade in trades),
        "finalEquity": equity[-1],
        "positionSize": float(position.size),
        "maxDrawdown": drawdown,
    }
    return {
        "bars": len(equity),
        "plots": [{"title": title, "values": column} for title, column in plots.items()],
        "strategy": {"available": True, "trades": trades, "equity": equity, "metrics": metrics},
    }


def main():
    workload, feed_path, config_path = sys.argv[1:]
    if workload not in {"momentum", "periodic", "weighted", "window"}:
        raise ValueError(f"unknown workload {workload}")
    script = Path(__file__).with_name("pynecore") / f"{workload}.py"
    feed = read_feed(Path(feed_path))
    syminfo = SymInfo(
        prefix="SYNTHETIC", ticker="BENCH", description="Synthetic bars", currency="USD",
        period="D", type="crypto", mintick=1/256, mincontract=1, pricescale=256,
        pointvalue=1.0, opening_hours=[], session_starts=[], session_ends=[], timezone="UTC",
    )
    print(json.dumps({"ready": True, "version": version("pynesys-pynecore")}), flush=True)
    for line in sys.stdin:
        projection, period, length, threshold = line.split()
        if projection not in {"full", "metrics"}:
            raise ValueError(f"unknown projection {projection}")
        inputs = {"period": int(period), "length": int(length), "threshold": float(threshold)}
        start = perf_counter_ns()
        output = run(script, feed, syminfo, inputs, Path(config_path))
        elapsed_ms = (perf_counter_ns() - start) / 1_000_000
        result = {"ok": True, "elapsedMs": elapsed_ms}
        if projection == "metrics":
            result["metrics"] = output["strategy"]["metrics"]
        else:
            result["output"] = output
        print(json.dumps(result, allow_nan=False, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    main()
