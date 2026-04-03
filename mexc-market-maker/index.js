'use strict';

const config = require('./config');
const logger = require('./logger');
const MarketMakerEngine = require('./engine');

// ---------------------------------------------------------------------------
// Entry Point
// ---------------------------------------------------------------------------

async function main() {
  const engine = new MarketMakerEngine();

  // Graceful shutdown on SIGINT / SIGTERM
  const shutdown = (signal) => {
    logger.info(`Received ${signal} — shutting down gracefully...`);
    engine.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Global uncaught error handlers to prevent crash
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', err);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', reason);
  });

  try {
    await engine.start();
  } catch (err) {
    logger.error('Fatal error during startup', err);
    process.exit(1);
  }
}

main();
