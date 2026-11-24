// Strategy sources that lack this capability declaration are handled conservatively.
// PineForge keeps trade history when the declaration is absent.
extern "C" int strategy_reads_trade_history() { return 1; }
