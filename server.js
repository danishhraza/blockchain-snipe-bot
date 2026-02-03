const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const MIN_TRADE_USD = 500;

const publicDir = path.join(__dirname, 'public');

const state = {
  wallets: {
    base: new Set(),
    solana: new Set(),
  },
  trades: [],
};

const clients = new Set();

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
  for (const client of clients) {
    if (!client.destroyed) {
      sendFrame(client, message);
    }
  }
}

function recordTrade(trade) {
  if (trade.valueUsdt < MIN_TRADE_USD) {
    return;
  }
  state.trades.unshift(trade);
  state.trades = state.trades.slice(0, 200);
  broadcast({ type: 'trade', trade });
}

function updateWallets({ base, solana }) {
  state.wallets.base = new Set(base);
  state.wallets.solana = new Set(solana);
  broadcast({
    type: 'wallets:update',
    wallets: {
      base: [...state.wallets.base],
      solana: [...state.wallets.solana],
    },
  });
}

function parseWallets(input) {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .map((wallet) => wallet.trim())
    .filter((wallet) => wallet.length > 0);
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
      wallets: {
        base: [...state.wallets.base],
        solana: [...state.wallets.solana],
      },
    })
  );

  let buffer = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const decoded = decodeFrames(buffer);
    buffer = decoded.remaining;

    decoded.messages.forEach((payload) => {
      try {
        const message = JSON.parse(payload);
        if (message.type === 'wallets:update') {
          updateWallets({
            base: parseWallets(message.wallets?.base),
            solana: parseWallets(message.wallets?.solana),
          });
        }
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
});
