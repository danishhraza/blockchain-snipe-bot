const statusEl = document.getElementById('connectionStatus');
const feedRows = document.getElementById('feedRows');

let socket;
let trades = [];

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

    const dexUrl = buildDexScreenerUrl(trade);

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
      <span><button class="dex-button" data-url="${dexUrl}">Dex</button></span>
      <span><button class="copy-button" data-address="${trade.token.address}">Copy</button></span>
    `;

    row.addEventListener('click', (event) => {
      if (event.target.closest('.dex-button, .copy-button')) {
        return;
      }
    });

    const dexButton = row.querySelector('.dex-button');
    dexButton.addEventListener('click', (event) => {
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
}

connect();

function buildDexScreenerUrl(trade) {
  const chain = trade.chain || 'unknown';
  const address = trade.token.address || '';
  
  if (chain === 'solana') {
    return `https://dexscreener.com/solana/${address}`;
  } else if (chain === 'base') {
    return `https://dexscreener.com/base/${address}`;
  } else if (chain === 'ethereum') {
    return `https://dexscreener.com/ethereum/${address}`;
  }
  
  return 'https://dexscreener.com';
}

