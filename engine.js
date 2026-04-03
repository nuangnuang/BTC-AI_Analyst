'use strict';

const config = require('./config');
const logger = require('./logger');
const api    = require('./mexc-api');

// ─────────────────────────────────────────────
//  Execution Manager — Dual Mode (Sim / Real)
// ─────────────────────────────────────────────

class ExecutionManager {
  constructor() {
    this.simulasi = config.simulasi;
    this.simOrders = new Map();    // orderId → { side, price, qty, status, createdAt }
    this.simOrderIdCounter = 0;
    this.simFills = [];            // Array of filled sim orders
  }

  /**
   * Place an order. Routes to simulation or real API based on config.
   * @param {'BUY'|'SELL'} side
   * @param {number} price
   * @param {number} qty - Quantity in base asset
   * @returns {Promise<{orderId: string|number, side: string, price: number, qty: number}>}
   */
  async placeOrder(side, price, qty) {
    if (this.simulasi) {
      return this._simPlaceOrder(side, price, qty);
    }
    return this._realPlaceOrder(side, price, qty);
  }

  /**
   * Cancel an order by ID.
   */
  async cancelOrder(orderId) {
    if (this.simulasi) {
      return this._simCancelOrder(orderId);
    }
    return this._realCancelOrder(orderId);
  }

  /**
   * Get all active (open) orders.
   */
  getActiveOrders() {
    if (this.simulasi) {
      return Array.from(this.simOrders.values()).filter(o => o.status === 'OPEN');
    }
    return []; // Real mode uses API polling
  }

  // ─── Simulation Mode ─────────────────────

  _simPlaceOrder(side, price, qty) {
    const orderId = `SIM_${++this.simOrderIdCounter}`;
    const order = {
      orderId,
      side,
      price,
      qty,
      status: 'OPEN',
      createdAt: Date.now(),
    };
    this.simOrders.set(orderId, order);
    logger.logOrder('PLACED', { side, price: price.toFixed(2), qty: qty.toFixed(8) });
    return order;
  }

  _simCancelOrder(orderId) {
    const order = this.simOrders.get(orderId);
    if (order && order.status === 'OPEN') {
      order.status = 'CANCELLED';
      logger.logOrder('CANCELLED', { side: order.side, price: order.price.toFixed(2), qty: order.qty.toFixed(8) });
    }
    return order;
  }

  /**
   * Evaluate simulated orders against live market data.
   * A BUY order fills if bestBid <= order price (market willing to sell at our buy price).
   * A SELL order fills if bestAsk >= order price (market willing to buy at our sell price).
   *
   * This models realistic maker fill logic: our limit order rests on the book,
   * and fills when the market price crosses through our level.
   */
  checkSimFills(bestBid, bestAsk) {
    const fills = [];
    for (const [id, order] of this.simOrders) {
      if (order.status !== 'OPEN') continue;

      let filled = false;
      if (order.side === 'BUY' && bestAsk <= order.price) {
        filled = true;
      } else if (order.side === 'SELL' && bestBid >= order.price) {
        filled = true;
      }

      if (filled) {
        order.status = 'FILLED';
        order.filledAt = Date.now();
        this.simFills.push(order);
        fills.push(order);
        logger.logTrade({
          side: order.side,
          price: order.price.toFixed(2),
          qty: order.qty.toFixed(8),
          mode: 'SIMULATED',
        });
      }
    }
    return fills;
  }

  // ─── Real Mode ────────────────────────────

  async _realPlaceOrder(side, price, qty) {
    try {
      const result = await api.placeLimitMakerOrder(side, price, qty);
      logger.logOrder('PLACED', { side, price: price.toFixed(2), qty: qty.toFixed(8) });
      return {
        orderId: result.orderId,
        side,
        price,
        qty,
        status: 'OPEN',
      };
    } catch (err) {
      logger.error(`Failed to place ${side} order: ${err.message}`);
      return null;
    }
  }

  async _realCancelOrder(orderId) {
    try {
      await api.cancelOrder(orderId);
      logger.logOrder('CANCELLED', { side: '?', price: '?', qty: '?' });
    } catch (err) {
      logger.error(`Failed to cancel order ${orderId}: ${err.message}`);
    }
  }
}

