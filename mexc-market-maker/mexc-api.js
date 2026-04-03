'use strict';

const crypto = require('crypto');
const axios = require('axios');
const WebSocket = require('ws');
const config = require('./config');
const logger = require('./logger');

// ---------------------------------------------------------------------------
// REST Client
// ---------------------------------------------------------------------------

class MexcRest {
  constructor() {
    this.client = axios.create({
      baseURL: config.restBase,
      timeout: 10000,
      headers: { 'X-MEXC-APIKEY': config.apiKey },
    });
  }

  /** Generate HMAC-SHA256 signature for signed endpoints */
  _sign(params) {
    const qs = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&');
    const signature = crypto.createHmac('sha256', config.secretKey).update(qs).digest('hex');
    return `${qs}&signature=${signature}`;
  }

  /** Fetch exchange info for the symbol (tick size, lot size, etc.) */
  async getExchangeInfo() {
    try {
      const { data } = await this.client.get('/api/v3/exchangeInfo', {
        params: { symbol: config.symbol },
      });
      const sym = data.symbols.find((s) => s.symbol === config.symbol);
      if (!sym) throw new Error(`Symbol ${config.symbol} not found on MEXC`);
      return sym;
    } catch (err) {
      logger.error('getExchangeInfo failed', err);
      throw err;
    }
  }

  /** Fetch current account balances (signed) */
  async getBalances() {
    try {
      const params = { timestamp: Date.now(), recvWindow: 5000 };
      const qs = this._sign(params);
      const { data } = await this.client.get(`/api/v3/account?${qs}`);
      const balances = {};
      for (const b of data.balances) {
        const free = parseFloat(b.free);
        const locked = parseFloat(b.locked);
        if (free > 0 || locked > 0) {
          balances[b.asset] = { free, locked, total: free + locked };
        }
      }
      return balances;
    } catch (err) {
      logger.error('getBalances failed', err);
      throw err;
    }
  }

  /**
   * Place a LIMIT_MAKER order (Post-Only — guarantees maker fee = 0%).
   * Returns order response or throws.
   */
  async placeLimitMaker(side, price, quantity) {
    try {
      const params = {
        symbol: config.symbol,
        side: side.toUpperCase(),
        type: 'LIMIT_MAKER',
        price: String(price),
        quantity: String(quantity),
        timestamp: Date.now(),
        recvWindow: 5000,
      };
      const qs = this._sign(params);
      const { data } = await this.client.post(`/api/v3/order?${qs}`);
      logger.order(side, price, quantity, 'PLACED');
      return data;
    } catch (err) {
      logger.error(`placeLimitMaker ${side} failed`, err);
      throw err;
    }
  }

  /** Cancel an open order */
  async cancelOrder(orderId) {
    try {
      const params = {
        symbol: config.symbol,
        orderId: String(orderId),
        timestamp: Date.now(),
        recvWindow: 5000,
      };
      const qs = this._sign(params);
      const { data } = await this.client.delete(`/api/v3/order?${qs}`);
      return data;
    } catch (err) {
      logger.error(`cancelOrder ${orderId} failed`, err);
      throw err;
    }
  }

  /** Get current best bid/ask from REST (fallback) */
  async getTicker() {
    try {
      const { data } = await this.client.get('/api/v3/ticker/bookTicker', {
        params: { symbol: config.symbol },
      });
      return {
        bestBid: parseFloat(data.bidPrice),
        bestAsk: parseFloat(data.askPrice),
        bidQty: parseFloat(data.bidQty),
        askQty: parseFloat(data.askQty),
      };
    } catch (err) {
      logger.error('getTicker failed', err);
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// WebSocket Client — MEXC V3 Depth Stream
// ---------------------------------------------------------------------------

class MexcWebSocket {
  constructor() {
    this.ws = null;
    this.bestBid = null;
    this.bestAsk = null;
    this.bidQty = null;
    this.askQty = null;
    this._listeners = [];
    this._reconnectTimer = null;
    this._pingTimer = null;
    this._alive = false;
  }

  /** Register a listener called on every depth update: fn({ bestBid, bestAsk }) */
  onUpdate(fn) {
    this._listeners.push(fn);
  }

  /** Connect to MEXC WebSocket and subscribe to depth for the configured symbol */
  connect() {
    if (this.ws) return;

    const url = config.wsEndpoint;
    logger.ws(`Connecting to ${url}`);

    this.ws = new WebSocket(url);
    this._alive = true;

    this.ws.on('open', () => {
      logger.ws('Connected');

      // Subscribe to the partial depth stream (best 5 levels, 100ms update)
      const sub = {
        method: 'SUBSCRIPTION',
        params: [`spot@public.bookTicker.v3.api@${config.symbol}`],
      };
      this.ws.send(JSON.stringify(sub));
      logger.ws(`Subscribed to bookTicker for ${config.symbol}`);

      // Keep-alive ping every 20s
      this._pingTimer = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ method: 'PING' }));
        }
      }, 20000);
    });

    this.ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        this._handleMessage(msg);
      } catch (_) {
        // non-JSON keep-alive frames — ignore
      }
    });

    this.ws.on('close', () => {
      logger.ws('Disconnected');
      this._cleanup();
      if (this._alive) this._scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      logger.error('WebSocket error', err);
      this._cleanup();
      if (this._alive) this._scheduleReconnect();
    });
  }

  /** Gracefully close the WebSocket */
  disconnect() {
    this._alive = false;
    this._cleanup();
    if (this.ws) {
      this.ws.terminate();
      this.ws = null;
    }
  }

  // ---- internal ----

  _handleMessage(msg) {
    // MEXC bookTicker v3 pushes: { "c": "spot@public.bookTicker.v3.api@BTCUSDT", "d": { "A": askQty, "B": bidQty, "a": askPrice, "b": bidPrice }, "s": "BTCUSDT", "t": timestamp }
    if (msg.d && msg.d.b && msg.d.a) {
      this.bestBid = parseFloat(msg.d.b);
      this.bestAsk = parseFloat(msg.d.a);
      this.bidQty = parseFloat(msg.d.B);
      this.askQty = parseFloat(msg.d.A);

      const update = {
        bestBid: this.bestBid,
        bestAsk: this.bestAsk,
        bidQty: this.bidQty,
        askQty: this.askQty,
      };
      for (const fn of this._listeners) {
        try { fn(update); } catch (e) { logger.error('WS listener error', e); }
      }
    }
    // Also handle depth partial stream as fallback
    if (msg.d && msg.d.bids && msg.d.asks) {
      const bids = msg.d.bids;
      const asks = msg.d.asks;
      if (bids.length && asks.length) {
        this.bestBid = parseFloat(bids[0].p);
        this.bestAsk = parseFloat(asks[0].p);
        this.bidQty = parseFloat(bids[0].v);
        this.askQty = parseFloat(asks[0].v);

        const update = {
          bestBid: this.bestBid,
          bestAsk: this.bestAsk,
          bidQty: this.bidQty,
          askQty: this.askQty,
        };
        for (const fn of this._listeners) {
          try { fn(update); } catch (e) { logger.error('WS listener error', e); }
        }
      }
    }
  }

  _cleanup() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this.ws = null;
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    logger.ws(`Reconnecting in ${config.wsReconnectMs}ms...`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, config.wsReconnectMs);
  }
}

module.exports = { MexcRest, MexcWebSocket };
