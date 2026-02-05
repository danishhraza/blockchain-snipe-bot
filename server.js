const crypto = require('crypto');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) {
    return;
  }
  const content = fs.readFileSync(envPath, 'utf8');
  content.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return;
    }
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) {
      return;
    }
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  });
}

loadEnv();

const PORT = process.env.PORT || 3000;
const MIN_TRADE_USD = Number(process.env.MIN_TRADE_USD || 1); // Minimum trade value in USD to display
const DEXSCREENER_BASE_URL = 'https://api.dexscreener.com';
const ALCHEMY_WEBHOOK_SIGNING_KEY =
  process.env.ALCHEMY_WEBHOOK_SIGNING_KEY ||
  process.env.ALCHEMY_SIGNING_KEY ||
  process.env.ALCHEMY_AUTH_TOKEN ||
  '';
const WEBHOOK_PATH = '/webhooks/alchemy';

const publicDir = path.join(__dirname, 'public');

const state = {
  trades: [],
};

const clients = new Set();
const tracking = {
  base: {
    seenTxs: new Map(),
  },
};

const STABLE_SYMBOLS = new Set(['USDC', 'USDT', 'DAI', 'USDBC']);
const BASE_STABLE_ADDRESSES = new Set([
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca',
]);
const SOLANA_STABLE_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
]);
const SOLANA_SOL_MINT = 'So11111111111111111111111111111111111111112';
const PRICE_CACHE = new Map();
const PRICE_CACHE_TTL_MS = Number(process.env.PRICE_CACHE_TTL_MS || 60000);
const DEX_CHAIN_IDS = {
  base: 'base',
  solana: 'solana',
  ethereum: 'ethereum',
};

const PRICE_PLATFORMS = {
  base: 'base',
  solana: 'solana',
  ethereum: 'ethereum',
};

