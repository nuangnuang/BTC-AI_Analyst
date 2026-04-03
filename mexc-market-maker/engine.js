'use strict';

const config = require('./config');
const log = require('./logger');
const api = require('./mexc-api');

// ─── Execution Manager (Dual-Mode) ──────────────────────────────────

/**
 * ExecutionManager abstracts order placement/cancellation.
 * In SIMULASI mode: orders are tracked in memory and "filled" when
 * the WebSocket price crosses the order price.
 * In REAL mode: orders are sent to MEXC via REST API with LIMIT_MAKER.
 */
class ExecutionManager {
  constructor() {
    /** @type {Map<string, SimOrder>} */
    this.simOrders = new Map();
    this._nextSimId = 1;
  }

  /**
   * Place an order.
   * @param {'BUY'|'SELL'} side
   * @param {number} price
   * @param {number} quantity  - base asset qty
   * @returns {Promise<{orderId: string, simulated: boolean}>}
   */
  async placeOrder(side, price, quantity) {
    if (config.simulasi) {
      return this._simPlace(side, price, quantity);
    }
    return this._realPlace(side, price, quantity);
  }

  /** Cancel an order by ID. */
  async cancelOrder(orderId) {
    if (config.simulasi) {
      this.simOrders.delete(orderId);
      return true;
    }
    try {
      await api.cancelOrder(orderId);
      return true;
    } catch (err) {
      log.error(`Cancel order ${orderId} failed: ${err.message}`);
      return false;
    }
  }

  /** Cancel all tracked orders. */
  async cancelAll() {
    if (config.simulasi) {
      this.simOrders.clear();
      return;
    }
    try {
      await api.cancelAllOrders();
    } catch (err) {
      log.error(`Cancel all orders failed: ${err.message}`);
    }
  }

  /** Get count of active orders by side. */
  getActiveCount(side) {
    if (config.simulasi) {
      let count = 0;
      for (const o of this.simOrders.values()) {
        if (o.side === side && o.status === 'OPEN') count++;
      }
      return count;
    }
    // In real mode, engine tracks via its own state
    return 0;
  }

  // ── Simulation internals ───────────────────────────────────────────

  _simPlace(side, price, quantity) {
    const orderId = `SIM_${this._nextSimId++}`;
    this.simOrders.set(orderId, {
      orderId,
      side,
      price,
      quantity,
      status: 'OPEN',
      createdAt: Date.now(),
    });
    log.trade(side, price, quantity, true);
    return { orderId, simulated: true };
  }

