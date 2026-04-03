'use strict';

const config = require('./config');

const MODE_TAG = config.simulasi ? 'SIM' : 'REAL';

/**
 * Throttle map: prevents log spam by enforcing minimum intervals per category.
 * Key = category string, Value = last emission timestamp.
 */
const _throttle = new Map();
const THROTTLE_MS = 1000; // Minimum 1s between identical category logs

/**
 * Format current timestamp as HH:MM:SS.mmm
 */
function timestamp() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

/**
 * Core log function with mode tag and timestamp.
 * @param {'INFO'|'WARN'|'ERROR'|'TRADE'|'PNL'} level
 * @param {string} message
 * @param {string} [category] - Optional throttle category
 */
function log(level, message, category) {
  if (category) {
    const now = Date.now();
    const last = _throttle.get(category) || 0;
    if (now - last < THROTTLE_MS) return;
    _throttle.set(category, now);
  }

  const prefix = `[${MODE_TAG}] [${timestamp()}] [${level}]`;
  const line = `${prefix} ${message}`;

  if (level === 'ERROR') {
    console.error(line);
  } else if (level === 'WARN') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

/**
 * Log market state: spread, inventory ratio, and trading status.
 * Throttled to avoid spam on every tick.
 */
function logMarketState({ spread, tokenRatio, usdtRatio, status }) {
  const spreadBps = (spread * 100).toFixed(4);
  const tPct = (tokenRatio * 100).toFixed(1);
  const uPct = (usdtRatio * 100).toFixed(1);
  log('INFO', `Spread: ${spreadBps}% | Inventory: Token ${tPct}% / USDT ${uPct}% | Status: ${status}`, 'market_state');
}

/**
 * Log a trade execution (simulated or real).
 */
function logTrade({ side, price, qty, mode }) {
  log('TRADE', `${side} ${qty} @ ${price} [${mode}]`);
}

/**
 * Log P&L summary report.
 */
function logPnL({ totalTrades, realizedPnl, unrealizedPnl, tokenBalance, usdtBalance, elapsed }) {
  const mins = (elapsed / 60000).toFixed(1);
  log('PNL', [
    `--- Performance Report (${mins} min) ---`,
    `  Trades: ${totalTrades}`,
    `  Realized P&L: ${realizedPnl.toFixed(6)} USDT`,
    `  Unrealized P&L: ${unrealizedPnl.toFixed(6)} USDT`,
    `  Balances: ${tokenBalance} Token / ${usdtBalance} USDT`,
  ].join('\n'));
}

/**
 * Log order placement or cancellation.
 */
function logOrder(action, { side, price, qty }) {
  log('INFO', `Order ${action}: ${side} ${qty} @ ${price}`, `order_${action}_${side}`);
}

module.exports = {
  log,
  info:  (msg, cat) => log('INFO', msg, cat),
  warn:  (msg, cat) => log('WARN', msg, cat),
  error: (msg, cat) => log('ERROR', msg, cat),
  logMarketState,
  logTrade,
  logPnL,
  logOrder,
};