// ─────────────────────────────────────────────
//  Market Making Engine
// ─────────────────────────────────────────────

class MarketMakingEngine {
  constructor() {
    this.exec = new ExecutionManager();
    this.orderbook = new api.OrderbookStream();

    // Market state
    this.bestBid = 0;
    this.bestAsk = 0;
    this.spread  = 0;

    // Inventory tracking
    this.tokenBalance = 0;
    this.usdtBalance  = 0;
    this.tokenRatio   = 0.5;
    this.usdtRatio    = 0.5;

    // Simulated balances (for paper trading)
    this.simTokenBalance = 0;
    this.simUsdtBalance  = 100; // Start with 100 USDT in sim

    // Active order tracking
    this.activeBuyOrder  = null;
    this.activeSellOrder = null;

    // P&L tracking
    this.startTime    = Date.now();
    this.totalTrades  = 0;
    this.realizedPnl  = 0;
    this.tradeHistory = []; // { side, price, qty, timestamp }

    // Timers
    this._tickTimer   = null;
    this._pnlTimer    = null;

    // Exchange info cache
    this.tickSize     = 0.01;
    this.stepSize     = 0.00001;
    this.minNotional  = 5;
  }

  /**
   * Initialize the engine: fetch exchange info, initial balances, connect WS.
   */
  async start() {
    logger.info(`Starting Market Making Engine for ${config.symbol}`);
    logger.info(`Mode: ${config.simulasi ? 'SIMULATION' : 'REAL'}`);
    logger.info(`Grid Size: ${config.quantityPerGridUsdt} USDT | Max Sets: ${config.maxSet}`);

    // Load exchange info for precision
    try {
      const info = await api.getExchangeInfo();
      if (info.filters) {
        for (const f of info.filters) {
          if (f.filterType === 'PRICE_FILTER') this.tickSize = parseFloat(f.tickSize) || this.tickSize;
          if (f.filterType === 'LOT_SIZE') this.stepSize = parseFloat(f.stepSize) || this.stepSize;
          if (f.filterType === 'MIN_NOTIONAL') this.minNotional = parseFloat(f.minNotional) || this.minNotional;
        }
      }
      // MEXC v3 uses direct precision values
      if (info.baseSizePrecision != null) {
        const bsp = parseFloat(info.baseSizePrecision);
        // baseSizePrecision can be a direct step value (e.g. 0.000001) or an integer precision
        this.stepSize = bsp < 1 ? bsp : Math.pow(10, -bsp);
      }
      if (info.quotePrecision != null) {
        const qp = parseFloat(info.quotePrecision);
        // quotePrecision is an integer (number of decimal places)
        this.tickSize = qp >= 1 ? Math.pow(10, -qp) : qp;
      }
      logger.info(`Exchange info loaded. Tick: ${this.tickSize} | Step: ${this.stepSize}`);
    } catch (err) {
      logger.warn(`Could not load exchange info: ${err.message}. Using defaults.`);
    }

    // Initialize balances
    await this._refreshBalances();

    // Connect WebSocket
    this.orderbook.onUpdate((data) => this._onOrderbookUpdate(data));
    this.orderbook.connect();

    // Start main tick loop
    this._tickTimer = setInterval(() => this._tick(), config.ORDER_REFRESH_MS);

    // Start P&L reporting
    this._pnlTimer = setInterval(() => this._reportPnL(), config.PNL_REPORT_INTERVAL);

    logger.info('Engine started. Waiting for market data...');
  }

  /**
   * Stop the engine gracefully.
   */
  async stop() {
    logger.info('Stopping engine...');

    if (this._tickTimer) clearInterval(this._tickTimer);
    if (this._pnlTimer) clearInterval(this._pnlTimer);

    // Cancel active orders
    await this._cancelAllOrders();

    // Disconnect WebSocket
    this.orderbook.disconnect();

    // Final P&L report
    this._reportPnL();
    logger.info('Engine stopped.');
  }

