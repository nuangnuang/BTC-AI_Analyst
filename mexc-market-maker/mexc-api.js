'use strict';

const axios = require('axios');
const crypto = require('crypto');
const WebSocket = require('ws');
const config = require('./config');
const log = require('./logger');

// ─── REST API Constants ──────────────────────────────────────────────
const BASE_URL = 'https://api.mexc.com';
const RECV_WINDOW = 5000;

// ─── State ───────────────────────────────────────────────────────────
let _ws = null;
let _wsConnected = false;
let _reconnectTimer = null;

// Orderbook state — updated via WebSocket
const orderbook = {
  bestBid: 0,
  bestAsk: 0,
  bestBidQty: 0,
  bestAskQty: 0,
  lastUpdate: 0,
};

// Callbacks registered by engine
const _listeners = new Set();

// ─── HMAC Signature ──────────────────────────────────────────────────

/** Generate HMAC-SHA256 signature for authenticated MEXC endpoints. */
function _sign(queryString) {
  return crypto
    .createHmac('sha256', config.secretKey)
    .update(queryString)
    .digest('hex');
}

/** Build signed query string with timestamp + signature. */
function _signedParams(params = {}) {
  const timestamp = Date.now();
  const qs = new URLSearchParams({ ...params, timestamp, recvWindow: RECV_WINDOW }).toString();
  const signature = _sign(qs);
  return `${qs}&signature=${signature}`;
}

// ─── REST Helpers ────────────────────────────────────────────────────

/** Authenticated GET request. */
async function _authGet(path, params = {}) {
  const qs = _signedParams(params);
  const url = `${BASE_URL}${path}?${qs}`;
  try {
    const res = await axios.get(url, {
      headers: { 'X-MEXC-APIKEY': config.apiKey },
      timeout: 10000,
    });
    return res.data;
  } catch (err) {
    log.error(`REST GET ${path} failed: ${err.message}`);
    throw err;
  }
}

/** Authenticated POST request. */
async function _authPost(path, params = {}) {
  const qs = _signedParams(params);
  const url = `${BASE_URL}${path}?${qs}`;
  try {
    const res = await axios.post(url, null, {
      headers: { 'X-MEXC-APIKEY': config.apiKey },
      timeout: 10000,
    });
    return res.data;
  } catch (err) {
    log.error(`REST POST ${path} failed: ${err.message}`);
    throw err;
  }
}

/** Authenticated DELETE request. */
async function _authDelete(path, params = {}) {
  const qs = _signedParams(params);
  const url = `${BASE_URL}${path}?${qs}`;
  try {
    const res = await axios.delete(url, {
      headers: { 'X-MEXC-APIKEY': config.apiKey },
      timeout: 10000,
    });
    return res.data;
  } catch (err) {
    log.error(`REST DELETE ${path} failed: ${err.message}`);
    throw err;
  }
}

/** Public GET (no auth). */
async function _publicGet(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = qs ? `${BASE_URL}${path}?${qs}` : `${BASE_URL}${path}`;
  try {
    const res = await axios.get(url, { timeout: 10000 });
    return res.data;
  } catch (err) {
    log.error(`REST public GET ${path} failed: ${err.message}`);
    throw err;
  }
}

// ─── Public REST Endpoints ───────────────────────────────────────────

/** Fetch current ticker price for the configured symbol. */
async function getTickerPrice() {
  const data = await _publicGet('/api/v3/ticker/price', { symbol: config.symbol });
  return parseFloat(data.price);
}

/** Fetch exchange info for symbol (filters, precision, etc.). */
async function getExchangeInfo() {
  const data = await _publicGet('/api/v3/exchangeInfo', { symbol: config.symbol });
  const sym = data.symbols.find(s => s.symbol === config.symbol);
  if (!sym) throw new Error(`Symbol ${config.symbol} not found on MEXC`);
  return sym;
}

/** Fetch current orderbook snapshot (top 5 levels). */
async function getOrderbook() {
  return _publicGet('/api/v3/depth', { symbol: config.symbol, limit: 5 });
}

// ─── Authenticated REST Endpoints ────────────────────────────────────

/** Get account balances. */
async function getAccountInfo() {
  return _authGet('/api/v3/account');
}

/**
 * Place a LIMIT_MAKER order (Post-Only — guarantees 0% maker fee).
 * @param {'BUY'|'SELL'} side
 * @param {string} price   - limit price
 * @param {string} quantity - base asset quantity
 */
async function placeLimitMaker(side, price, quantity) {
  return _authPost('/api/v3/order', {
    symbol: config.symbol,
    side,
    type: 'LIMIT_MAKER',
    price,
    quantity,
  });
}

/** Cancel a single order by orderId. */
async function cancelOrder(orderId) {
  return _authDelete('/api/v3/order', {
    symbol: config.symbol,
    orderId,
  });
}

/** Cancel all open orders for the symbol. */
async function cancelAllOrders() {
  return _authDelete('/api/v3/openOrders', {
    symbol: config.symbol,
  });
}