const DEX_SYMBOL_ADDRESS = {
  base: {
    ETH: '0x4200000000000000000000000000000000000006',
    USDC: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    USDT: '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca',
  },
  solana: {
    SOL: 'So11111111111111111111111111111111111111112',
    USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  },
  ethereum: {
    ETH: '0xC02aaA39b223FE8D0A0E5C4F27eAD9083C756Cc2',
    USDC: '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  },
};

function parseTrackedWallets(raw) {
  const set = new Set();
  const nameByAddress = new Map();
  if (!raw) {
    return { set, nameByAddress };
  }
  raw
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .forEach((entry) => {
      const separator = entry.includes('=') ? '=' : entry.includes(':') ? ':' : null;
      const parts = separator ? entry.split(separator) : [entry];
      const address = parts[parts.length - 1].trim();
      const name = parts.length > 1 ? parts[0].trim() : '';
      if (address) {
        const lower = address.toLowerCase();
        set.add(lower);
        if (name) {
          nameByAddress.set(lower, name);
        }
      }
    });
  return { set, nameByAddress };
}

// Tracked wallets configuration (name -> address).
// Solana and Base/Ethereum wallets separated for chain-specific processing.
const TRACKED_WALLETS_CONFIG = {
  // Solana wallets
  logjam: '5fkAwNVpT8A1UHEnY62VEFpqgagdoP8FYrv5ideiQp5c',
  zinceth: 'HQdFfmiDrZGbxqE5k5CqDxUkLUHhCUS39YHqsRGsfzeH',
  xsneaky: 'FfztZq1outrYfyYbKw5P4LGo4xUc4XYEdf7o91UdS7qu',
  collectible: 'F2hA2zDVnHyDUiMQ6b3K9Gx9A2JAxJn66ASH9xZ9LqbG',
  danish: 'BTcozeUcGohAjoPRm4rXuwEkKQeQsBVQxbUeAErxKGZP',
  // Base/Ethereum wallets
  frank: '0x696d1265C8Fc4F14797aBEBFAe3C43EBFA9D8e28',
  Zinc: '0xca8323cb2b2cfd96963ecb34a7abc5ae172b37bb',
  danishbase: '0x0CCCd055C953AAC076c37a4a969b90cB58F3E12E',
};

const SOLANA_WALLET_NAMES = ['logjam', 'zinceth', 'xsneaky', 'collectible', 'danish'];

const TRACKED_WALLETS = new Set();
const TRACKED_WALLETS_SOLANA = new Set();
const TRACKED_WALLETS_BASE = new Set();
const TRACKED_WALLET_NAMES = new Map();

Object.entries(TRACKED_WALLETS_CONFIG).forEach(([name, address]) => {
  if (!address) return;
  const lower = String(address).toLowerCase().trim();
  TRACKED_WALLETS.add(lower);
  TRACKED_WALLET_NAMES.set(lower, name);
  if (SOLANA_WALLET_NAMES.includes(name)) {
    TRACKED_WALLETS_SOLANA.add(lower);
  } else {
    TRACKED_WALLETS_BASE.add(lower);
  }
});

function sendFrame(socket, payload) {
  const data = Buffer.from(payload);
  const length = data.length;
  let headerLength = 2;
  let payloadLength = length;

  if (length >= 126 && length < 65536) {
    headerLength = 4;
  } else if (length >= 65536) {
    headerLength = 10;
  }

  const frame = Buffer.alloc(headerLength + length);
  frame[0] = 0x81;

  if (length < 126) {
    frame[1] = length;
  } else if (length < 65536) {
    frame[1] = 126;
    frame.writeUInt16BE(length, 2);
  } else {
    frame[1] = 127;
    frame.writeBigUInt64BE(BigInt(length), 2);
  }

  data.copy(frame, headerLength);
  socket.write(frame);
}

function broadcast(payload) {
  const message = JSON.stringify(payload);
  try {
    console.log(`Broadcasting ${payload.type || 'message'} to ${clients.size} clients`);
  } catch (e) {}
  for (const client of clients) {
    if (!client.destroyed) {
      sendFrame(client, message);
    }
  }
}

function recordTrade(trade, options = {}) {
  try {
    console.log('recordTrade:', trade?.txHash, 'valueUsdt=', trade?.valueUsdt, 'options=', options);
  } catch (e) {}
  if (!options.skipFilter && trade.valueUsdt < MIN_TRADE_USD) {
    return;
  }
  state.trades.unshift(trade);
  state.trades = state.trades.slice(0, 200);
  broadcast({ type: 'trade', trade });
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => {
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function verifyAlchemySignature(body, signature) {
  if (!ALCHEMY_WEBHOOK_SIGNING_KEY) {
    return true;
  }
  if (!signature) {
    return false;
  }
  const hmac = crypto.createHmac('sha256', ALCHEMY_WEBHOOK_SIGNING_KEY);
  hmac.update(body, 'utf8');
  const digest = hmac.digest('hex');
  return digest === signature;
}

function rememberSeen(cache, key) {
  cache.set(key, Date.now());
}

function pruneSeen(cache, maxAgeMs = 60 * 60 * 1000) {
  const cutoff = Date.now() - maxAgeMs;
  for (const [key, timestamp] of cache.entries()) {
    if (timestamp < cutoff) {
      cache.delete(key);
    }
  }
}

function fetchJson(url, options) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
    if (options.body) {
      request.write(options.body);
    }
    request.end();
  });
}

function getCachedPrice(key) {
  const cached = PRICE_CACHE.get(key);
  if (!cached) {
    return null;
  }
  if (cached.expiresAt < Date.now()) {
    PRICE_CACHE.delete(key);
    return null;
  }
  return cached.value;
}

function setCachedPrice(key, value) {
  if (value == null || Number.isNaN(value)) {
    return;
  }
  PRICE_CACHE.set(key, { value, expiresAt: Date.now() + PRICE_CACHE_TTL_MS });
}

function resolveDexAddress(chain, symbol) {
  const map = DEX_SYMBOL_ADDRESS[chain] || {};
  return map[symbol.toUpperCase()] || null;
}

async function fetchDexPrice(chainId, address) {
  if (!chainId || !address) {
    return null;
  }
  const url = `${DEXSCREENER_BASE_URL}/tokens/v1/${chainId}/${address}`;
  const response = await fetchJson(url, { method: 'GET' });
  if (!Array.isArray(response)) {
    return null;
  }
  let best = null;
  response.forEach((pair) => {
    const liq = Number(pair?.liquidity?.usd || 0);
    if (!best || liq > best.liq) {
      best = { liq, price: Number(pair?.priceUsd || 0) };
    }
  });
  if (!best || !best.price) {
    return null;
  }
  return best.price;
}

