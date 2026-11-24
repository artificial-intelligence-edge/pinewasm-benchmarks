"""@pyne"""

from pynecore.lib import close, input, plot, script, strategy, ta


@script.strategy(title="Synthetic window strategy", initial_capital=10000,
                 default_qty_type=strategy.fixed, default_qty_value=1,
                 process_orders_on_close=True, use_bar_magnifier=False)
def main(period=input.int(20, "Period", minval=4, maxval=100),
         length=input.int(10, "Length", minval=1, maxval=100),
         threshold=input.float(0.0, "Threshold", minval=-5, maxval=5)):
    fast = ta.sma(close, length)
    slow = ta.sma(close, period)
    if close > fast + threshold and fast >= slow:
        strategy.entry("L", strategy.long)
    elif close < fast - threshold:
        strategy.close("L")
    plot(fast, "Fast")
    plot(slow, "Slow")
    plot(strategy.position_size, "Position")
