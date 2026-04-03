'use strict';

const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '.env') });

/**
 * Parse and validate all environment variables.
 * Throws on missing or invalid required fields.
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

  // --- Validation ---
  const errors = [];

  if (!raw.symbol || typeof raw.symbol !== 'string' || raw.symbol.length < 4) {
    errors.push('SYMBOL is required and must be a valid trading pair (e.g. BTCUSDT)');
  }

  const simulasi = raw.simulasi === 'true' || raw.simulasi === '1';

  const quantityPerGridUsdt = parseFloat(raw.quantityPerGridUsdt);
  if (isNaN(quantityPerGridUsdt) || quantityPerGridUsdt <= 0) {
    errors.push('QUANTITY_PER_GRID_USDT must be a positive number');
  }

  const maxSet = parseInt(raw.maxSet, 10);
  if (isNaN(maxSet) || maxSet < 1) {
    errors.push('MAX_SET must be an integer >= 1');
  }

  const rebalanceThreshold = parseFloat(raw.rebalanceThreshold);
  if (isNaN(rebalanceThreshold) || rebalanceThreshold <= 0 || rebalanceThreshold >= 1) {
    errors.push('REBALANCE_THRESHOLD must be between 0 and 1 (exclusive)');
  }

  if (!simulasi) {
    if (!raw.apiKey || raw.apiKey === 'your_key') {
      errors.push('MEXC_API_KEY is required for REAL mode');
    }
    if (!raw.secretKey || raw.secretKey === 'your_secret') {
      errors.push('MEXC_SECRET_KEY is required for REAL mode');
    }
  }

  if (errors.length > 0) {
    throw new Error(`Configuration errors:\n  - ${errors.join('\n  - ')}`);
  }

  // --- Derived constants ---
  const baseAsset  = raw.symbol.replace(/USDT$/, '');
  const quoteAsset = 'USDT';

  return Object.freeze({
    symbol:               raw.symbol.toUpperCase(),
    baseAsset,
    quoteAsset,
    simulasi,
    quantityPerGridUsdt,
    maxSet,
    rebalanceThreshold,
    apiKey:               raw.apiKey || '',
    secretKey:            raw.secretKey || '',

    // Trading constants
    MIN_SPREAD_PCT:       0.0002,   // 0.02% minimum spread to place orders
    SELL_ONLY_THRESHOLD:  0.65,     // Token > 65% → sell-only mode
    TARGET_RATIO:         0.50,     // Target 50:50 balance
    PNL_REPORT_INTERVAL:  5 * 60 * 1000, // 5 minutes

    // MEXC endpoints
    REST_BASE:            'https://api.mexc.com',
    WS_BASE:              'wss://wbs.mexc.com/ws',

    // Timing
    ORDER_REFRESH_MS:     2000,     // Re-evaluate orders every 2s
    WS_PING_INTERVAL:     30000,    // WebSocket keepalive
  });
}

module.exports = loadConfig();
