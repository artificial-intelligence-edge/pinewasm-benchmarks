"""@pyne"""

from pynecore.lib import bar_index, close, input, plot, script, strategy, ta


@script.strategy(title="Synthetic periodic strategy", overlay=True, initial_capital=10000,
                 default_qty_type=strategy.fixed, default_qty_value=1,
                 process_orders_on_close=True, use_bar_magnifier=False)
def main(period=input.int(20, "Period", minval=4, maxval=100),
         length=input.int(10, "Length", minval=1, maxval=100),
         threshold=input.float(0.0, "Threshold", minval=-5, maxval=5)):
    basis = ta.sma(close, length)
    if bar_index % period == 0:
        strategy.entry("L", strategy.long)
    if bar_index % period == 2:
        strategy.close("L")
    plot(basis, "SMA")
    plot(close + threshold, "Offset")
    plot(strategy.position_size, "Position")