  /**
   * Handle real-time orderbook updates from WebSocket.
   */
  _onOrderbookUpdate({ bestBid, bestAsk, spread }) {
    this.bestBid = bestBid;
    this.bestAsk = bestAsk;
    this.spread  = spread;

    // In simulation mode, check if any sim orders got filled
    if (config.simulasi) {
      const fills = this.exec.checkSimFills(bestBid, bestAsk);
      for (const fill of fills) {
        this._onOrderFilled(fill);
      }
    }
  }

  /**
   * Main tick: evaluate market conditions and place/adjust orders.
   * Runs every ORDER_REFRESH_MS.
   */
  async _tick() {
    if (this.bestBid === 0 || this.bestAsk === 0) return; // No market data yet

    // Determine trading status
    const status = this._getTradingStatus();

    // Log market state (throttled)
    logger.logMarketState({
      spread:     this.spread,
      tokenRatio: this.tokenRatio,
      usdtRatio:  this.usdtRatio,
      status,
    });

    // Spread too tight — don't market-make
    if (this.spread < config.MIN_SPREAD_PCT) {
      logger.info(`Spread ${(this.spread * 100).toFixed(4)}% < min ${(config.MIN_SPREAD_PCT * 100).toFixed(4)}%. Skipping.`, 'spread_skip');
      return;
    }

    // Count active sets
    const activeBuys  = this.activeBuyOrder ? 1 : 0;
    const activeSells = this.activeSellOrder ? 1 : 0;

    // Determine which sides to quote based on inventory
    const canBuy  = status !== 'SELL_ONLY' && activeBuys < config.maxSet;
    const canSell = status !== 'BUY_ONLY' && activeSells < config.maxSet;

    // Calculate order prices: place inside the spread
    const midPrice = (this.bestBid + this.bestAsk) / 2;
    const halfSpread = (this.bestAsk - this.bestBid) / 2;

    // Place orders slightly inside the spread for better fills
    const buyPrice  = this._roundPrice(this.bestBid + this.tickSize);
    const sellPrice = this._roundPrice(this.bestAsk - this.tickSize);

    // Ensure buy < sell
    if (buyPrice >= sellPrice) return;

    // Calculate quantities
    const buyQty  = this._roundQty(config.quantityPerGridUsdt / buyPrice);
    const sellQty = this._roundQty(config.quantityPerGridUsdt / sellPrice);

    // Check minimum notional
    if (buyQty * buyPrice < this.minNotional || sellQty * sellPrice < this.minNotional) {
      logger.warn('Order size below minimum notional. Skipping.', 'min_notional');
      return;
    }

    // ─── Place BUY order ─────────────────
    if (canBuy && !this.activeBuyOrder) {
      // Check if we have enough USDT
      const requiredUsdt = buyQty * buyPrice;
      const availableUsdt = config.simulasi ? this.simUsdtBalance : this.usdtBalance;
      if (availableUsdt >= requiredUsdt) {
        const order = await this.exec.placeOrder('BUY', buyPrice, buyQty);
        if (order) this.activeBuyOrder = order;
      } else {
        logger.info(`Insufficient USDT for BUY (need ${requiredUsdt.toFixed(2)}, have ${availableUsdt.toFixed(2)})`, 'insufficient_usdt');
      }
    }

    // ─── Place SELL order ────────────────
    if (canSell && !this.activeSellOrder) {
      // Check if we have enough tokens
      const availableToken = config.simulasi ? this.simTokenBalance : this.tokenBalance;
      if (availableToken >= sellQty) {
        const order = await this.exec.placeOrder('SELL', sellPrice, sellQty);
        if (order) this.activeSellOrder = order;
      } else {
        logger.info(`Insufficient token for SELL (need ${sellQty.toFixed(8)}, have ${availableToken.toFixed(8)})`, 'insufficient_token');
      }
    }

    // ─── Stale order cleanup: cancel orders that deviated too far from mid ─────
    await this._cleanupStaleOrders(midPrice);
  }

