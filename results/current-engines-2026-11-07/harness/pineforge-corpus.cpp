// Times one PineForge strategy library with a fixed throughput loop:
// dlopen once, then per iteration strategy_create (+ the slot's pinned
// strategy_overrides), one run_backtest over the whole feed, report_free and
// strategy_free. Prints one JSON line with every iteration time and, from one
// extra untimed run, the closed trades and equity for cross-engine checking.
//
// usage: pf_time LIB FEED_CSV ITERATIONS [key=value ...]
#include <pineforge/pineforge.h>

#include <dlfcn.h>

#include <algorithm>
#include <cstdlib>
#include <chrono>
#include <cstdio>
#include <string>
#include <utility>
#include <vector>

using fn_create = pf_strategy_t (*)(const char*);
using fn_run = void (*)(pf_strategy_t, pf_bar_t*, int, pf_report_t*);
using fn_rfree = void (*)(pf_report_t*);
using fn_sfree = void (*)(pf_strategy_t);
using fn_override = void (*)(pf_strategy_t, const char*, const char*);

int main(int argc, char** argv) {
    if (argc < 4) {
        std::fprintf(stderr, "usage: %s LIB FEED_CSV ITERATIONS [key=value ...]\n", argv[0]);
        return 2;
    }
    std::vector<pf_bar_t> bars;
    FILE* f = std::fopen(argv[2], "r");
    if (!f) { std::fprintf(stderr, "cannot open %s\n", argv[2]); return 2; }
    char line[256];
    std::fgets(line, sizeof(line), f);
    while (std::fgets(line, sizeof(line), f)) {
        long long ts;
        double op, hi, lo, cl, vo;
        if (std::sscanf(line, "%lld,%lf,%lf,%lf,%lf,%lf", &ts, &op, &hi, &lo, &cl, &vo) == 6) {
            pf_bar_t b{};
            b.open = op; b.high = hi; b.low = lo; b.close = cl; b.volume = vo;
            b.timestamp = static_cast<int64_t>(ts);
            bars.push_back(b);
        }
    }
    std::fclose(f);
    const int n = static_cast<int>(bars.size());
    const int iterations = std::atoi(argv[3]);
    std::vector<std::pair<std::string, std::string>> overrides;
    for (int i = 4; i < argc; ++i) {
        std::string kv = argv[i];
        const auto eq = kv.find('=');
        if (eq != std::string::npos) overrides.emplace_back(kv.substr(0, eq), kv.substr(eq + 1));
    }

    void* h = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
    if (!h) { std::printf("{\"ok\":false,\"error\":\"dlopen: %s\"}\n", dlerror()); return 1; }
    auto create = reinterpret_cast<fn_create>(dlsym(h, "strategy_create"));
    auto run = reinterpret_cast<fn_run>(dlsym(h, "run_backtest"));
    auto rfree = reinterpret_cast<fn_rfree>(dlsym(h, "report_free"));
    auto sfree = reinterpret_cast<fn_sfree>(dlsym(h, "strategy_free"));
    auto set_override = reinterpret_cast<fn_override>(dlsym(h, "strategy_set_override"));
    if (!create || !run || !rfree || !sfree || (!overrides.empty() && !set_override)) {
        std::printf("{\"ok\":false,\"error\":\"missing C ABI symbol\"}\n");
        return 1;
    }
    auto pinned = [&] {
        pf_strategy_t s = create(nullptr);
        for (const auto& [k, v] : overrides) set_override(s, k.c_str(), v.c_str());
        return s;
    };

    std::vector<double> ms;
    int trades = 0;
    for (int it = 0; it < iterations; ++it) {
        const auto t0 = std::chrono::steady_clock::now();
        pf_strategy_t s = pinned();
        pf_report_t report{};
        run(s, bars.data(), n, &report);
        trades = report.total_trades;
        rfree(&report);
        sfree(s);
        ms.push_back(std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count());
    }

    // Untimed: one more run for the trade list.
    pf_strategy_t s = pinned();
    pf_report_t report{};
    run(s, bars.data(), n, &report);
    std::printf("{\"ok\":true,\"bars\":%d,\"totalTrades\":%d,\"netProfit\":%.10g,\"ms\":[", n, report.total_trades, report.net_profit);
    for (size_t i = 0; i < ms.size(); ++i) std::printf("%s%.4f", i ? "," : "", ms[i]);
    std::printf("],\"trades\":[");
    for (int i = 0; i < report.trades_len; ++i) {
        const pf_trade_t& t = report.trades[i];
        // [entryBar, exitBar, entryPrice, exitPrice, qty, pnl, isLong, openAtEnd]
        std::printf("%s[%d,%d,%.10g,%.10g,%.10g,%.10g,%d,%d]", i ? "," : "",
                    t.entry_bar_index, t.exit_bar_index,
                    t.entry_price, t.exit_price, t.qty, t.pnl, t.is_long, t.open_at_end);
    }
    std::printf("],\"equity\":[");
    for (std::int64_t i = 0; i < report.equity_curve_len; ++i) {
        if (i) std::printf(",");
        std::printf("%.17g", report.equity_curve[i].equity);
    }
    std::printf("]}\n");
    rfree(&report);
    sfree(s);
    dlclose(h);
    (void)trades;
    return 0;
}
