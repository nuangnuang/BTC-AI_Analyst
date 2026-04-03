'use strict';

/**
 * MEXC Market Maker Bot — Entry Point
 *
 * Dual-mode HFT bot for MEXC Spot exchange.
 * - SIMULASI=true  → Paper trading with mock execution engine
 * - SIMULASI=false → Live trading via MEXC API v3 with LIMIT_MAKER (Post-Only)
 *
 * Usage:
 *   node index.js          # Reads mode from .env
 *   SIMULASI=true node index.js   # Force simulation mode
 */

const config = require('./config');
const logger = require('./logger');
const { MarketMakingEngine } = require('./engine');

let engine = null;

/**
 * Print startup banner with configuration summary.
 */
function printBanner() {
  const divider = '═'.repeat(56);
  console.log('');
  console.log(`╔${divider}╗`);
  console.log(`║  MEXC Market Maker Bot v1.0                          ║`);
  console.log(`╠${divider}╣`);
  console.log(`║  Symbol:       ${config.symbol.padEnd(39)}║`);
  console.log(`║  Mode:         ${(config.simulasi ? 'SIMULATION (Paper Trading)' : 'REAL (Live Orders)').padEnd(39)}║`);
  console.log(`║  Grid Size:    ${(config.quantityPerGridUsdt + ' USDT').padEnd(39)}║`);
  console.log(`║  Max Sets:     ${String(config.maxSet).padEnd(39)}║`);
  console.log(`║  Rebalance:    ${((config.rebalanceThreshold * 100) + '%').padEnd(39)}║`);
  console.log(`║  Min Spread:   ${((config.MIN_SPREAD_PCT * 100).toFixed(2) + '%').padEnd(39)}║`);
  console.log(`║  Sell-Only:    ${('>' + (config.SELL_ONLY_THRESHOLD * 100) + '% token ratio').padEnd(39)}║`);
  console.log(`╚${divider}╝`);
  console.log('');
}

/**
 * Graceful shutdown handler.
 * Cancels open orders and disconnects WebSocket before exit.
 */
async function shutdown(signal) {
  logger.info(`Received ${signal}. Initiating graceful shutdown...`);

  if (engine) {
    try {
      await engine.stop();
    } catch (err) {
      logger.error(`Error during shutdown: ${err.message}`);
    }
  }

  logger.info('Goodbye.');
  process.exit(0);
}

/**
 * Main entry point.
 */
async function main() {
  printBanner();

  // Safety warning for real mode
  if (!config.simulasi) {
    logger.warn('╔══════════════════════════════════════════════════╗');
    logger.warn('║  LIVE TRADING MODE — Real orders will be placed ║');
    logger.warn('║  on MEXC exchange. Ensure API keys are correct. ║');
    logger.warn('╚══════════════════════════════════════════════════╝');
  }

  // Register shutdown handlers
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Catch unhandled errors to prevent silent crashes
  process.on('uncaughtException', (err) => {
    logger.error(`Uncaught exception: ${err.message}`);
    logger.error(err.stack || '');
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled rejection: ${reason}`);
    // Don't crash on unhandled rejection — log and continue
  });

  // Create and start engine
  engine = new MarketMakingEngine();

  try {
    await engine.start();
  } catch (err) {
    logger.error(`Failed to start engine: ${err.message}`);
    process.exit(1);
  }
}

main();
