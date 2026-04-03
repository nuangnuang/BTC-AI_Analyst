'use strict';

const config = require('./config');
const logger = require('./logger');
const { MexcRest, MexcWebSocket } = require('./mexc-api');

// ---------------------------------------------------------------------------
// Unique ID generator for simulation orders
// ---------------------------------------------------------------------------
let _simIdSeq = 0;
function simOrderId() {
  return `SIM-${Date.now()}-${++_simIdSeq}`;
}

// ---------------------------------------------------------------------------
// MarketMakerEngine
// ---------------------------------------------------------------------------

class MarketMakerEngine {
  constructor() {
    this.rest = new MexcRest();
    this.ws = new MexcWebSocket();

    // Current best bid/ask from WebSocket
    this.bestBid = null;
    this.bestAsk = null;

    // Active order tracking: Map<orderId, { side, price, qty, ts }>
    this.activeOrders = new Map();

    // Inventory tracking (virtual for simulation, real for live)
    this.baseBalance = 0;   // e.g. BTC
    this.quoteBalance = 0;  // USDT

    // P&L tracking
    this.realizedPnl = 0;
    this.totalBuyQty = 0;
    this.totalBuyUsdt = 0;
    this.totalSellQty = 0;
    this.totalSellUsdt = 0;
    this.buyFills = 0;
    this.sellFills = 0;

    // Exchange info cache
    this.tickSize = 0.01;
    this.stepSize = 0.00001;
    this.minNotional = 5;

    // Engine state
    this._running = false;
    this._tickInterval = null;
    this._perfInterval = null;
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  async start() {
    logger.banner();

    // Fetch exchange info for precision
    await this._loadExchangeInfo();

    // Initialize inventory
    await this._initInventory();

    // Wire up WebSocket
    this.ws.onUpdate((data) => this._onDepthUpdate(data));
    this.ws.connect();

    // Main tick loop every 500ms (evaluates orders)
    this._running = true;
    this._tickInterval = setInterval(() => this._tick(), 500);

    // Performance summary every 5 minutes
    this._perfInterval = setInterval(() => this._logPerformance(), config.perfIntervalMs);

    logger.info('Engine started — waiting for WebSocket data...');
  }

  stop() {
    this._running = false;
    if (this._tickInterval) clearInterval(this._tickInterval);
    if (this._perfInterval) clearInterval(this._perfInterval);
    this.ws.disconnect();
    this._logPerformance();
    logger.info('Engine stopped');
  }

  // =========================================================================
  // Initialization helpers
  // =========================================================================

  /** Load symbol precision from exchange info */
  async _loadExchangeInfo() {
    try {
      const info = await this.rest.getExchangeInfo();

      // Parse filters
      if (info.baseAssetPrecision) {
        this.stepSize = Math.pow(10, -info.baseAssetPrecision);
      }
      if (info.quotePrecision) {
        this.tickSize = Math.pow(10, -info.quotePrecision);
      }

      // Try to read filters array if available
      if (info.filters) {
        for (const f of info.filters) {
          if (f.filterType === 'PRICE_FILTER' && f.tickSize) {
            this.tickSize = parseFloat(f.tickSize);
          }
          if (f.filterType === 'LOT_SIZE' && f.stepSize) {
            this.stepSize = parseFloat(f.stepSize);
          }
          if (f.filterType === 'MIN_NOTIONAL' && f.minNotional) {
            this.minNotional = parseFloat(f.minNotional);
          }
        }
      }

      logger.info(`Exchange info loaded — tick: ${this.tickSize}, step: ${this.stepSize}, minNotional: ${this.minNotional}`);
    } catch (err) {
      logger.error('Failed to load exchange info, using defaults', err);
    }
  }

  /** Initialize inventory: simulation starts with 500 USDT + equivalent base, real reads from API */
  async _initInventory() {
    if (config.simulasi) {
      // Paper trading: start with $500 USDT and 0 base (50/50 will be bought in)
      this.quoteBalance = 500;
      this.baseBalance = 0;
      logger.info(`Simulation inventory initialized: ${this.baseBalance} ${config.baseAsset} / ${this.quoteBalance} ${config.quoteAsset}`);
    } else {
      try {
        const balances = await this.rest.getBalances();
        const base = balances[config.baseAsset];
        const quote = balances[config.quoteAsset];
        this.baseBalance = base ? base.free : 0;
        this.quoteBalance = quote ? quote.free : 0;
        logger.info(`Live inventory loaded: ${this.baseBalance} ${config.baseAsset} / ${this.quoteBalance} ${config.quoteAsset}`);
      } catch (err) {
        logger.error('Failed to load live balances', err);
        throw err;
      }
    }
  }

  // =========================================================================
  // WebSocket callback
  // =========================================================================

  _onDepthUpdate(data) {
    this.bestBid = data.bestBid;
    this.bestAsk = data.bestAsk;
  }

  // =========================================================================
  // Main tick — called every 500ms
  // =========================================================================

  _tick() {
    if (!this._running || this.bestBid == null || this.bestAsk == null) return;

    const spread = this._calcSpread();
    const invRatio = this._inventoryRatio();
    const mode = this._determineMode(invRatio);

    // Check for simulation fills
    if (config.simulasi) {
      this._checkSimFills();
    }

    // Log status (throttled internally)
    logger.status(spread, invRatio, mode);

    // Spread gating: only place orders when spread > minSpread
    if (spread < config.minSpread) {
      logger.status(spread, invRatio, `${mode} — Spread too tight, waiting`, 'spread_gate');
      return;
    }

    // Count active sets
    const activeBuys = [...this.activeOrders.values()].filter((o) => o.side === 'BUY').length;
    const activeSells = [...this.activeOrders.values()].filter((o) => o.side === 'SELL').length;

    // Place orders up to maxSet
    if (mode === 'NORMAL' || mode === 'SELL_ONLY') {
      // SELL side
      if (activeSells < config.maxSet && this.baseBalance > 0) {
        this._placeAsk();
      }
    }

    if (mode === 'NORMAL' || mode === 'BUY_ONLY') {
      // BUY side
      if (activeBuys < config.maxSet && this.quoteBalance >= config.quantityPerGridUsdt) {
        this._placeBid();
      }
    }

    // Expire stale simulation orders
    if (config.simulasi) {
      this._expireSimOrders();
    }
  }

  // =========================================================================
  // Spread & Inventory calculations
  // =========================================================================

  /** Calculate spread as a fraction of mid price */
  _calcSpread() {
    if (!this.bestBid || !this.bestAsk) return 0;
    const mid = (this.bestBid + this.bestAsk) / 2;
    return (this.bestAsk - this.bestBid) / mid;
  }

  /** Returns the fraction of total portfolio value held in base asset (0..1) */
  _inventoryRatio() {
    if (!this.bestBid) return 0.5; // default balanced
    const mid = (this.bestBid + this.bestAsk) / 2;
    const baseValue = this.baseBalance * mid;
    const totalValue = baseValue + this.quoteBalance;
    if (totalValue <= 0) return 0.5;
    return baseValue / totalValue;
  }

  /**
   * Determine trading mode based on inventory ratio:
   * - SELL_ONLY: when token ratio > sellOnlyThreshold (65%)
   * - BUY_ONLY : when token ratio < (1 - sellOnlyThreshold) (35%)
   * - NORMAL   : balanced, place both sides
   */
  _determineMode(invRatio) {
    if (invRatio > config.sellOnlyThreshold) {
      logger.rebalance(`Token ratio ${(invRatio * 100).toFixed(1)}% > ${(config.sellOnlyThreshold * 100).toFixed(0)}% — SELL-ONLY mode`);
      return 'SELL_ONLY';
    }
    if (invRatio < 1 - config.sellOnlyThreshold) {
      logger.rebalance(`Token ratio ${(invRatio * 100).toFixed(1)}% < ${((1 - config.sellOnlyThreshold) * 100).toFixed(0)}% — BUY-ONLY mode`);
      return 'BUY_ONLY';
    }
    return 'NORMAL';
  }

  // =========================================================================
  // Order placement
  // =========================================================================

  /** Round price down to tick size */
  _roundPrice(price) {
    return Math.round(price / this.tickSize) * this.tickSize;
  }

  /** Round quantity down to step size */
  _roundQty(qty) {
    return Math.floor(qty / this.stepSize) * this.stepSize;
  }

  /** Place a BUY order at best bid */
  async _placeBid() {
    const price = this._roundPrice(this.bestBid);
    const qty = this._roundQty(config.quantityPerGridUsdt / price);

    if (price <= 0 || qty <= 0) return;
    if (price * qty < this.minNotional) return;

    // Ensure we have enough quote
    if (this.quoteBalance < price * qty) return;

    if (config.simulasi) {
      this._placeSimOrder('BUY', price, qty);
    } else {
      await this._placeRealOrder('BUY', price, qty);
    }
  }

  /** Place a SELL order at best ask */
  async _placeAsk() {
    const price = this._roundPrice(this.bestAsk);
    const qty = this._roundQty(config.quantityPerGridUsdt / price);

    if (price <= 0 || qty <= 0) return;
    if (price * qty < this.minNotional) return;

    // Ensure we have enough base
    if (this.baseBalance < qty) return;

    if (config.simulasi) {
      this._placeSimOrder('SELL', price, qty);
    } else {
      await this._placeRealOrder('SELL', price, qty);
    }
  }

  // =========================================================================
  // Real order execution (LIMIT_MAKER = Post-Only)
  // =========================================================================

  async _placeRealOrder(side, price, qty) {
    try {
      const res = await this.rest.placeLimitMaker(side, price, qty);
      const orderId = res.orderId || res.id;
      this.activeOrders.set(orderId, { side, price, qty, ts: Date.now(), real: true });
      logger.order(side, price, qty, 'PLACED');

      // Lock funds
      if (side === 'BUY') {
        this.quoteBalance -= price * qty;
      } else {
        this.baseBalance -= qty;
      }
    } catch (err) {
      logger.error(`Real order placement failed: ${side}`, err);
    }
  }

  // =========================================================================
  // Simulation engine
  // =========================================================================

  /** Place a simulated order — tracked locally, fill checked against live prices */
  _placeSimOrder(side, price, qty) {
    const orderId = simOrderId();
    this.activeOrders.set(orderId, { side, price, qty, ts: Date.now(), real: false });
    logger.order(side, price, qty, 'SIM_PLACED');

    // Lock funds in simulation
    if (side === 'BUY') {
      this.quoteBalance -= price * qty;
    } else {
      this.baseBalance -= qty;
    }
  }

  /**
   * Simulation fill logic:
   * - BUY order fills when bestAsk <= order price (market crossed down to our bid)
   * - SELL order fills when bestBid >= order price (market crossed up to our ask)
   */
  _checkSimFills() {
    if (this.bestBid == null || this.bestAsk == null) return;

    for (const [orderId, order] of this.activeOrders) {
      if (order.real) continue; // skip real orders in sim check

      let filled = false;

      if (order.side === 'BUY' && this.bestAsk <= order.price) {
        filled = true;
      }
      if (order.side === 'SELL' && this.bestBid >= order.price) {
        filled = true;
      }

      if (filled) {
        this._onFill(orderId, order);
      }
    }
  }

  /** Handle a filled order (simulation or real callback) */
  _onFill(orderId, order) {
    this.activeOrders.delete(orderId);

    if (order.side === 'BUY') {
      // Bought base asset
      this.baseBalance += order.qty;
      this.totalBuyQty += order.qty;
      this.totalBuyUsdt += order.price * order.qty;
      this.buyFills++;
    } else {
      // Sold base asset
      this.quoteBalance += order.price * order.qty;
      this.totalSellQty += order.qty;
      this.totalSellUsdt += order.price * order.qty;
      this.sellFills++;
    }

    // Realized PnL: calculated on matched buy/sell pairs using average cost
    this._updateRealizedPnl();

    const pnl = this.realizedPnl;
    logger.fill(order.side, order.price, order.qty, pnl);
  }

  /** Calculate realized PnL using FIFO-style average cost */
  _updateRealizedPnl() {
    // Average buy price
    const avgBuy = this.totalBuyQty > 0 ? this.totalBuyUsdt / this.totalBuyQty : 0;
    // Matched quantity (min of total buy and sell)
    const matchedQty = Math.min(this.totalBuyQty, this.totalSellQty);
    // Average sell price
    const avgSell = this.totalSellQty > 0 ? this.totalSellUsdt / this.totalSellQty : 0;

    this.realizedPnl = matchedQty * (avgSell - avgBuy);
  }

  /** Expire simulation orders older than simOrderTtlMs */
  _expireSimOrders() {
    const now = Date.now();
    for (const [orderId, order] of this.activeOrders) {
      if (order.real) continue;
      if (now - order.ts > config.simOrderTtlMs) {
        // Return locked funds
        if (order.side === 'BUY') {
          this.quoteBalance += order.price * order.qty;
        } else {
          this.baseBalance += order.qty;
        }
        this.activeOrders.delete(orderId);
      }
    }
  }

  // =========================================================================
  // Performance reporting
  // =========================================================================

  _logPerformance() {
    const mid = this.bestBid && this.bestAsk ? (this.bestBid + this.bestAsk) / 2 : 0;
    const baseValue = this.baseBalance * mid;
    const totalValue = baseValue + this.quoteBalance;
    const invRatio = totalValue > 0 ? baseValue / totalValue : 0.5;

    // Unrealized PnL: value of remaining base at current mid vs. avg buy price
    const avgBuy = this.totalBuyQty > 0 ? this.totalBuyUsdt / this.totalBuyQty : 0;
    const unrealizedQty = this.totalBuyQty - this.totalSellQty;
    const unrealizedPnl = unrealizedQty > 0 ? unrealizedQty * (mid - avgBuy) : 0;

    logger.perf({
      totalTrades: this.buyFills + this.sellFills,
      buyFills: this.buyFills,
      sellFills: this.sellFills,
      realizedPnl: this.realizedPnl,
      unrealizedPnl,
      baseBalance: this.baseBalance,
      quoteBalance: this.quoteBalance,
      inventoryRatio: invRatio,
    });
  }
}

module.exports = MarketMakerEngine;