  async _realPlace(side, price, quantity) {
    try {
      const res = await api.placeLimitMaker(
        side,
        price.toString(),
        quantity.toString()
      );
      log.trade(side, price, quantity, false);
      return { orderId: String(res.orderId), simulated: false };
    } catch (err) {
      log.error(`Place ${side} order failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Check simulated orders against current market price.
   * A BUY order fills when bestBid <= order price.
   * A SELL order fills when bestAsk >= order price.
   * @returns {SimOrder[]} list of newly filled orders
   */
  checkSimFills(bestBid, bestAsk) {
    const filled = [];
    for (const order of this.simOrders.values()) {
      if (order.status !== 'OPEN') continue;

      if (order.side === 'BUY' && bestAsk > 0 && bestAsk <= order.price) {
        order.status = 'FILLED';
        filled.push(order);
      } else if (order.side === 'SELL' && bestBid > 0 && bestBid >= order.price) {
        order.status = 'FILLED';
        filled.push(order);
      }
    }
    // Clean up filled orders from map
    for (const o of filled) {
      this.simOrders.delete(o.orderId);
    }
    return filled;
  }
}

// ─── Trading Engine ──────────────────────────────────────────────────

class TradingEngine {
  constructor() {
    this.exec = new ExecutionManager();

    // Portfolio state (simulation starts with a virtual balance)
    this.balanceBase  = 0;       // Token balance (e.g. BTC)
    this.balanceQuote = 500;     // USDT balance (default sim starting capital)

    // Active order tracking
    this.activeBuyOrders  = new Map();  // orderId -> {price, qty}
    this.activeSellOrders = new Map();

    // P&L tracking
    this.startTime    = Date.now();
    this.totalTrades  = 0;
    this.realizedPnl  = 0;
    this.buyVolume    = 0;
    this.sellVolume   = 0;
    this.avgBuyPrice  = 0;
    this.avgSellPrice = 0;

    // Symbol info
    this.pricePrecision = 2;
    this.qtyPrecision   = 6;
    this.minQty         = 0.00001;

    // Engine state
    this._running = false;
    this._cycleTimer = null;
    this._pnlTimer = null;
    this._unsubWs = null;
  }

  /** Initialize the engine: fetch symbol info, balances, start WS. */
  async start() {
    log.info('Engine starting...');

    // Fetch symbol info for precision
    try {
      const info = await api.getExchangeInfo();
      if (info.baseAssetPrecision) this.qtyPrecision = info.baseAssetPrecision;
      if (info.quotePrecision) this.pricePrecision = info.quotePrecision;
      log.info(`Symbol ${config.symbol}: pricePrecision=${this.pricePrecision}, qtyPrecision=${this.qtyPrecision}`);
    } catch (err) {
      log.warn(`Could not fetch exchange info: ${err.message}. Using defaults.`);
    }

    // Load balances (real mode only)
    if (!config.simulasi) {
      await this._loadRealBalances();
    } else {
      // In simulation, try to get a reference price for initial base allocation
      try {
        const price = await api.getTickerPrice();
        // Start with 50/50 split
        const halfUsdt = this.balanceQuote / 2;
        this.balanceBase  = halfUsdt / price;
        this.balanceQuote = halfUsdt;
        log.info(`Sim starting balances: ${this.balanceBase.toFixed(this.qtyPrecision)} ${config.baseAsset} + ${this.balanceQuote.toFixed(2)} USDT (price=${price})`);
      } catch (err) {
        log.warn(`Could not fetch initial price: ${err.message}`);
      }
    }

    // Connect WebSocket
    api.connectWebSocket();
    this._unsubWs = api.onOrderbookUpdate(ob => this._onOrderbookUpdate(ob));

    // Start main trading cycle
    this._running = true;
    this._cycleTimer = setInterval(() => this._cycle(), config.ORDER_CYCLE_MS);

    // Start P&L reporting
    this._pnlTimer = setInterval(() => this._reportPnl(), config.PNL_REPORT_INTERVAL_MS);

    log.info(`Engine started in ${config.simulasi ? 'SIMULATION' : 'REAL'} mode`);
  }

  /** Graceful shutdown. */
  async stop() {
    log.info('Engine stopping...');
    this._running = false;

    if (this._cycleTimer) { clearInterval(this._cycleTimer); this._cycleTimer = null; }
    if (this._pnlTimer)   { clearInterval(this._pnlTimer);   this._pnlTimer = null; }
    if (this._unsubWs)    { this._unsubWs(); this._unsubWs = null; }

    // Cancel all outstanding orders
    await this.exec.cancelAll();
    this.activeBuyOrders.clear();
    this.activeSellOrders.clear();

    api.disconnectWebSocket();
    this._reportPnl();
    log.info('Engine stopped');
  }

  // ── Balance Management ─────────────────────────────────────────────

  async _loadRealBalances() {
    try {
      const account = await api.getAccountInfo();
      const base  = account.balances.find(b => b.asset === config.baseAsset);
      const quote = account.balances.find(b => b.asset === config.quoteAsset);
      this.balanceBase  = base  ? parseFloat(base.free)  : 0;
      this.balanceQuote = quote ? parseFloat(quote.free)  : 0;
      log.info(`Real balances: ${this.balanceBase} ${config.baseAsset} + ${this.balanceQuote} USDT`);
    } catch (err) {
      log.error(`Failed to load account balances: ${err.message}`);
    }
  }

  // ── Inventory Calculations ─────────────────────────────────────────

  /**
   * Calculate inventory ratio (base value / total portfolio value).
   * Returns 0-1 where 0.5 = perfectly balanced.
   */
  _inventoryRatio(midPrice) {
    if (midPrice <= 0) return 0.5;
    const baseValue  = this.balanceBase * midPrice;
    const totalValue = baseValue + this.balanceQuote;
    if (totalValue <= 0) return 0.5;
    return baseValue / totalValue;
  }

  /**
   * Determine trading mode based on inventory:
   * - NORMAL: place both Buy and Sell
   * - SELL_ONLY: too much base asset, only sell
   * - BUY_ONLY: too much quote, only buy
   */
  _tradingMode(inventoryRatio) {
    if (inventoryRatio > config.INVENTORY_HARD_LIMIT) return 'SELL_ONLY';
    if (inventoryRatio < (1 - config.INVENTORY_HARD_LIMIT)) return 'BUY_ONLY';
    return 'NORMAL';
  }

  // ── Spread & Price Calculation ─────────────────────────────────────

  /**
   * Calculate the spread percentage: (ask - bid) / mid.
   */
  _spreadPct(bestBid, bestAsk) {
    if (bestBid <= 0 || bestAsk <= 0) return 0;
    const mid = (bestBid + bestAsk) / 2;
    return (bestAsk - bestBid) / mid;
  }

  /**
   * Calculate order prices: place orders just inside the spread.
   * Buy at bestBid + 1 tick, Sell at bestAsk - 1 tick.
   */
  _calcOrderPrices(bestBid, bestAsk) {
    const tick = Math.pow(10, -this.pricePrecision);
    const buyPrice  = this._round(bestBid + tick, this.pricePrecision);
    const sellPrice = this._round(bestAsk - tick, this.pricePrecision);
    return { buyPrice, sellPrice };
  }

  /**
   * Calculate order quantity in base asset from USDT budget.
   */
  _calcQuantity(price) {
    if (price <= 0) return 0;
    const qty = config.quantityPerGridUsdt / price;
    return this._round(qty, this.qtyPrecision);
  }

  _round(value, decimals) {
    const factor = Math.pow(10, decimals);
    return Math.round(value * factor) / factor;
  }

  // ── WebSocket Update Handler ───────────────────────────────────────

  _onOrderbookUpdate(ob) {
    // In simulation mode, check if any paper orders got filled
    if (config.simulasi && ob.bestBid > 0 && ob.bestAsk > 0) {
      const filled = this.exec.checkSimFills(ob.bestBid, ob.bestAsk);
      for (const order of filled) {
        this._onOrderFilled(order);
      }
    }
  }

  /**
   * Handle a filled order — update balances and P&L.
   */
  _onOrderFilled(order) {
    const { side, price, quantity } = order;
    this.totalTrades++;

    if (side === 'BUY') {
      this.balanceBase  += quantity;
      this.balanceQuote -= quantity * price;
      this.buyVolume    += quantity * price;
      // Track weighted average buy price
      if (this.avgBuyPrice === 0) {
        this.avgBuyPrice = price;
      } else {
        this.avgBuyPrice = (this.avgBuyPrice + price) / 2;
      }
      this.activeBuyOrders.delete(order.orderId);
      log.info(`FILLED BUY ${quantity} @ ${price} | Balance: ${this.balanceBase.toFixed(this.qtyPrecision)} ${config.baseAsset} + ${this.balanceQuote.toFixed(2)} USDT`);
    } else {
      this.balanceBase  -= quantity;
      this.balanceQuote += quantity * price;
      this.sellVolume   += quantity * price;
      // Realized P&L from sell
      if (this.avgBuyPrice > 0) {
        this.realizedPnl += (price - this.avgBuyPrice) * quantity;
      }
      this.activeSellOrders.delete(order.orderId);
      log.info(`FILLED SELL ${quantity} @ ${price} | Balance: ${this.balanceBase.toFixed(this.qtyPrecision)} ${config.baseAsset} + ${this.balanceQuote.toFixed(2)} USDT`);
    }
  }

  // ── Main Trading Cycle ─────────────────────────────────────────────

  async _cycle() {
    if (!this._running) return;

    const { bestBid, bestAsk } = api.orderbook;

    // Validate market data
    if (bestBid <= 0 || bestAsk <= 0) {
      log.info('Waiting for valid orderbook data...', 'wait_data');
      return;
    }

    const midPrice = (bestBid + bestAsk) / 2;
    const spreadPct = this._spreadPct(bestBid, bestAsk);
    const inventoryRatio = this._inventoryRatio(midPrice);
    const mode = this._tradingMode(inventoryRatio);

    // Log status (throttled)
    log.status({
      spreadPct,
      inventoryBase: this.balanceBase,
      inventoryQuote: this.balanceQuote,
      inventoryRatio,
      mode,
    });

    // ── Spread Hunting: skip if spread too narrow ────────────────
    if (spreadPct < config.MIN_SPREAD_PCT) {
      log.info(`Spread ${(spreadPct * 100).toFixed(4)}% < min ${(config.MIN_SPREAD_PCT * 100).toFixed(4)}%. Waiting...`, 'spread_low');
      return;
    }

    // ── Calculate order prices and quantity ──────────────────────
    const { buyPrice, sellPrice } = this._calcOrderPrices(bestBid, bestAsk);
    const buyQty  = this._calcQuantity(buyPrice);
    const sellQty = this._calcQuantity(sellPrice);

    if (buyQty <= 0 || sellQty <= 0) return;

    // ── Check budget constraints ────────────────────────────────
    const canBuy  = this.balanceQuote >= buyQty * buyPrice;
    const canSell = this.balanceBase >= sellQty;

    // ── Cancel stale orders and refresh ─────────────────────────
    await this._refreshOrders(mode, buyPrice, sellPrice, buyQty, sellQty, canBuy, canSell);
  }

  /**
   * Refresh active orders: cancel stale ones and place new ones
   * respecting MAX_SET and inventory mode constraints.
   */
  async _refreshOrders(mode, buyPrice, sellPrice, buyQty, sellQty, canBuy, canSell) {
    // Cancel all existing orders and re-quote (simplest HFT approach)
    // In production you'd diff prices, but for clarity we cancel-and-replace
    const shouldCancelBuys  = this.activeBuyOrders.size > 0;
    const shouldCancelSells = this.activeSellOrders.size > 0;

    // Cancel stale buys
    if (shouldCancelBuys) {
      for (const [id] of this.activeBuyOrders) {
        await this.exec.cancelOrder(id);
      }
      this.activeBuyOrders.clear();
    }

    // Cancel stale sells
    if (shouldCancelSells) {
      for (const [id] of this.activeSellOrders) {
        await this.exec.cancelOrder(id);
      }
      this.activeSellOrders.clear();
    }

    // ── Place Buy Orders ────────────────────────────────────────
    if (mode !== 'SELL_ONLY' && canBuy && this.activeBuyOrders.size < config.maxSet) {
      try {
        const result = await this.exec.placeOrder('BUY', buyPrice, buyQty);
        this.activeBuyOrders.set(result.orderId, { price: buyPrice, qty: buyQty });
      } catch (err) {
        log.error(`Failed to place BUY: ${err.message}`);
      }
    } else if (mode === 'SELL_ONLY') {
      log.info(`SELL_ONLY mode active — skipping BUY orders (inventory too heavy)`, 'sell_only');
    }

    // ── Place Sell Orders ───────────────────────────────────────
    if (mode !== 'BUY_ONLY' && canSell && this.activeSellOrders.size < config.maxSet) {
      try {
        const result = await this.exec.placeOrder('SELL', sellPrice, sellQty);
        this.activeSellOrders.set(result.orderId, { price: sellPrice, qty: sellQty });
      } catch (err) {
        log.error(`Failed to place SELL: ${err.message}`);
      }
    } else if (mode === 'BUY_ONLY') {
      log.info(`BUY_ONLY mode active — skipping SELL orders (need more inventory)`, 'buy_only');
    }
  }

  // ── P&L Reporting ──────────────────────────────────────────────────

  _reportPnl() {
    const midPrice = (api.orderbook.bestBid + api.orderbook.bestAsk) / 2;
    const unrealizedPnl = midPrice > 0 && this.avgBuyPrice > 0
      ? (midPrice - this.avgBuyPrice) * this.balanceBase
      : 0;

    log.pnl({
      totalTrades:   this.totalTrades,
      realizedPnl:   this.realizedPnl,
      unrealizedPnl: unrealizedPnl,
      uptime:        Date.now() - this.startTime,
    });
  }
}

module.exports = TradingEngine;