async function getUsdPriceForAddress(chainId, address) {
  const key = `${chainId}:${address}`.toLowerCase();
  const cached = getCachedPrice(key);
  if (cached) {
    return cached;
  }
  const value = await fetchDexPrice(chainId, address);
  if (value) {
    setCachedPrice(key, value);
  }
  return value;
}

async function getUsdPriceForSymbol(chain, symbol) {
  const key = `symbol:${chain}:${symbol}`.toUpperCase();
  const cached = getCachedPrice(key);
  if (cached) {
    return cached;
  }
  const address = resolveDexAddress(chain, symbol);
  const chainId = DEX_CHAIN_IDS[chain] || DEX_CHAIN_IDS.base;
  const value = address ? await fetchDexPrice(chainId, address) : null;
  if (value) {
    setCachedPrice(key, value);
  }
  return value;
}

function extractTokenKey(transfer) {
  if (transfer.rawContract && transfer.rawContract.address) {
    return transfer.rawContract.address.toLowerCase();
  }
  return transfer.asset || 'ETH';
}

function isStableTransfer(transfer) {
  const tokenKey = extractTokenKey(transfer);
  if (BASE_STABLE_ADDRESSES.has(tokenKey)) {
    return true;
  }
  return STABLE_SYMBOLS.has((transfer.asset || '').toUpperCase());
}

function normalizeActivityToTransfer(activity) {
  if (!activity) {
    return null;
  }
  const asset = activity.asset || activity.tokenSymbol || '';
  const rawAddress =
    activity.rawContract?.address ||
    activity.contractAddress ||
    activity.tokenAddress ||
    '';
  const value = Number(activity.value || activity.amount || 0);
  return {
    hash: activity.hash || activity.transactionHash || activity.txHash || '',
    from: activity.fromAddress || activity.from || '',
    to: activity.toAddress || activity.to || '',
    value,
    asset,
    rawContract: rawAddress ? { address: rawAddress } : undefined,
    metadata: {
      blockTimestamp:
        activity.blockTimestamp ||
        activity.blockTime ||
        activity.timestamp ||
        null,
    },
  };
}

function resolveChainLabel(payload) {
  const network = payload?.event?.network || payload?.network || '';
  const normalized = String(network).toLowerCase();
  if (normalized.includes('base')) {
    return 'base';
  }
  if (normalized.includes('sol')) {
    return 'solana';
  }
  if (normalized.includes('eth')) {
    return 'ethereum';
  }
  return normalized || 'unknown';
}

function resolveWalletFromActivity(activity, payload) {
  return (
    activity.wallet ||
    activity.address ||
    activity.fromAddress ||
    activity.from ||
    activity.toAddress ||
    activity.to ||
    payload?.event?.address ||
    ''
  );
}

