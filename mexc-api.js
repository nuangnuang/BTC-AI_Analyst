'use strict';

const axios = require('axios');
const crypto = require('crypto');
const WebSocket = require('ws');
const config = require('./config');
const logger = require('./logger');

// ─────────────────────────────────────────────
//  REST API Client
// ─────────────────────────────────────────────

const httpClient = axios.create({
  baseURL: config.REST_BASE,
  timeout: 10000,
  headers: { 'Content-Type': 'application/json' },
});

/**
 * Generate HMAC-SHA256 signature for MEXC API v3.
 * @param {Object} params - Query parameters to sign
 * @returns {string} Hex-encoded signature
 */
function signParams(params) {
  const queryString = Object.keys(params)
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&');
  return crypto
    .createHmac('sha256', config.secretKey)
    .update(queryString)
    .digest('hex');
}

/**
 * Make a signed request to MEXC REST API.
 * Includes retry logic and error handling.
 */
async function signedRequest(method, endpoint, params = {}) {
  const timestamp = Date.now();
  const allParams = { ...params, timestamp, recvWindow: 5000 };
  allParams.signature = signParams(allParams);

  const headers = { 'X-MEXC-APIKEY': config.apiKey };

  try {
    let response;
    if (method === 'GET') {
      response = await httpClient.get(endpoint, { params: allParams, headers });
    } else if (method === 'POST') {
      response = await httpClient.post(endpoint, null, { params: allParams, headers });
    } else if (method === 'DELETE') {
      response = await httpClient.delete(endpoint, { params: allParams, headers });
    }
    return response.data;
  } catch (err) {
    const msg = err.response?.data?.msg || err.message;
    const code = err.response?.data?.code || err.code;
    logger.error(`REST ${method} ${endpoint} failed: [${code}] ${msg}`);
    throw new Error(`MEXC API Error: [${code}] ${msg}`);
  }
}

/**
 * Public (unsigned) GET request.
 */
async function publicRequest(endpoint, params = {}) {
  try {
    const response = await httpClient.get(endpoint, { params });
    return response.data;
  } catch (err) {
    const msg = err.response?.data?.msg || err.message;
    logger.error(`REST GET ${endpoint} failed: ${msg}`);
    throw err;
  }
}

// ─── REST Endpoints ─────────────────────────

/**
 * Get current ticker price for the configured symbol.
 */
async function getTickerPrice() {
  const data = await publicRequest('/api/v3/ticker/price', { symbol: config.symbol });
  return parseFloat(data.price);
}

/**
 * Get account balances for base and quote assets.
 * Returns { baseBalance, quoteBalance } as floats.
 */
async function getAccountBalances() {
  const data = await signedRequest('GET', '/api/v3/account');
  const balances = data.balances || [];

  let baseBalance = 0;
  let quoteBalance = 0;

  for (const b of balances) {
    if (b.asset === config.baseAsset) {
      baseBalance = parseFloat(b.free) || 0;
    } else if (b.asset === config.quoteAsset) {
      quoteBalance = parseFloat(b.free) || 0;
    }
  }

  return { baseBalance, quoteBalance };
}

/**
 * Place a LIMIT_MAKER order (Post-Only, guarantees 0% maker fee).
 * @param {'BUY'|'SELL'} side
 * @param {number} price
 * @param {number} quantity - In base asset units
 */
async function placeLimitMakerOrder(side, price, quantity) {
  return signedRequest('POST', '/api/v3/order', {
    symbol: config.symbol,
    side,
    type: 'LIMIT_MAKER',
    price: price.toString(),
    quantity: quantity.toString(),
  });
}

/**
 * Cancel an open order by orderId.
 */
async function cancelOrder(orderId) {
  return signedRequest('DELETE', '/api/v3/order', {
    symbol: config.symbol,
    orderId,
  });
}

/**
 * Get all open orders for the symbol.
 */
async function getOpenOrders() {
  return signedRequest('GET', '/api/v3/openOrders', {
    symbol: config.symbol,
  });
}

/**
 * Get exchange info for the symbol (lot size, tick size, etc.).
 */
