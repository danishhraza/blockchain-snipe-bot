const statusEl = document.getElementById('connectionStatus');
const feedRows = document.getElementById('feedRows');
const latestValueEl = document.getElementById('latestValue');
const latestTimeEl = document.getElementById('latestTime');
const chartTitleEl = document.getElementById('chartTitle');
const chartMetaEl = document.getElementById('chartMeta');
const chartSubtitleEl = document.getElementById('chartSubtitle');
const priceChart = document.getElementById('priceChart');
const chartEnabled = Boolean(priceChart && window.LightweightCharts);

let socket;
let trades = [];
let selectedTokenKey = null;
let chart = null;
let lineSeries = null;
let priceTimer = null;
let activeToken = null;
const pricePoints = new Map();

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
      renderTrades();
    }
    if (message.type === 'trade') {
      trades.unshift(message.trade);
      trades = trades.slice(0, 200);
      renderTrades();
      updateChartMarkers();
    }
  });
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

async function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'absolute';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

function showCopyState(button) {
  const original = button.textContent;
  button.textContent = 'Copied';
  button.classList.add('copied');
  setTimeout(() => {
    button.textContent = original;
    button.classList.remove('copied');
  }, 1200);
}

function renderTrades() {
  feedRows.innerHTML = '';
  trades.forEach((trade) => {
    const row = document.createElement('div');
    row.className = 'feed-row';

    const tokenLabel = `${trade.token.name} (${trade.token.symbol})`;
    const time = new Date(trade.timestamp).toISOString().replace('T', ' ').replace('Z', '');
    const trader = trade.trader || trade.wallet || '';
    const traderLabel = trade.traderName
      ? `<div class="wallet-nickname">${trade.traderName}</div>`
      : '';
    const traderAddress = `<div class="wallet-address">${shortenWallet(trader)}</div>`;

    const buyUrl = buildPhantomLink(trade);

    row.innerHTML = `
      <span class="wallet-cell" title="${trader}">${traderLabel}${traderAddress}</span>
      <span class="side ${trade.side || ''}">${(trade.side || '').toUpperCase()}</span>
      <span class="chain ${trade.chain}">${trade.chain}</span>
      <span>${tokenLabel}</span>
      <span class="mono" title="${trade.token.address}">${shortenWallet(trade.token.address)}</span>
      <span>${formatNumber(trade.amount)}</span>
      <span class="value">${formatNumber(trade.valueUsdt, 2)}</span>
      <span>${formatNumber(trade.priceUsdt, 6)}</span>
      <span class="mono">${time}</span>
      <span><button class="buy-button" data-url="${buyUrl}">Buy</button></span>
      <span><button class="copy-button" data-address="${trade.token.address}">Copy</button></span>
    `;

    row.addEventListener('click', (event) => {
      if (event.target.closest('.buy-button, .copy-button')) {
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

    const copyButton = row.querySelector('.copy-button');
    copyButton.addEventListener('click', async (event) => {
      event.stopPropagation();
      const address = event.currentTarget.dataset.address;
      await copyToClipboard(address);
      showCopyState(event.currentTarget);
    });

    feedRows.appendChild(row);
  });

  if (trades.length > 0) {
    const latest = trades[0];
    latestValueEl.textContent = `${formatNumber(latest.valueUsdt, 2)} USDT`;
    latestTimeEl.textContent = new Date(latest.timestamp).toISOString().replace('T', ' ').replace('Z', '');
  }
  updateChartMarkers();
}

initChart();
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
  activeToken = {
    address: trade.token.address,
    symbol: trade.token.symbol,
    chain: trade.chain,
  };
  if (chartTitleEl) {
    chartTitleEl.textContent = `${trade.token.name} (${trade.token.symbol})`;
  }
  if (chartMetaEl) {
    chartMetaEl.textContent = `${trade.chain.toUpperCase()} • ${trade.token.address}`;
  }
  if (chartSubtitleEl) {
    chartSubtitleEl.textContent = 'Live price curve with buy checkpoints from webhook activity.';
  }
  resetSeriesForToken(selectedTokenKey);
  fetchAndPlotPrice();
  if (priceTimer) {
    clearInterval(priceTimer);
  }
  priceTimer = setInterval(fetchAndPlotPrice, 10000);
}

function initChart() {
  if (!chartEnabled) {
    return;
  }
  chart = window.LightweightCharts.createChart(priceChart, {
    layout: {
      background: { color: '#0d1117' },
      textColor: '#c9d1d9',
    },
    grid: {
      vertLines: { color: '#21262d' },
      horzLines: { color: '#21262d' },
    },
    rightPriceScale: {
      borderColor: '#21262d',
    },
    timeScale: {
      borderColor: '#21262d',
      timeVisible: true,
      secondsVisible: false,
    },
  });
  lineSeries = chart.addLineSeries({
    color: '#58a6ff',
    lineWidth: 2,
  });
  chart.timeScale().fitContent();
}

function resetSeriesForToken(tokenKey) {
  if (!chartEnabled || !lineSeries) {
    return;
  }
  const series = pricePoints.get(tokenKey) || [];
  lineSeries.setData(series);
  chart.timeScale().fitContent();
}

async function fetchAndPlotPrice() {
  if (!chartEnabled || !activeToken) {
    return;
  }
  const params = new URLSearchParams();
  const chain = activeToken.chain === 'solana' ? 'solana' : 'base';
  if (activeToken.address && activeToken.address.startsWith('0x')) {
    params.set('address', activeToken.address);
    params.set('network', chain);
  } else if (activeToken.symbol) {
    params.set('symbol', activeToken.symbol);
  } else {
    return;
  }

  try {
    const response = await fetch(`/prices?${params.toString()}`);
    if (!response.ok) {
      return;
    }
    const data = await response.json();
    if (!data || !data.price) {
      return;
    }
    const time = Math.floor(Date.now() / 1000);
    const point = { time, value: data.price };
    const series = pricePoints.get(selectedTokenKey) || [];
    series.push(point);
    if (series.length > 240) {
      series.shift();
    }
    pricePoints.set(selectedTokenKey, series);
    lineSeries.update(point);
    updateChartMarkers();
  } catch (error) {
    // ignore transient price errors
  }
}

function updateChartMarkers() {
  if (!chartEnabled || !lineSeries || !selectedTokenKey) {
    return;
  }
  const markers = trades
    .filter((trade) => trade.token.address === selectedTokenKey && trade.side === 'buy')
    .map((trade) => ({
      time: Math.floor(new Date(trade.timestamp).getTime() / 1000),
      position: 'aboveBar',
      color: '#3fb950',
      shape: 'circle',
      text: 'Buy',
    }));
  lineSeries.setMarkers(markers);
}
