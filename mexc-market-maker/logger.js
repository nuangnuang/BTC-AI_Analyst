'use strict';

const config = require('./config');

const MODE_TAG = config.simulasi ? 'SIM' : 'REAL';

/** Zero-pad helper */
function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

/** Format timestamp as HH:MM:SS.mmm */
function ts() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** Format a number to fixed decimals, with fallback */
function fmt(val, decimals = 4) {
  if (val == null || Number.isNaN(val)) return '---';
  return Number(val).toFixed(decimals);
}

// Throttle map: prevents log spam per category
const _lastLog = {};
const MIN_LOG_INTERVAL_MS = 1000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const logger = {
  /**
   * Core status line: [MODE] [TIME] Spread: X | Inventory: T/C | Status: Y
   * Throttled to 1 msg/sec per category to avoid spam.
   */
  status(spread, inventoryRatio, statusText, category = 'status') {
    const now = Date.now();
    if (_lastLog[category] && now - _lastLog[category] < MIN_LOG_INTERVAL_MS) return;
    _lastLog[category] = now;

    const spreadBps = spread != null ? (spread * 10000).toFixed(2) + ' bps' : '---';
    const invPct = inventoryRatio != null ? (inventoryRatio * 100).toFixed(1) + '%' : '---';
    console.log(`[${MODE_TAG}] [${ts()}] Spread: ${spreadBps} | Inventory: ${invPct} | Status: ${statusText}`);
  },

  /** Order placement / fill log */
  order(side, price, qty, type) {
    console.log(`[${MODE_TAG}] [${ts()}] ORDER ${type} | ${side} ${fmt(qty, 6)} @ ${fmt(price, 2)}`);
  },

  /** Trade fill notification */
  fill(side, price, qty, pnl) {
    const pnlStr = pnl != null ? ` | PnL: ${fmt(pnl, 4)} USDT` : '';
    console.log(`[${MODE_TAG}] [${ts()}] FILL  | ${side} ${fmt(qty, 6)} @ ${fmt(price, 2)}${pnlStr}`);
  },

  /** Performance summary (called every perfIntervalMs) */
  perf(stats) {
    console.log('');
    console.log(`[${MODE_TAG}] ====== PERFORMANCE SUMMARY (${ts()}) ======`);
    console.log(`  Total Trades     : ${stats.totalTrades}`);
    console.log(`  Buy Fills        : ${stats.buyFills}`);
    console.log(`  Sell Fills       : ${stats.sellFills}`);
    console.log(`  Realized PnL     : ${fmt(stats.realizedPnl, 4)} USDT`);
    console.log(`  Unrealized PnL   : ${fmt(stats.unrealizedPnl, 4)} USDT`);
    console.log(`  Net PnL          : ${fmt(stats.realizedPnl + stats.unrealizedPnl, 4)} USDT`);
    console.log(`  Inventory (base) : ${fmt(stats.baseBalance, 6)} ${config.baseAsset}`);
    console.log(`  Inventory (quote): ${fmt(stats.quoteBalance, 4)} ${config.quoteAsset}`);
    console.log(`  Inventory Ratio  : ${(stats.inventoryRatio * 100).toFixed(1)}%`);
    console.log(`[${MODE_TAG}] ==========================================`);
    console.log('');
  },

  /** Rebalance / mode-switch notifications */
  rebalance(msg) {
    console.log(`[${MODE_TAG}] [${ts()}] REBALANCE | ${msg}`);
  },

  /** WebSocket connectivity events */
  ws(msg) {
    console.log(`[${MODE_TAG}] [${ts()}] WS | ${msg}`);
  },

  /** Generic info line */
  info(msg) {
    console.log(`[${MODE_TAG}] [${ts()}] INFO | ${msg}`);
  },

  /** Error line */
  error(msg, err) {
    console.error(`[${MODE_TAG}] [${ts()}] ERROR | ${msg}`, err ? err.message || err : '');
  },

  /** Startup banner */
  banner() {
    console.log('');
    console.log('=======================================================');
    console.log(`  MEXC Market Maker Bot  —  ${MODE_TAG} MODE`);
    console.log(`  Symbol          : ${config.symbol}`);
    console.log(`  Grid Size (USDT): ${config.quantityPerGridUsdt}`);
    console.log(`  Max Sets        : ${config.maxSet}`);
    console.log(`  Rebalance Thr.  : ${(config.rebalanceThreshold * 100).toFixed(0)}%`);
    console.log(`  Sell-Only Thr.  : ${(config.sellOnlyThreshold * 100).toFixed(0)}%`);
    console.log(`  Min Spread      : ${(config.minSpread * 10000).toFixed(1)} bps`);
    console.log('=======================================================');
    console.log('');
  },
};

module.exports = logger;
