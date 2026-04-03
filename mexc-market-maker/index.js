'use strict';

const config = require('./config');
const log = require('./logger');
const TradingEngine = require('./engine');

// ─── Banner ──────────────────────────────────────────────────────────
function printBanner() {
  console.log('');
  console.log('='.repeat(60));
  console.log('  MEXC Market Maker Bot v1.0');
  console.log(`  Mode:   ${config.simulasi ? 'SIMULATION (Paper Trading)' : 'REAL (Live Orders)'}`);
  console.log(`  Symbol: ${config.symbol}`);
  console.log(`  Grid:   ${config.quantityPerGridUsdt} USDT x ${config.maxSet} sets`);
  console.log(`  Rebal:  ${(config.rebalanceThreshold * 100).toFixed(0)}% threshold`);
  console.log('='.repeat(60));
  console.log('');
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  printBanner();

  const engine = new TradingEngine();

  // ── Graceful Shutdown ──────────────────────────────────────────
  const shutdown = async (signal) => {
    log.info(`Received ${signal}. Shutting down gracefully...`);
    await engine.stop();
    process.exit(0);
  };

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Catch unhandled errors so the bot doesn't crash silently
  process.on('uncaughtException', (err) => {
    log.error(`Uncaught exception: ${err.message}`);
    log.error(err.stack || '');
  });

  process.on('unhandledRejection', (reason) => {
    log.error(`Unhandled rejection: ${reason}`);
  });

  // ── Start Engine ───────────────────────────────────────────────
  try {
    await engine.start();
    log.info('Bot is running. Press Ctrl+C to stop.');
  } catch (err) {
    log.error(`Fatal startup error: ${err.message}`);
    process.exit(1);
  }
}

main();
