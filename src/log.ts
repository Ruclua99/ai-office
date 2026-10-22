// Ghi mọi dòng console + lỗi không bắt được ra data/server.log để xem lại khi văn phòng bị tắt ngang.
// Import đầu tiên trong server.ts để bắt cả lỗi lúc khởi động.
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';

const LOG = 'data/server.log';
const MAX = 2 * 1024 * 1024;   // quá 2MB thì đổi tên thành server.log.1 và ghi file mới
try { mkdirSync('data', { recursive: true }); } catch { /* bỏ qua */ }

const fmt = (a: unknown) => {
  if (a instanceof Error) return a.stack ?? a.message;
  if (typeof a === 'string') return a;
  try { return JSON.stringify(a); } catch { return String(a); }
};

function write(level: string, args: unknown[]) {
  try {
    if (existsSync(LOG) && statSync(LOG).size > MAX) renameSync(LOG, LOG + '.1');
    const ts = new Date().toLocaleString('vi-VN', { hour12: false });
    appendFileSync(LOG, `[${ts}] ${level} ${args.map(fmt).join(' ')}\n`);
  } catch { /* không ghi được log thì thôi, không làm sập máy chủ */ }
}

for (const level of ['log', 'warn', 'error'] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => { orig(...args); write(level.toUpperCase(), args); };
}

// Lỗi lọt ra ngoài (thường từ 1 nhân viên AI): ghi lại và giữ văn phòng chạy tiếp thay vì tắt cả server
process.on('uncaughtException', (e) => console.error('[Lỗi không bắt được]', e));
process.on('unhandledRejection', (e) => console.error('[Promise bị từ chối]', e));
process.on('exit', (code) => write('EXIT', [`Máy chủ dừng, mã ${code}`]));

write('START', [`Khởi động · Node ${process.version} · ${process.platform}`]);
