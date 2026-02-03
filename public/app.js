const statusEl = document.getElementById('connectionStatus');
const baseInput = document.getElementById('baseWallets');
const solanaInput = document.getElementById('solanaWallets');
const updateButton = document.getElementById('updateWallets');
const feedRows = document.getElementById('feedRows');
const walletCountEl = document.getElementById('walletCount');
const latestValueEl = document.getElementById('latestValue');
const latestTimeEl = document.getElementById('latestTime');
const chartTitleEl = document.getElementById('chartTitle');
const chartMetaEl = document.getElementById('chartMeta');
const chartSubtitleEl = document.getElementById('chartSubtitle');
const priceChart = document.getElementById('priceChart');
const chartContext = priceChart ? priceChart.getContext('2d') : null;
const chartEnabled = Boolean(chartContext);

let socket;
let trades = [];
let selectedTokenKey = null;
const priceSeriesMap = new Map();
let chartTimer = null;

function connect() {
  const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${wsProtocol}://${window.location.host}`);

  socket.addEventListener('open', () => {
    statusEl.textContent = 'Live';
    statusEl.classList.add('connected');
  });

  socket.addEventListener('close', () => {
    statusEl.textContent = 'Disconnected - retrying…';
    statusEl.classList.remove('connected');
    setTimeout(connect, 1500);
  });

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'state') {
      trades = message.trades || [];
      hydrateWallets(message.wallets);
      renderTrades();
    }
    if (message.type === 'trade') {
      trades.unshift(message.trade);
      trades = trades.slice(0, 200);
      renderTrades();
      refreshChart();
    }
    if (message.type === 'wallets:update') {
      hydrateWallets(message.wallets);
    }
  });
}

function hydrateWallets(wallets = {}) {
  if (wallets.base) {
    baseInput.value = wallets.base.join('\n');
  }
  if (wallets.solana) {
    solanaInput.value = wallets.solana.join('\n');
  }
  const walletCount = (wallets.base?.length || 0) + (wallets.solana?.length || 0);
  walletCountEl.textContent = walletCount.toString();
}

function sendWalletUpdate() {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  const payload = {
    type: 'wallets:update',
    wallets: {
      base: parseWallets(baseInput.value),
      solana: parseWallets(solanaInput.value),
    },
  };
  socket.send(JSON.stringify(payload));
}

function parseWallets(value) {
  return value
    .split(/[\n,]/)
    .map((wallet) => wallet.trim())
    .filter(Boolean);
}

function shortenWallet(wallet) {
  if (wallet.length <= 10) {
    return wallet;
  }
  return `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
}

function formatNumber(value, decimals = 4) {
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

function renderTrades() {
  feedRows.innerHTML = '';
  trades.forEach((trade) => {
    const row = document.createElement('div');
    row.className = 'feed-row';

    const tokenLabel = `${trade.token.name} (${trade.token.symbol})`;
    const time = new Date(trade.timestamp).toISOString().replace('T', ' ').replace('Z', '');

    const buyUrl = buildPhantomLink(trade);

    row.innerHTML = `
      <span title="${trade.wallet}">${shortenWallet(trade.wallet)}</span>
      <span class="chain ${trade.chain}">${trade.chain}</span>
      <span>${tokenLabel}</span>
      <span class="mono" title="${trade.token.address}">${shortenWallet(trade.token.address)}</span>
      <span>${formatNumber(trade.amount)}</span>
      <span class="value">${formatNumber(trade.valueUsdt, 2)}</span>
      <span>${formatNumber(trade.priceUsdt, 6)}</span>
      <span class="mono">${time}</span>
      <span><button class="buy-button" data-url="${buyUrl}">Buy</button></span>
    `;

    row.addEventListener('click', (event) => {
      if (event.target.closest('.buy-button')) {
        return;
      }
      selectToken(trade);
    });

    const buyButton = row.querySelector('.buy-button');
    buyButton.addEventListener('click', (event) => {
      event.stopPropagation();
      const url = event.currentTarget.dataset.url;
      window.open(url, '_blank', 'noopener,noreferrer');
    });

    feedRows.appendChild(row);
  });

  if (trades.length > 0) {
    const latest = trades[0];
    latestValueEl.textContent = `${formatNumber(latest.valueUsdt, 2)} USDT`;
    latestTimeEl.textContent = new Date(latest.timestamp).toISOString().replace('T', ' ').replace('Z', '');
  }
}

updateButton.addEventListener('click', () => {
  sendWalletUpdate();
});

drawEmptyChart();
connect();

function buildPhantomLink(trade) {
  const address = trade.token.address;
  if (trade.chain === 'solana') {
    return `https://phantom.app/ul/buy?tokenAddress=${encodeURIComponent(address)}`;
  }
  return `https://phantom.app/ul/buy?asset=${encodeURIComponent(address)}`;
}

