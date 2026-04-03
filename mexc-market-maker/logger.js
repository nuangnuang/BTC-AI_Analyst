'use strict';

const config = require('./config');

const MODE_TAG = config.simulasi ? 'SIM' : 'REAL';

/**
 * Throttle map — prevents log spam by enforcing minimum intervals per category.
 * Key: category string, Value: last-log timestamp.
 */
const _throttle = new Map();
const THROTTLE_MS = 2000; // minimum 2s between same-category logs

function _ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 23);
}

function _fmt(level, msg) {
  return `[${MODE_TAG}] [${_ts()}] [${level}] ${msg}`;
}

/**
 * Core log function with optional throttle category.
 * @param {'INFO'|'WARN'|'ERROR'|'TRADE'|'PNL'} level
 * @param {string} msg
 * @param {string|null} throttleKey  - if set, deduplicates within THROTTLE_MS
 */
function _log(level, msg, throttleKey = null) {
  if (throttleKey) {
    const now = Date.now();
    const last = _throttle.get(throttleKey) || 0;
    if (now - last < THROTTLE_MS) return;
    _throttle.set(throttleKey, now);
  }
  const line = _fmt(level, msg);
  if (level === 'ERROR') {
    console.error(line);
  } else {
    console.log(line);
  }
}

/** Standard informational log (throttled per category). */
function info(msg, throttleKey = null) {
  _log('INFO', msg, throttleKey);
}

/** Warning log. */
function warn(msg) {
  _log('WARN', msg);
}

/** Error log — never throttled. */
function error(msg) {
  _log('ERROR', msg);
}

/**
 * Trade execution log — always printed.
 * @param {'BUY'|'SELL'} side
 * @param {number} price
 * @param {number} qty
 * @param {boolean} simulated
 */
function trade(side, price, qty, simulated) {
  const tag = simulated ? '(PAPER)' : '(LIVE)';
  _log('TRADE', `${tag} ${side} ${qty} @ ${price}`);
}

/**
 * Formatted status line:
 * Spread: X | Inventory: T/C | Status: Y
 */
function status({ spreadPct, inventoryBase, inventoryQuote, inventoryRatio, mode }) {
  const spreadBps = (spreadPct * 100).toFixed(4);
  const invBase  = inventoryBase.toFixed(6);
  const invQuote = inventoryQuote.toFixed(2);
  const ratio    = (inventoryRatio * 100).toFixed(1);
  _log(
    'INFO',
    `Spread: ${spreadBps}% | Inventory: ${invBase} ${config.baseAsset} / ${invQuote} USDT (${ratio}% base) | Mode: ${mode}`,
    'status'
  );
}

/**
 * P&L summary log — printed on a fixed interval.
 */
function pnl({ totalTrades, realizedPnl, unrealizedPnl, uptime }) {
  const mins = (uptime / 60000).toFixed(1);
  _log(
    'PNL',
    `Trades: ${totalTrades} | Realized P&L: ${realizedPnl.toFixed(4)} USDT | ` +
    `Unrealized P&L: ${unrealizedPnl.toFixed(4)} USDT | Uptime: ${mins}m`
  );
}

module.exports = { info, warn, error, trade, status, pnl };
