import WebSocket from 'ws';
import fs from 'node:fs';

const WS_URL = process.env.OFFICE_WS_URL || 'ws://127.0.0.1:4800/ws?token=a1b2c3d4e5f6-office-token';
const API_URL = process.env.OFFICE_API_URL || 'http://127.0.0.1:4800';
const TOKEN = process.env.OFFICE_TOKEN || 'a1b2c3d4e5f6-office-token';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '778931443';

// Read Telegram Bot Token from ~/.hermes/.env
function getBotToken() {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN;
  try {
    const content = fs.readFileSync('/root/.hermes/.env', 'utf8');
    const match = content.match(/TELEGRAM_BOT_TOKEN=([^\s]+)/);
    if (match) return match[1].trim();
  } catch (e) {
    console.error('Could not read /root/.hermes/.env:', e.message);
  }
  return null;
}

const botToken = getBotToken();
if (!botToken) {
  console.error('Missing TELEGRAM_BOT_TOKEN');
  process.exit(1);
}

// Telegram send helper with chunking and retry
async function sendTelegram(text) {
  if (!text || !text.trim()) return;
  // Truncate if too long (Telegram limit is 4096)
  const chunks = [];
  const maxLen = 3800;
  for (let i = 0; i < text.length; i += maxLen) {
    chunks.push(text.slice(i, i + maxLen));
  }

  for (const chunk of chunks) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: chunk,
          disable_web_page_preview: true
        })
      });
      if (!res.ok) {
        console.error('Telegram API error:', await res.text());
      }
    } catch (e) {
      console.error('Send error:', e.message);
    }
  }
}

// Cache agent names
let agentCache = new Map();
async function refreshAgents() {
  try {
    const res = await fetch(`${API_URL}/api/state`, {
      headers: { 'x-office-token': TOKEN }
    });
    if (res.ok) {
      const d = await res.json();
      agentCache = new Map(d.agents.map(a => [a.id, a.name]));
    }
  } catch (e) {
    console.error('refreshAgents error:', e.message);
  }
}

await refreshAgents();

function connect() {
  console.log(`Connecting to AI Office WebSocket: ${WS_URL}`);
  const ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log('Connected to AI Office WebSocket!');
  });

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'event' && msg.payload) {
        const ev = msg.payload;
        const agentName = agentCache.get(ev.agentId) || ev.agentId;

        if (ev.kind === 'result') {
          await sendTelegram(`🏢 [Văn phòng 3D] 🎉 *${agentName}* hoàn thành nhiệm vụ:\n${ev.text}`);
        } else if (ev.kind === 'message') {
          await sendTelegram(`🏢 [Văn phòng 3D] 💬 *${agentName}*:\n${ev.text}`);
        } else if (ev.kind === 'task') {
          await sendTelegram(`🏢 [Văn phòng 3D] 🔄 *${agentName}*: ${ev.text}`);
        } else if (ev.kind === 'error') {
          await sendTelegram(`🏢 [Văn phòng 3D] ⚠️ *${agentName}* báo lỗi:\n${ev.text}`);
        }
      } else if (msg.type === 'permission' && msg.payload) {
        const p = msg.payload;
        const agentName = agentCache.get(p.agentId) || p.agentId;
        await sendTelegram(`🏢 [Văn phòng 3D] 🔐 *${agentName}* xin quyền:\nCông cụ: ${p.tool || 'Lệnh hệ thống'}\nTham số: ${JSON.stringify(p.params || '')}`);
      } else if (msg.type === 'changed') {
        await refreshAgents();
      }
    } catch (e) {
      console.error('Message handling error:', e);
    }
  });

  ws.on('close', () => {
    console.log('WebSocket closed, reconnecting in 3s...');
    setTimeout(connect, 3000);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
}

connect();
console.log('AI Office Telegram Bridge running...');
