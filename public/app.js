const statusEl = document.getElementById('connectionStatus');
const baseInput = document.getElementById('baseWallets');
const solanaInput = document.getElementById('solanaWallets');
const updateButton = document.getElementById('updateWallets');
const feedRows = document.getElementById('feedRows');
const walletCountEl = document.getElementById('walletCount');
const latestValueEl = document.getElementById('latestValue');
const latestTimeEl = document.getElementById('latestTime');

let socket;
let trades = [];

function connect() {
  socket = new WebSocket(`ws://${window.location.host}`);

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

    row.innerHTML = `
      <span title="${trade.wallet}">${shortenWallet(trade.wallet)}</span>
      <span class="chain ${trade.chain}">${trade.chain}</span>
      <span>${tokenLabel}</span>
      <span class="mono" title="${trade.token.address}">${shortenWallet(trade.token.address)}</span>
      <span>${formatNumber(trade.amount)}</span>
      <span class="value">${formatNumber(trade.valueUsdt, 2)}</span>
      <span>${formatNumber(trade.priceUsdt, 6)}</span>
      <span class="mono">${time}</span>
    `;

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

connect();