/** Get all open orders. */
async function getOpenOrders() {
  return _authGet('/api/v3/openOrders', { symbol: config.symbol });
}

// ─── WebSocket (MEXC V3 Depth Stream) ────────────────────────────────

/**
 * Register a listener for orderbook updates.
 * Callback receives the orderbook object on each update.
 */
function onOrderbookUpdate(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/** Parse incoming depth message and update local orderbook state. */
function _handleDepthMsg(data) {
  try {
    const msg = JSON.parse(data);

    // MEXC V3 spot WebSocket depth channel format
    if (msg.c && msg.d) {
      const parsed = msg.d;
      if (parsed.bids && parsed.bids.length > 0) {
        orderbook.bestBid    = parseFloat(parsed.bids[0].p);
        orderbook.bestBidQty = parseFloat(parsed.bids[0].v);
      }
      if (parsed.asks && parsed.asks.length > 0) {
        orderbook.bestAsk    = parseFloat(parsed.asks[0].p);
        orderbook.bestAskQty = parseFloat(parsed.asks[0].v);
      }
      orderbook.lastUpdate = Date.now();
      _listeners.forEach(fn => fn(orderbook));
      return;
    }

    // Alternative format: spot@public.bookTicker
    if (msg.s === config.symbol || msg.e === 'bookTicker') {
      if (msg.b) orderbook.bestBid    = parseFloat(msg.b);
      if (msg.B) orderbook.bestBidQty = parseFloat(msg.B);
      if (msg.a) orderbook.bestAsk    = parseFloat(msg.a);
      if (msg.A) orderbook.bestAskQty = parseFloat(msg.A);
      orderbook.lastUpdate = Date.now();
      _listeners.forEach(fn => fn(orderbook));
      return;
    }

    // Generic depth update (fallback)
    if (msg.bids || msg.asks) {
      if (msg.bids && msg.bids.length > 0) {
        const [p, q] = Array.isArray(msg.bids[0]) ? msg.bids[0] : [msg.bids[0].p, msg.bids[0].v];
        orderbook.bestBid    = parseFloat(p);
        orderbook.bestBidQty = parseFloat(q);
      }
      if (msg.asks && msg.asks.length > 0) {
        const [p, q] = Array.isArray(msg.asks[0]) ? msg.asks[0] : [msg.asks[0].p, msg.asks[0].v];
        orderbook.bestAsk    = parseFloat(p);
        orderbook.bestAskQty = parseFloat(q);
      }
      orderbook.lastUpdate = Date.now();
      _listeners.forEach(fn => fn(orderbook));
    }
  } catch (err) {
    log.error(`WS parse error: ${err.message}`);
  }
}

/** Establish WebSocket connection to MEXC V3 spot depth stream. */
function connectWebSocket() {
  if (_ws && _wsConnected) return;

  const symbolLower = config.symbol.toLowerCase();
  const wsUrl = `wss://wbs.mexc.com/ws`;

  log.info(`WebSocket connecting to ${wsUrl}...`);

  _ws = new WebSocket(wsUrl);

  _ws.on('open', () => {
    _wsConnected = true;
    log.info('WebSocket connected');

    // Subscribe to partial depth stream & bookTicker
    const subscribeMsg = JSON.stringify({
      method: 'SUBSCRIPTION',
      params: [
        `spot@public.bookTicker.v3.api@${config.symbol}`,
      ],
    });
    _ws.send(subscribeMsg);
    log.info(`Subscribed to bookTicker for ${config.symbol}`);
  });

  _ws.on('message', _handleDepthMsg);

  _ws.on('error', (err) => {
    log.error(`WebSocket error: ${err.message}`);
  });

  _ws.on('close', (code, reason) => {
    _wsConnected = false;
    log.warn(`WebSocket closed (code=${code}). Reconnecting in ${config.WS_RECONNECT_DELAY_MS}ms...`);
    _scheduleReconnect();
  });

  _ws.on('ping', () => {
    try { _ws.pong(); } catch (_) { /* ignore */ }
  });
}

function _scheduleReconnect() {
  if (_reconnectTimer) return;
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    connectWebSocket();
  }, config.WS_RECONNECT_DELAY_MS);
}

/** Gracefully close the WebSocket. */
function disconnectWebSocket() {
  if (_reconnectTimer) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }
  if (_ws) {
    _ws.removeAllListeners();
    try { _ws.close(); } catch (_) { /* ignore */ }
    _ws = null;
    _wsConnected = false;
  }
}

/** Check if WebSocket is alive and feeding data. */
function isWsHealthy() {
  return _wsConnected && orderbook.lastUpdate > 0 &&
         (Date.now() - orderbook.lastUpdate) < 30000;
}

module.exports = {
  // Public REST
  getTickerPrice,
  getExchangeInfo,
  getOrderbook,
  // Authenticated REST
  getAccountInfo,
  placeLimitMaker,
  cancelOrder,
  cancelAllOrders,
  getOpenOrders,
  // WebSocket
  connectWebSocket,
  disconnectWebSocket,
  onOrderbookUpdate,
  isWsHealthy,
  // State (read-only reference)
  orderbook,
};
