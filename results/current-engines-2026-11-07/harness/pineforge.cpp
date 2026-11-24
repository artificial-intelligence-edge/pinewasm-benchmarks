#include <pineforge/source/pine_strategy_host.hpp>
#include <pineforge/ta.hpp>
#include <pineforge/version.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using pineforge::Bar;
using pineforge::Trade;
constexpr double Capital = 10000.0;
constexpr double Missing = std::numeric_limits<double>::quiet_NaN();
enum class Workload { Momentum, Periodic, Weighted, Window };

Workload workload_for(const std::string& name) {
    if (name == "momentum") return Workload::Momentum;
    if (name == "periodic") return Workload::Periodic;
    if (name == "weighted") return Workload::Weighted;
    if (name == "window") return Workload::Window;
    throw std::runtime_error("unknown workload");
}

class Strategy final : public pineforge::source::PineStrategyHost {
    const std::vector<Bar>& feed_;
    Workload workload_;
    int period_, length_;
    double threshold_;
    pineforge::ta::SMA fast_sma_, slow_sma_;
    pineforge::ta::WMA fast_wma_, slow_wma_;

    void on_source_bar(const Bar& bar) override {
        const int index = pine_bar_index();
        const double close = bar.close;
        double first, second;
        bool enter, exit;
        switch (workload_) {
        case Workload::Momentum:
            first = index >= length_ ? close - feed_.at(index - length_).close : Missing;
            second = slow_sma_.compute(close);
            enter = first > threshold_ && close > second;
            exit = !enter && first < -threshold_;
            break;
        case Workload::Periodic:
            first = fast_sma_.compute(close);
            second = close + threshold_;
            enter = index % period_ == 0;
            exit = index % period_ == 2;
            break;
        case Workload::Weighted:
            first = fast_wma_.compute(close);
            second = slow_wma_.compute(close);
            enter = first > second + threshold_;
            exit = !enter && first < second - threshold_;
            break;
        case Workload::Window:
            first = fast_sma_.compute(close);
            second = slow_sma_.compute(close);
            enter = close > first + threshold_ && first >= second;
            exit = !enter && close < first - threshold_;
            break;
        }
        if (enter) strategy_entry("L", true);
        if (exit) strategy_close("L");
        plots[0].push_back(first);
        plots[1].push_back(second);
        plots[2].push_back(live_position_size());
    }

public:
    std::array<std::vector<double>, 3> plots;

    Strategy(const std::vector<Bar>& feed, Workload workload, int period, int length, double threshold)
        : feed_(feed), workload_(workload), period_(period), length_(length), threshold_(threshold),
          fast_sma_(length), slow_sma_(period), fast_wma_(length), slow_wma_(period) {
        pineforge::source::PineStrategyConfig config;
        config.initial_capital = Capital;
        config.default_qty_value = 1;
        config.process_orders_on_close = true;
        configure_pine_strategy(config);
        set_syminfo_mintick(1.0 / 256);
        set_syminfo_type("crypto");
        set_syminfo_timezone("UTC");
        set_syminfo_session("24x7");
        for (auto& column : plots) column.reserve(feed.size());
    }
};

struct Run {
    std::array<std::vector<double>, 3> plots;
    std::vector<Trade> trades;
    std::vector<double> equity;
    double position = 0, net = 0, gross_profit = 0, gross_loss = 0, commission = 0, drawdown = 0;
};

Run evaluate(const std::vector<Bar>& feed, Workload workload, int period, int length, double threshold) {
    Strategy strategy(feed, workload, period, length, threshold);
    strategy.run(feed.data(), static_cast<int>(feed.size()), "D", "D");
    if (!strategy.last_error().empty()) throw std::runtime_error(strategy.last_error());
    pineforge::ReportC report{};
    strategy.fill_report(&report);
    struct ReportCleanup {
        pineforge::ReportC& report;
        ~ReportCleanup() { pineforge::BacktestEngine::free_report(&report); }
    } cleanup{report};
    Run result;
    result.plots = std::move(strategy.plots);
    result.position = strategy.live_position_size();
    for (int i = 0; i < strategy.trade_count(); ++i) {
        auto trade = strategy.get_trade(i);
        result.net += trade.pnl;
        result.gross_profit += std::max(0.0, trade.pnl);
        result.gross_loss += std::max(0.0, -trade.pnl);
        result.commission += trade.commission;
        result.trades.push_back(std::move(trade));
    }
    double peak = Capital;
    for (std::int64_t i = 0; i < report.equity_curve_len; ++i) {
        const double value = report.equity_curve[i].equity;
        result.equity.push_back(value);
        peak = std::max(peak, value);
        result.drawdown = std::max(result.drawdown, peak - value);
    }
    if (result.equity.size() != feed.size() || result.plots[0].size() != feed.size())
        throw std::runtime_error("incomplete bar output");
    return result;
}