  /**
   * Determine trading status based on inventory ratio.
   * Returns: 'NORMAL' | 'SELL_ONLY' | 'BUY_ONLY'
   */
  _getTradingStatus() {
    const tokenBal = config.simulasi ? this.simTokenBalance : this.tokenBalance;
    const usdtBal  = config.simulasi ? this.simUsdtBalance : this.usdtBalance;

    // Calculate portfolio value in USDT
    const tokenValueUsdt = tokenBal * (this.bestBid || 1);
    const totalValue     = tokenValueUsdt + usdtBal;

    if (totalValue === 0) {
      this.tokenRatio = 0.5;
      this.usdtRatio  = 0.5;
      return 'NORMAL';
    }

    this.tokenRatio = tokenValueUsdt / totalValue;
    this.usdtRatio  = usdtBal / totalValue;

    // Dynamic sizing: If token > 65%, sell-only mode
    if (this.tokenRatio > config.SELL_ONLY_THRESHOLD) {
      return 'SELL_ONLY';
    }

    // Inverse: if USDT > 65%, buy-only mode
    if (this.usdtRatio > config.SELL_ONLY_THRESHOLD) {
      return 'BUY_ONLY';
    }

    // Check rebalance threshold deviation from 50:50
    const deviation = Math.abs(this.tokenRatio - config.TARGET_RATIO);
    if (deviation > config.rebalanceThreshold) {
      return this.tokenRatio > config.TARGET_RATIO ? 'SELL_ONLY' : 'BUY_ONLY';
    }

    return 'NORMAL';
  }

  /**
   * Handle a filled order — update balances and P&L.
   */
  _onOrderFilled(order) {
    this.totalTrades++;
    const { side, price, qty } = order;

    if (config.simulasi) {
      if (side === 'BUY') {
        this.simTokenBalance += qty;
        this.simUsdtBalance  -= qty * price;
      } else {
        this.simTokenBalance -= qty;
        this.simUsdtBalance  += qty * price;
      }
    }

    // Track for P&L calculation
    this.tradeHistory.push({
      side,
      price,
      qty,
      timestamp: Date.now(),
    });

    // Calculate realized P&L from round-trip trades
    this._calculateRealizedPnL();

    // Clear the active order slot so a new one can be placed
    if (side === 'BUY')  this.activeBuyOrder = null;
    if (side === 'SELL') this.activeSellOrder = null;

    logger.info(`Fill processed: ${side} ${qty.toFixed(8)} @ ${price.toFixed(2)} | Token: ${(config.simulasi ? this.simTokenBalance : this.tokenBalance).toFixed(8)} | USDT: ${(config.simulasi ? this.simUsdtBalance : this.usdtBalance).toFixed(2)}`);
  }

  /**
   * Calculate realized P&L using FIFO matching of buys and sells.
   */
  _calculateRealizedPnL() {
    const buys  = this.tradeHistory.filter(t => t.side === 'BUY').map(t => ({ ...t }));
    const sells = this.tradeHistory.filter(t => t.side === 'SELL').map(t => ({ ...t }));

    let pnl = 0;
    let buyIdx = 0;
    let sellIdx = 0;

    // Create mutable copies of remaining quantities
    const buyRemaining  = buys.map(b => b.qty);
    const sellRemaining = sells.map(s => s.qty);

    while (buyIdx < buys.length && sellIdx < sells.length) {
      const matchQty = Math.min(buyRemaining[buyIdx], sellRemaining[sellIdx]);
      if (matchQty <= 0) break;

      pnl += matchQty * (sells[sellIdx].price - buys[buyIdx].price);

      buyRemaining[buyIdx]   -= matchQty;
      sellRemaining[sellIdx] -= matchQty;

      if (buyRemaining[buyIdx] <= 1e-12)  buyIdx++;
      if (sellRemaining[sellIdx] <= 1e-12) sellIdx++;
    }

    this.realizedPnl = pnl;
  }

  /**
   * Cancel orders that have deviated too far from current mid price.
   */
  async _cleanupStaleOrders(midPrice) {
    const maxDeviation = 0.005; // 0.5% from mid

    if (this.activeBuyOrder && this.activeBuyOrder.status === 'OPEN') {
      const dev = Math.abs(this.activeBuyOrder.price - midPrice) / midPrice;
      if (dev > maxDeviation) {
        await this.exec.cancelOrder(this.activeBuyOrder.orderId);
        this.activeBuyOrder = null;
      }
    }

    if (this.activeSellOrder && this.activeSellOrder.status === 'OPEN') {
      const dev = Math.abs(this.activeSellOrder.price - midPrice) / midPrice;
      if (dev > maxDeviation) {
        await this.exec.cancelOrder(this.activeSellOrder.orderId);
        this.activeSellOrder = null;
      }
    }
  }