async function activityToTrade(activity, payload) {
  const transfer = normalizeActivityToTransfer(activity);
  if (!transfer || !transfer.hash) {
    return null;
  }

  const chain = resolveChainLabel(payload);
  const from = (transfer.from || '').toLowerCase();
  const to = (transfer.to || '').toLowerCase();
  const isTrackedFrom = TRACKED_WALLETS.has(from);
  const isTrackedTo = TRACKED_WALLETS.has(to);
  if (!isTrackedFrom && !isTrackedTo) {
    return null;
  }
  const side = isTrackedFrom ? 'sell' : 'buy';
  const wallet = isTrackedFrom ? transfer.from : transfer.to;
  const trackedKey = isTrackedFrom ? from : to;
  const traderName = TRACKED_WALLET_NAMES.get(trackedKey) || '';
  const tokenAddress = transfer.rawContract?.address || '';
  const tokenSymbol = transfer.asset || 'TOKEN';

  let valueUsdt = 0;
  if (isStableTransfer(transfer)) {
    valueUsdt = Math.abs(transfer.value || 0);
  } else if (tokenSymbol.toUpperCase() === 'ETH') {
    const ethPrice = await getUsdPriceForSymbol('ETH');
    if (ethPrice) {
      valueUsdt = Math.abs(transfer.value || 0) * ethPrice;
    }
  } else if (tokenSymbol.toUpperCase() === 'SOL') {
    const solPrice = await getUsdPriceForSymbol('SOL');
    if (solPrice) {
      valueUsdt = Math.abs(transfer.value || 0) * solPrice;
    }
  } else if (tokenAddress) {
    const platform = PRICE_PLATFORMS[chain] || PRICE_PLATFORMS.base;
    const tokenPrice = await getUsdPriceForAddress(platform, tokenAddress);
    if (tokenPrice) {
      valueUsdt = Math.abs(transfer.value || 0) * tokenPrice;
    }
  }

  const amount = Math.abs(transfer.value || 0);
  const priceUsdt = amount && valueUsdt ? valueUsdt / amount : 0;

  const rawTimestamp = transfer.metadata?.blockTimestamp;
  const parsedTimestamp = rawTimestamp ? new Date(rawTimestamp) : null;
  const timestamp = parsedTimestamp && !Number.isNaN(parsedTimestamp.getTime())
    ? parsedTimestamp.toISOString()
    : new Date().toISOString();

  return {
    chain,
    wallet,
    side,
    trader: wallet,
    traderName,
    from: transfer.from || '',
    to: transfer.to || '',
    token: {
      name: tokenSymbol,
      symbol: tokenSymbol,
      address: tokenAddress || tokenSymbol,
    },
    amount,
    valueUsdt,
    priceUsdt,
    timestamp,
    txHash: transfer.hash,
  };
}

function normalizeSolanaAccountKey(key) {
  if (!key) {
    return '';
  }
  if (typeof key === 'string') {
    return key;
  }
  if (key.pubkey) {
    return key.pubkey;
  }
  if (key.pubkey && key.pubkey.toBase58) {
    return key.pubkey.toBase58();
  }
  return '';
}

async function parseSolanaSwap(wallet, tx) {
  if (!tx || !tx.meta || !tx.transaction) {
    return null;
  }

  const pre = new Map();
  const post = new Map();
  const owner = wallet;

  let meta = tx.meta || {};
  if (Array.isArray(meta) && meta.length > 0) meta = meta[0];
  const preTokenBalances = meta.preTokenBalances || meta.pre_token_balances || [];
  const postTokenBalances = meta.postTokenBalances || meta.post_token_balances || [];

  preTokenBalances.forEach((balance) => {
    const balOwner = (balance.owner || '').toString().toLowerCase();
    if (balOwner === owner) {
      pre.set(balance.mint, Number(balance.uiTokenAmount?.uiAmount || balance.ui_token_amount?.ui_amount || 0));
    }
  });
  postTokenBalances.forEach((balance) => {
    const balOwner = (balance.owner || '').toString().toLowerCase();
    if (balOwner === owner) {
      post.set(balance.mint, Number(balance.uiTokenAmount?.uiAmount || balance.ui_token_amount?.ui_amount || 0));
    }
  });

  const net = new Map();
  const mints = new Set([...pre.keys(), ...post.keys()]);
  mints.forEach((mint) => {
    const delta = (post.get(mint) || 0) - (pre.get(mint) || 0);
    if (Math.abs(delta) > 0) {
      net.set(mint, delta);
    }
  });

  if (net.size < 1) {
    return null;
  }

  let stableDelta = 0;
  for (const [mint, delta] of net.entries()) {
    if (SOLANA_STABLE_MINTS.has(mint)) {
      stableDelta += delta;
    }
  }

  const netEntries = [...net.entries()];
  netEntries.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  
  // Find the main token: either acquired (buy) or sold (sell), excluding stables
  let mainToken = netEntries.find(([mint, amount]) => !SOLANA_STABLE_MINTS.has(mint));
  
  if (!mainToken) {
    return null;
  }

  const [mint, amount] = mainToken;
  const token = {
    name: mint === SOLANA_SOL_MINT ? 'Solana' : 'Token',
    symbol: mint === SOLANA_SOL_MINT ? 'SOL' : 'TOKEN',
    address: mint,
  };
  if (SOLANA_STABLE_MINTS.has(mint)) {
    token.name = mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' ? 'USD Coin' : 'Tether USD';
    token.symbol = mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' ? 'USDC' : 'USDT';
  }

  let valueUsdt = Math.abs(stableDelta || 0);
  if (!valueUsdt && net.has(SOLANA_SOL_MINT)) {
    const solDelta = net.get(SOLANA_SOL_MINT);
    const solPrice = await getUsdPriceForSymbol('SOL');
    if (solPrice) {
      valueUsdt = Math.abs(solDelta) * solPrice;
    }
  }
  if (!valueUsdt) {
    const tokenPrice = await getUsdPriceForAddress(PRICE_PLATFORMS.solana, mint);
    if (tokenPrice) {
      valueUsdt = Math.abs(amount) * tokenPrice;
    }
  }
  if (valueUsdt < MIN_TRADE_USD) {
    return null;
  }

  // determine txHash from different shapes
  let txHash = '';
  if (typeof tx.signature === 'string') txHash = tx.signature;
  else if (tx.signature && typeof tx.signature === 'string') txHash = tx.signature;
  else if (txObj && Array.isArray(txObj.signatures) && txObj.signatures.length > 0) txHash = txObj.signatures[0];
  else if (tx.transaction && Array.isArray(tx.transaction) && tx.transaction[0] && Array.isArray(tx.transaction[0].signatures)) txHash = tx.transaction[0].signatures[0];

  // Get wallet name
  const traderName = TRACKED_WALLET_NAMES.get(owner) || '';

  return {
    chain: 'solana',
    wallet: owner,
    traderName,
    token,
    amount: Math.abs(amount),
    valueUsdt,
    priceUsdt: valueUsdt && amount ? valueUsdt / Math.abs(amount) : 0,
    side: amount > 0 ? 'buy' : 'sell',
    timestamp: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : new Date().toISOString(),
    txHash: txHash || '',
  };
}