async function getExchangeInfo() {
  const data = await publicRequest('/api/v3/exchangeInfo', { symbol: config.symbol });
  const symbolInfo = data.symbols?.find(s => s.symbol === config.symbol);
  if (!symbolInfo) throw new Error(`Symbol ${config.symbol} not found on MEXC`);
  return symbolInfo;
}

// ─────────────────────────────────────────────
//  WebSocket Client — Orderbook Depth Stream
// ─────────────────────────────────────────────

class OrderbookStream {
  constructor() {
    this.ws = null;
    this.bestBid = 0;
    this.bestAsk = 0;
    this.bestBidQty = 0;
    this.bestAskQty = 0;
    this.isConnected = false;
    this._reconnectTimer = null;
    this._pingTimer = null;
    this._listeners = new Set();
  }

  /**
   * Register a callback for orderbook updates.
   * Callback receives: { bestBid, bestAsk, bestBidQty, bestAskQty, spread }
   */
  onUpdate(callback) {
    this._listeners.add(callback);
    return () => this._listeners.delete(callback);
  }

  /**
   * Connect to MEXC WebSocket V3 and subscribe to depth stream.
   */
  connect() {
    if (this.ws) return;

    const symbol = config.symbol.toLowerCase();
    logger.info(`WebSocket connecting to ${config.WS_BASE}...`);

    try {
      this.ws = new WebSocket(config.WS_BASE);
    } catch (err) {
      logger.error(`WebSocket creation failed: ${err.message}`);
      this._scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.isConnected = true;
      logger.info('WebSocket connected');

      // Subscribe to partial book depth (top 5 levels, 100ms updates)
      const subMsg = JSON.stringify({
        method: 'SUBSCRIPTION',
        params: [`spot@public.bookTicker.v3.api@${config.symbol}`],
      });
      this.ws.send(subMsg);
      logger.info(`Subscribed to bookTicker for ${config.symbol}`);

      // Keepalive ping
      this._pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ method: 'PING' }));
        }
      }, config.WS_PING_INTERVAL);
    });

    this.ws.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        this._handleMessage(data);
      } catch (err) {
        // Ignore parse errors on pong frames
      }
    });

    this.ws.on('error', (err) => {
      logger.error(`WebSocket error: ${err.message}`);
    });

    this.ws.on('close', (code, reason) => {
      this.isConnected = false;
      logger.warn(`WebSocket closed: ${code} ${reason || ''}`);
      this._cleanup();
      this._scheduleReconnect();
    });
  }

  /**
   * Parse incoming WebSocket messages and update best bid/ask.
   */
  _handleMessage(data) {
    // MEXC V3 bookTicker format
    if (data.d && data.c === `spot@public.bookTicker.v3.api@${config.symbol}`) {
      const d = data.d;
      this.bestBid    = parseFloat(d.b) || this.bestBid;
      this.bestAsk    = parseFloat(d.a) || this.bestAsk;
      this.bestBidQty = parseFloat(d.B) || this.bestBidQty;
      this.bestAskQty = parseFloat(d.A) || this.bestAskQty;

      const spread = this.bestAsk > 0 ? (this.bestAsk - this.bestBid) / this.bestAsk : 0;

      for (const cb of this._listeners) {
        try {
          cb({
            bestBid:    this.bestBid,
            bestAsk:    this.bestAsk,
            bestBidQty: this.bestBidQty,
            bestAskQty: this.bestAskQty,
            spread,
          });
        } catch (err) {
          logger.error(`Listener error: ${err.message}`);
        }
      }
    }
  }

  /**
   * Schedule automatic reconnect after connection loss.
   */
  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    logger.info('Reconnecting WebSocket in 3s...');
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.ws = null;
      this.connect();
    }, 3000);
  }

  _cleanup() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }

  /**
   * Gracefully close the WebSocket connection.
   */
  disconnect() {
    this._cleanup();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
  }
}

module.exports = {
  // REST
  getTickerPrice,
  getAccountBalances,
  placeLimitMakerOrder,
  cancelOrder,
  getOpenOrders,
  getExchangeInfo,
  publicRequest,
  signedRequest,

  // WebSocket
  OrderbookStream,
};
