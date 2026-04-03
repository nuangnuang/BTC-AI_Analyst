'use strict';

const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '.env') });

/**
 * Parse and validate all environment configuration.
 * Throws on missing or invalid required parameters.
 */
function loadConfig() {
  const raw = {
    symbol:               process.env.SYMBOL,
    simulasi:             process.env.SIMULASI,
    quantityPerGridUsdt:  process.env.QUANTITY_PER_GRID_USDT,
    maxSet:               process.env.MAX_SET,
    rebalanceThreshold:   process.env.REBALANCE_THRESHOLD,
    apiKey:               process.env.MEXC_API_KEY,
    secretKey:            process.env.MEXC_SECRET_KEY,
  };

  // --- Required string fields ---
  if (!raw.symbol || typeof raw.symbol !== 'string') {
    throw new Error('SYMBOL is required (e.g. BTCUSDT)');
  }

  // --- Boolean parse ---
  const simulasi = String(raw.simulasi).toLowerCase() === 'true';

  // --- Numeric parse with validation ---
  const quantityPerGridUsdt = parseFloat(raw.quantityPerGridUsdt);
  if (isNaN(quantityPerGridUsdt) || quantityPerGridUsdt <= 0) {
    throw new Error('QUANTITY_PER_GRID_USDT must be a positive number');
  }

  const maxSet = parseInt(raw.maxSet, 10);
  if (isNaN(maxSet) || maxSet < 1) {
    throw new Error('MAX_SET must be an integer >= 1');
  }

  const rebalanceThreshold = parseFloat(raw.rebalanceThreshold);
  if (isNaN(rebalanceThreshold) || rebalanceThreshold <= 0 || rebalanceThreshold >= 1) {
    throw new Error('REBALANCE_THRESHOLD must be between 0 and 1 (e.g. 0.15)');
  }

  // --- API keys required only in real mode ---
  if (!simulasi) {
    if (!raw.apiKey || raw.apiKey === 'your_key') {
      throw new Error('MEXC_API_KEY is required when SIMULASI=false');
    }
    if (!raw.secretKey || raw.secretKey === 'your_secret') {
      throw new Error('MEXC_SECRET_KEY is required when SIMULASI=false');
    }
  }

  // --- Derived constants ---
  const symbol = raw.symbol.toUpperCase();
  const baseAsset  = symbol.replace('USDT', '');  // e.g. BTC
  const quoteAsset = 'USDT';

  // Minimum spread to place orders (0.02% = 0.0002)
  const MIN_SPREAD_PCT = 0.0002;

  // Inventory hard-stop threshold for one-sided mode
  const INVENTORY_HARD_LIMIT = 0.65;

  // Performance summary interval (ms)
  const PNL_REPORT_INTERVAL_MS = 5 * 60 * 1000;

  // WebSocket reconnect delay (ms)
  const WS_RECONNECT_DELAY_MS = 3000;

  // Order refresh cycle (ms)
  const ORDER_CYCLE_MS = 1000;

  return Object.freeze({
    symbol,
    baseAsset,
    quoteAsset,
    simulasi,
    quantityPerGridUsdt,
    maxSet,
    rebalanceThreshold,
    apiKey:    raw.apiKey  || '',
    secretKey: raw.secretKey || '',
    MIN_SPREAD_PCT,
    INVENTORY_HARD_LIMIT,
    PNL_REPORT_INTERVAL_MS,
    WS_RECONNECT_DELAY_MS,
    ORDER_CYCLE_MS,
  });
}

module.exports = loadConfig();
