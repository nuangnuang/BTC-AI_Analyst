'use strict';

const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '.env') });

/** Parse a boolean-like env var */
function parseBool(val) {
  if (typeof val === 'string') return val.toLowerCase() === 'true';
  return Boolean(val);
}

/** Parse a numeric env var with validation */
function parseNum(val, name, min = 0) {
  const n = Number(val);
  if (Number.isNaN(n) || n < min) {
    throw new Error(`Config error: ${name} must be a number >= ${min}, got "${val}"`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Core Configuration
// ---------------------------------------------------------------------------

const config = {
  // Trading pair
  symbol: (process.env.SYMBOL || 'BTCUSDT').toUpperCase(),

  // Dual-mode toggle: true = paper trading, false = real orders
  simulasi: parseBool(process.env.SIMULASI ?? 'true'),

  // USDT notional per grid order
  quantityPerGridUsdt: parseNum(process.env.QUANTITY_PER_GRID_USDT || '10', 'QUANTITY_PER_GRID_USDT', 1),

  // Max simultaneous order sets (1 set = 1 buy + 1 sell)
  maxSet: parseNum(process.env.MAX_SET || '1', 'MAX_SET', 1),

  // Inventory rebalance threshold (fraction, e.g. 0.15 = 15%)
  rebalanceThreshold: parseNum(process.env.REBALANCE_THRESHOLD || '0.15', 'REBALANCE_THRESHOLD', 0),

  // Minimum spread to place orders (fraction, 0.0002 = 0.02%)
  minSpread: 0.0002,

  // Inventory hard-stop threshold: if token ratio > this, enter sell-only mode
  sellOnlyThreshold: 0.65,

  // Performance summary interval (ms)
  perfIntervalMs: 5 * 60 * 1000,

  // WebSocket reconnect delay (ms)
  wsReconnectMs: 3000,

  // Order expiry timeout for simulation fills (ms)
  simOrderTtlMs: 60 * 1000,

  // REST API base
  restBase: 'https://api.mexc.com',

  // WebSocket endpoint (MEXC V3 spot)
  wsEndpoint: 'wss://wbs.mexc.com/ws',

  // API credentials
  apiKey: process.env.MEXC_API_KEY || '',
  secretKey: process.env.MEXC_SECRET_KEY || '',
};

// Derive base & quote asset from the symbol (assumes quote is USDT)
config.quoteAsset = 'USDT';
config.baseAsset = config.symbol.replace(/USDT$/, '');

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validate() {
  if (!config.symbol || config.symbol.length < 5) {
    throw new Error('Config error: SYMBOL is invalid');
  }
  if (!config.simulasi && (!config.apiKey || config.apiKey === 'your_key')) {
    throw new Error('Config error: MEXC_API_KEY is required when SIMULASI=false');
  }
  if (!config.simulasi && (!config.secretKey || config.secretKey === 'your_secret')) {
    throw new Error('Config error: MEXC_SECRET_KEY is required when SIMULASI=false');
  }
}

validate();

module.exports = config;