void write_values(const std::vector<double>& values) {
    std::cout << '[';
    for (std::size_t i = 0; i < values.size(); ++i) {
        if (i != 0) std::cout << ',';
        if (std::isnan(values[i])) std::cout << "null";
        else if (std::isfinite(values[i])) std::cout << values[i];
        else throw std::runtime_error("infinite output");
    }
    std::cout << ']';
}

void write_metrics(const Run& result) {
    std::cout << "{\"initialCapital\":" << Capital << ",\"netProfit\":" << result.net
              << ",\"grossProfit\":" << result.gross_profit << ",\"grossLoss\":" << result.gross_loss
              << ",\"closedTrades\":" << result.trades.size() << ",\"totalCommission\":" << result.commission
              << ",\"finalEquity\":" << result.equity.back() << ",\"positionSize\":" << result.position
              << ",\"maxDrawdown\":" << result.drawdown << '}';
}

void write_output(Workload workload, const Run& result) {
    const char* first = workload == Workload::Periodic ? "SMA" : "Fast";
    const char* second = workload == Workload::Periodic ? "Offset" : "Slow";
    const std::array<const char*, 3> titles{first, second, "Position"};
    std::cout << "{\"bars\":" << result.equity.size() << ",\"plots\":[";
    for (std::size_t i = 0; i < titles.size(); ++i) {
        if (i != 0) std::cout << ',';
        std::cout << "{\"title\":\"" << titles[i] << "\",\"values\":";
        write_values(result.plots[i]);
        std::cout << '}';
    }
    std::cout << "],\"strategy\":{\"available\":true,\"trades\":[";
    for (std::size_t i = 0; i < result.trades.size(); ++i) {
        const auto& trade = result.trades[i];
        if (i != 0) std::cout << ',';
        std::cout << "{\"entryId\":" << std::quoted(trade.entry_id) << ",\"direction\":" << (trade.is_long ? 1 : -1)
                  << ",\"quantity\":" << trade.qty << ",\"entryBar\":" << trade.entry_bar_index
                  << ",\"exitBar\":" << trade.exit_bar_index << ",\"entryPrice\":" << trade.entry_price
                  << ",\"exitPrice\":" << trade.exit_price << ",\"profit\":" << trade.pnl
                  << ",\"commission\":" << trade.commission << '}';
    }
    std::cout << "],\"equity\":";
    write_values(result.equity);
    std::cout << ",\"metrics\":";
    write_metrics(result);
    std::cout << "}}";
}

}  // namespace

extern "C" int strategy_reads_trade_history() { return 0; }

int main(int argc, char** argv) {
    try {
        if (argc != 3) throw std::runtime_error("usage: pineforge-worker WORKLOAD FEED");
        const auto workload = workload_for(argv[1]);
        std::ifstream input(argv[2]);
        std::vector<Bar> feed;
        Bar bar{};
        while (input >> bar.timestamp >> bar.open >> bar.high >> bar.low >> bar.close >> bar.volume)
            feed.push_back(bar);
        if (feed.empty() || !input.eof()) throw std::runtime_error("invalid feed");
        std::cout << std::setprecision(17) << "{\"ready\":true,\"version\":\""
                  << PINEFORGE_VERSION_STRING << '+' << PINEFORGE_GIT_SHA << "\"}" << std::endl;
        std::string projection;
        int period, length;
        double threshold;
        while (std::cin >> projection >> period >> length >> threshold) {
            if (projection != "metrics" && projection != "full") throw std::runtime_error("unknown projection");
            const auto start = std::chrono::steady_clock::now();
            const auto result = evaluate(feed, workload, period, length, threshold);
            const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
            std::cout << "{\"ok\":true,\"elapsedMs\":" << ms;
            if (projection == "metrics") {
                std::cout << ",\"metrics\":";
                write_metrics(result);
            } else {
                std::cout << ",\"output\":";
                write_output(workload, result);
            }
            std::cout << '}' << std::endl;
        }
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