function decodeFrames(buffer) {
  let offset = 0;
  const messages = [];

  while (offset + 2 <= buffer.length) {
    const byte1 = buffer[offset];
    const fin = (byte1 & 0x80) === 0x80;
    const opcode = byte1 & 0x0f;
    const byte2 = buffer[offset + 1];
    const masked = (byte2 & 0x80) === 0x80;
    let payloadLength = byte2 & 0x7f;
    let headerLength = 2;

    if (payloadLength === 126) {
      if (offset + 4 > buffer.length) {
        break;
      }
      payloadLength = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (payloadLength === 127) {
      if (offset + 10 > buffer.length) {
        break;
      }
      payloadLength = Number(buffer.readBigUInt64BE(offset + 2));
      headerLength = 10;
    }

    const maskOffset = offset + headerLength;
    const payloadOffset = maskOffset + (masked ? 4 : 0);
    const frameEnd = payloadOffset + payloadLength;

    if (frameEnd > buffer.length) {
      break;
    }

    if (!fin || opcode !== 0x1) {
      offset = frameEnd;
      continue;
    }

    let payload = buffer.subarray(payloadOffset, frameEnd);

    if (masked) {
      const mask = buffer.subarray(maskOffset, maskOffset + 4);
      const unmasked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i += 1) {
        unmasked[i] = payload[i] ^ mask[i % 4];
      }
      payload = unmasked;
    }

    messages.push(payload.toString('utf8'));
    offset = frameEnd;
  }

  return {
    messages,
    remaining: buffer.subarray(offset),
  };
}