function selectToken(trade) {
  if (!chartEnabled) {
    return;
  }
  selectedTokenKey = trade.token.address;
  if (chartTitleEl) {
    chartTitleEl.textContent = `${trade.token.name} (${trade.token.symbol})`;
  }
  if (chartMetaEl) {
    chartMetaEl.textContent = `${trade.chain.toUpperCase()} • ${trade.token.address}`;
  }
  if (chartSubtitleEl) {
    chartSubtitleEl.textContent = 'Live price curve with buy checkpoints for tracked wallets.';
  }
  ensureSeries(trade.token.address, trade.priceUsdt);
  refreshChart();
  if (chartTimer) {
    clearInterval(chartTimer);
  }
  chartTimer = setInterval(refreshChart, 3000);
}

function ensureSeries(tokenKey, seedPrice) {
  if (priceSeriesMap.has(tokenKey)) {
    return;
  }
  const seed = hashSeed(tokenKey);
  const series = [];
  let price = seedPrice || 1 + (seed % 5000) / 1000;
  const now = Date.now();

  for (let i = 60; i >= 0; i -= 1) {
    const jitter = ((seed + i * 31) % 100) / 1000;
    price = Math.max(0.0001, price + (jitter - 0.03));
    series.push({
      time: now - i * 60000,
      price,
    });
  }

  priceSeriesMap.set(tokenKey, series);
}

function refreshChart() {
  if (!chartEnabled) {
    return;
  }
  if (!selectedTokenKey) {
    drawEmptyChart();
    return;
  }
  const series = priceSeriesMap.get(selectedTokenKey);
  if (!series) {
    drawEmptyChart();
    return;
  }
  const lastPoint = series[series.length - 1];
  const drift = (Math.random() - 0.45) * 0.05;
  const nextPrice = Math.max(0.0001, lastPoint.price + drift);
  series.push({ time: Date.now(), price: nextPrice });
  if (series.length > 120) {
    series.shift();
  }
  drawChart(series, selectedTokenKey);
}

function drawEmptyChart() {
  if (!chartEnabled) {
    return;
  }
  chartContext.clearRect(0, 0, priceChart.width, priceChart.height);
  chartContext.fillStyle = '#8b949e';
  chartContext.font = '14px system-ui';
  chartContext.fillText('Select a trade row to render the live chart.', 20, 40);
}

function drawChart(series, tokenKey) {
  if (!chartEnabled) {
    return;
  }
  chartContext.clearRect(0, 0, priceChart.width, priceChart.height);
  chartContext.fillStyle = '#0d1117';
  chartContext.fillRect(0, 0, priceChart.width, priceChart.height);

  const padding = 50;
  const width = priceChart.width - padding * 2;
  const height = priceChart.height - padding * 2;
  const prices = series.map((point) => point.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);

  chartContext.strokeStyle = '#1f6feb';
  chartContext.lineWidth = 2;
  chartContext.beginPath();

  series.forEach((point, index) => {
    const x = padding + (index / (series.length - 1)) * width;
    const y = padding + ((max - point.price) / (max - min || 1)) * height;
    if (index === 0) {
      chartContext.moveTo(x, y);
    } else {
      chartContext.lineTo(x, y);
    }
  });

  chartContext.stroke();

  chartContext.strokeStyle = '#21262d';
  chartContext.lineWidth = 1;
  chartContext.beginPath();
  chartContext.rect(padding, padding, width, height);
  chartContext.stroke();

  drawBuyDots(series, tokenKey, padding, width, height, min, max);
}

function drawBuyDots(series, tokenKey, padding, width, height, min, max) {
  const buys = trades.filter((trade) => trade.token.address === tokenKey);
  if (buys.length === 0) {
    return;
  }
  const startTime = series[0].time;
  const endTime = series[series.length - 1].time;

  chartContext.fillStyle = '#3fb950';
  buys.forEach((trade) => {
    const time = new Date(trade.timestamp).getTime();
    if (time < startTime || time > endTime) {
      return;
    }
    const closest = series.reduce((acc, point) => {
      if (!acc || Math.abs(point.time - time) < Math.abs(acc.time - time)) {
        return point;
      }
      return acc;
    }, null);
    if (!closest) {
      return;
    }
    const ratio = (closest.time - startTime) / (endTime - startTime || 1);
    const x = padding + ratio * width;
    const y = padding + ((max - closest.price) / (max - min || 1)) * height;
    chartContext.beginPath();
    chartContext.arc(x, y, 5, 0, Math.PI * 2);
    chartContext.fill();
  });
}

function hashSeed(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}