  /**
   * Cancel all active orders.
   */
  async _cancelAllOrders() {
    if (this.activeBuyOrder) {
      await this.exec.cancelOrder(this.activeBuyOrder.orderId);
      this.activeBuyOrder = null;
    }
    if (this.activeSellOrder) {
      await this.exec.cancelOrder(this.activeSellOrder.orderId);
      this.activeSellOrder = null;
    }

    // In real mode, also cancel any server-side open orders
    if (!config.simulasi) {
      try {
        const openOrders = await api.getOpenOrders();
        for (const o of openOrders) {
          await api.cancelOrder(o.orderId);
        }
      } catch (err) {
        logger.error(`Failed to cancel open orders: ${err.message}`);
      }
    }
  }

  /**
   * Refresh account balances from exchange (real mode) or internal state (sim).
   */
  async _refreshBalances() {
    if (config.simulasi) {
      // In sim mode, try to get initial price for sim balance calculation
      try {
        const price = await api.getTickerPrice();
        if (this.simTokenBalance === 0 && this.simUsdtBalance > 0) {
          // Start with balanced portfolio: 50% token, 50% USDT
          const halfUsdt = this.simUsdtBalance / 2;
          this.simTokenBalance = halfUsdt / price;
          this.simUsdtBalance  = halfUsdt;
          logger.info(`Sim initialized: ${this.simTokenBalance.toFixed(8)} ${config.baseAsset} / ${this.simUsdtBalance.toFixed(2)} USDT @ ${price.toFixed(2)}`);
        }
      } catch (err) {
        logger.warn(`Could not fetch initial price: ${err.message}. Sim will use WS price.`);
      }
      return;
    }

    // Real mode: fetch from exchange
    try {
      const { baseBalance, quoteBalance } = await api.getAccountBalances();
      this.tokenBalance = baseBalance;
      this.usdtBalance  = quoteBalance;
      logger.info(`Balances: ${baseBalance.toFixed(8)} ${config.baseAsset} / ${quoteBalance.toFixed(2)} USDT`);
    } catch (err) {
      logger.error(`Failed to fetch balances: ${err.message}`);
    }
  }

  /**
   * Print P&L summary report. Runs every PNL_REPORT_INTERVAL.
   */
  _reportPnL() {
    const elapsed = Date.now() - this.startTime;
    const tokenBal = config.simulasi ? this.simTokenBalance : this.tokenBalance;
    const usdtBal  = config.simulasi ? this.simUsdtBalance : this.usdtBalance;

    // Unrealized P&L: current token value vs initial
    const currentTokenValueUsdt = tokenBal * this.bestBid;
    const totalPortfolioValue   = currentTokenValueUsdt + usdtBal;
    const initialValue          = 100; // Initial sim USDT
    const unrealizedPnl         = totalPortfolioValue - initialValue;

    logger.logPnL({
      totalTrades:   this.totalTrades,
      realizedPnl:   this.realizedPnl,
      unrealizedPnl: unrealizedPnl,
      tokenBalance:  tokenBal.toFixed(8),
      usdtBalance:   usdtBal.toFixed(2),
      elapsed,
    });
  }

  // ─── Utility ──────────────────────────────

  /**
   * Round price to exchange tick size.
   */
  _roundPrice(price) {
    const precision = Math.max(0, Math.round(-Math.log10(this.tickSize)));
    return parseFloat(price.toFixed(precision));
  }

  /**
   * Round quantity to exchange step size.
   */
  _roundQty(qty) {
    const precision = Math.max(0, Math.round(-Math.log10(this.stepSize)));
    return parseFloat(qty.toFixed(precision));
  }
}

module.exports = { MarketMakingEngine, ExecutionManager };