function handleSocket(socket) {
  clients.add(socket);
  socket.setTimeout(0);
  socket.setNoDelay(true);
  socket.setKeepAlive(true);

  sendFrame(
    socket,
    JSON.stringify({
      type: 'state',
      trades: state.trades,
    })
  );

  let buffer = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const decoded = decodeFrames(buffer);
    buffer = decoded.remaining;

    decoded.messages.forEach((payload) => {
      try {
        JSON.parse(payload);
      } catch (error) {
        sendFrame(socket, JSON.stringify({ type: 'error', message: 'Invalid message format.' }));
      }
    });
  });

  socket.on('close', () => {
    clients.delete(socket);
  });

  socket.on('error', () => {
    clients.delete(socket);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url && req.url.startsWith('/prices')) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const symbol = url.searchParams.get('symbol');
    const address = url.searchParams.get('address');
    const network = url.searchParams.get('network') || 'base';
    const resolvedPlatform =
      network === 'solana' ? PRICE_PLATFORMS.solana : PRICE_PLATFORMS.base;

    (async () => {
      try {
        let price = null;
        if (symbol) {
          price = await getUsdPriceForSymbol(symbol);
        } else if (address) {
          price = await getUsdPriceForAddress(resolvedPlatform, address);
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'symbol or address is required' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ price }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'price lookup failed' }));
      }
    })();
    return;
  }

  if (req.method === 'POST' && req.url === WEBHOOK_PATH) {
    readRequestBody(req)
      .then(async (body) => {
        try {
          console.log('Incoming webhook headers:', req.headers);
          console.log('Incoming webhook body:', body);
        } catch (e) {}

        const signature = req.headers['x-alchemy-signature'];
        if (!verifyAlchemySignature(body, signature)) {
          console.warn('Invalid webhook signature:', signature);
          res.writeHead(401);
          res.end('Invalid signature');
          return;
        }
        let payload = null;
        try {
          payload = JSON.parse(body);
        } catch (error) {
          console.warn('Invalid JSON payload');
          res.writeHead(400);
          res.end('Invalid JSON');
          return;
        }

        // Handle both Base/Ethereum (activity) and Solana (transaction) formats
        let activityList = payload.activity || payload.event?.activity || [];
        let isSolanaWebhook = false;
        
        if (activityList.length === 0 && payload.event?.transaction) {
          isSolanaWebhook = true;
          activityList = payload.event.transaction || [];
        }

        try {
          console.log('Webhook parsed. network:', payload.network, 'activity/transaction count:', activityList.length);
        } catch (e) {}

        for (const activity of activityList) {
          let trade = null;
          try {
            if (isSolanaWebhook) {
              // For Solana: activity is a transaction object, need to parse swaps for tracked wallets
              console.log('Processing Solana transaction:', activity?.signature);
              const trackedSwaps = [];
              for (const wallet of TRACKED_WALLETS_SOLANA) {
                const swap = await parseSolanaSwap(wallet, activity);
                if (swap) {
                  trackedSwaps.push(swap);
                }
              }
              if (trackedSwaps.length > 0) {
                trade = trackedSwaps[0]; // Use first swap if multiple
              }
            } else {
              // For Base/Ethereum: activity is an activity object
              trade = await activityToTrade(activity, payload);
            }
            console.log('Activity converted to trade:', trade ? trade.txHash : 'null');
          } catch (e) {
            console.error('Error converting activity to trade:', e?.message || e);
            continue;
          }
          if (!trade) {
            console.log('Trade conversion returned null; skipping');
            continue;
          }
          if (tracking.base.seenTxs.has(trade.txHash)) {
            console.log('Skipping already seen tx:', trade.txHash);
            continue;
          }
          rememberSeen(tracking.base.seenTxs, trade.txHash);
          recordTrade(trade, { skipFilter: true });
        }

        res.writeHead(200);
        res.end('ok');
      })
      .catch((error) => {
        console.error('Webhook error:', error?.message || error);
        res.writeHead(500);
        res.end('error');
      });
    return;
  }

  const safePath = req.url === '/' ? '/index.html' : req.url;
  const filePath = path.join(publicDir, decodeURIComponent(safePath));

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const ext = path.extname(filePath);
    const contentType = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
    }[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  const acceptKey = crypto
    .createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, 'binary')
    .digest('base64');

  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`,
  ];

  socket.write(`${headers.join('\r\n')}\r\n\r\n`);
  handleSocket(socket);
});

server.listen(PORT, () => {
  console.log(`Wallet tracker running on http://localhost:${PORT}`);
  console.log(`Alchemy webhook endpoint: http://localhost:${PORT}${WEBHOOK_PATH}`);
  if (!ALCHEMY_WEBHOOK_SIGNING_KEY) {
    console.warn('Alchemy webhook signature verification disabled: missing signing key.');
  }
  if (TRACKED_WALLETS.size === 0) {
    console.warn('No TRACKED_WALLETS configured. Webhook activity will be ignored.');
  }
});
