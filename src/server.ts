// HTTP + WebSocket server cho văn phòng ảo
import './log.ts';            // ghi log ra data/server.log (phải đứng đầu)
import 'dotenv/config';
import express, { type Request, type Response, type NextFunction } from 'express';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { Office, PROVIDERS } from './office.ts';
import { repo } from './db.ts';
import { discoverSessions } from './observer.ts';
import { pricing } from './pricing.ts';
import { saveUpload, getUpload, isImage, MAX_UPLOAD } from './attachments.ts';
import type { Department } from './types.ts';

const PORT = Number(process.env.PORT ?? 4800);
const HOST = process.env.HOST ?? '127.0.0.1';
// Token chống trang web lạ gọi API localhost của bạn (CSRF / DNS rebinding)
const TOKEN = process.env.OFFICE_TOKEN || randomBytes(16).toString('hex');
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`, ...(process.env.ALLOWED_HOSTS?.split(',') ?? [])]);

// ---------- Seed phòng ban & nhân viên mẫu lần đầu chạy
const office = new Office();
if (existsSync('office.config.json')) {
  const cfg = JSON.parse(readFileSync('office.config.json', 'utf8')) as { departments: Department[]; agents?: any[] };
  const existing = repo.listDepartments();
  if (existing.length === 0) {
    cfg.departments.forEach(d => repo.upsertDepartment(d));
    for (const a of cfg.agents ?? []) office.createAgent(a);
    console.log(`Đã tạo ${cfg.departments.length} phòng ban, ${cfg.agents?.length ?? 0} nhân viên mẫu`);
  } else {
    // Nâng cấp từ bản cũ: phòng ban chưa có style → lấy bố cục mới từ config (một lần duy nhất)
    let migrated = 0;
    for (const d of cfg.departments) {
      const cur = existing.find(e => e.id === d.id);
      if (!cur || !cur.style) { repo.upsertDepartment(d); migrated++; }
    }
    if (migrated) console.log(`Đã cập nhật bố cục 3D cho ${migrated} phòng ban`);
  }
}

const app = express();
app.use(express.json({ limit: '2mb' }));

const hostGuard = (req: Request, res: Response, next: NextFunction) => {
  if (ALLOWED_HOSTS.has('*') || ALLOWED_HOSTS.has(req.headers.host ?? '')) return next();
  return res.status(403).send('Host không được phép');
};
app.use(hostGuard);

// Trang chính: nhúng token vào HTML (trang web khác không đọc được do same-origin policy)
const indexHtml = () => readFileSync('public/index.html', 'utf8').replace('__OFFICE_TOKEN__', TOKEN);
app.get('/', (_req, res) => res.type('html').send(indexHtml()));
// Chưa có model GLB nào → trả manifest rỗng (giao diện dùng đồ dựng bằng code)
app.get('/models/manifest.json', (_req, res, next) => existsSync('public/models/manifest.json') ? next() : res.json({}));
app.use(express.static('public', { index: false }));
// Three.js phục vụ từ node_modules → giao diện chạy được cả khi offline
app.use('/vendor/three', express.static('node_modules/three'));
app.use('/vendor/fonts', express.static('node_modules/@fontsource'));

// Xem lại tệp đính kèm trong nhật ký (thẻ <img> không gửi header được → token qua query)
app.get('/files/:id/:name', (req, res) => {
  if (req.query.t !== TOKEN) return res.status(401).send('Sai token');
  const a = getUpload(String(req.params.id));
  if (!a) return res.status(404).send('Không còn tệp này');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', 'sandbox');
  // Chỉ ảnh mới hiển thị trực tiếp; tệp khác luôn tải về (tránh chạy HTML/JS lạ trong trang văn phòng)
  res.type(isImage(a) ? a.mime : 'application/octet-stream');
  res.setHeader('Content-Disposition', `${isImage(a) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.name)}`);
  res.sendFile(a.path);
});

const api = express.Router();
api.use((req, res, next) => {
  if (req.headers['x-office-token'] !== TOKEN) return res.status(401).json({ error: 'Sai token' });
  next();
});
const wrap = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response) => {
  try { const r = fn(req, res); if (r !== undefined && !res.headersSent) res.json(r); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
};
const id = (req: Request) => String(req.params.id);

api.get('/state', wrap(() => ({ ...office.snapshot(), providers: PROVIDERS })));
api.post('/agents', wrap(req => office.createAgent(req.body)));
api.patch('/agents/:id', wrap(req => office.updateAgent(id(req), req.body)));
api.delete('/agents/:id', wrap(req => { office.deleteAgent(id(req)); return { ok: true }; }));
api.get('/agents/:id/events', wrap(req => repo.listEvents(id(req), Number(req.query.limit ?? 200))));
api.get('/agents/:id/tasks', wrap(req => repo.listTasks(id(req))));
api.post('/agents/:id/tasks', wrap(req => {
  const ids: unknown[] = Array.isArray(req.body.attachments) ? req.body.attachments : [];
  const atts = ids.map(x => getUpload(String(x)));
  if (atts.some(a => !a)) throw new Error('Có tệp đính kèm không còn trên máy, hãy đính kèm lại');
  return office.assignTask(id(req), String(req.body.prompt ?? ''), undefined, undefined, atts as any);
}));
// Tải tệp lên (ảnh dán, file kéo thả). Thân request là dữ liệu thô của tệp.
api.post('/uploads', express.raw({ type: () => true, limit: MAX_UPLOAD }), wrap(req => {
  const name = decodeURIComponent(String(req.headers['x-filename'] ?? 'tep'));
  const a = saveUpload(name, String(req.headers['x-mime'] ?? ''), req.body as Buffer);
  return { id: a.id, name: a.name, mime: a.mime, size: a.size };
}));
api.post('/agents/:id/stop', wrap(req => { office.stopAgent(id(req)); return { cancelledQueued: office.cancelQueued(id(req)) }; }));
api.post('/agents/:id/reset', wrap(req => { office.resetSession(id(req)); return { ok: true }; }));
api.post('/departments', wrap(req => { office.upsertDepartment(req.body); return { ok: true }; }));
api.post('/permissions/:id', wrap(req => ({ ok: office.resolvePermission(id(req), !!req.body.allow) })));
api.get('/tasks', wrap(() => repo.listTasks(undefined, 100)));
api.get('/discover', wrap(() => discoverSessions(40)));
// Token & chi phí: range = today | 7d | 30d | all
api.get('/usage', wrap(req => {
  const range = String(req.query.range ?? 'today');
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const since = range === 'all' ? 0 : range === '30d' ? start.getTime() - 29 * 864e5 : range === '7d' ? start.getTime() - 6 * 864e5 : start.getTime();
  const rows = repo.usageSummary(since);
  const agents: Record<string, any> = {};
  for (const r of rows) {
    const a = agents[r.agentId] ??= { agentId: r.agentId, provider: r.provider, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, unpriced: 0, reported: 0, tasks: 0, models: [] };
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'costUsd', 'unpriced', 'reported', 'tasks'] as const) a[k] += r[k] ?? 0;
    a.models.push(r);
  }
  const list = Object.values(agents).sort((x: any, y: any) => y.costUsd - x.costUsd || (y.input + y.output) - (x.input + x.output));
  const total = list.reduce((t: any, a: any) => { for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'costUsd', 'unpriced', 'tasks']) t[k] += a[k]; return t; },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, unpriced: 0, tasks: 0 });
  return { range, since, agents: list, total, byDay: repo.usageByDay(since), usdToVnd: pricing().usdToVnd ?? null };
}));
app.use('/api', api);

// ---------- WebSocket: đẩy sự kiện real-time cho UI
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname !== '/ws' || url.searchParams.get('token') !== TOKEN || (!ALLOWED_HOSTS.has('*') && !ALLOWED_HOSTS.has(req.headers.host ?? ''))) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

const broadcast = (type: string, payload: unknown) => {
  const msg = JSON.stringify({ type, payload });
  wss.clients.forEach((c: WebSocket) => { if (c.readyState === 1) c.send(msg); });
};
office.on('event', ev => broadcast('event', ev));
office.on('status', s => broadcast('status', s));
office.on('permission', p => broadcast('permission', p));
office.on('permission-resolved', p => broadcast('permission-resolved', p));
office.on('usage', u => broadcast('usage', u));
let changedTimer: NodeJS.Timeout | undefined;
office.on('changed', () => { clearTimeout(changedTimer); changedTimer = setTimeout(() => broadcast('changed', null), 100); });

server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\nCổng ${PORT} đang được dùng: văn phòng có lẽ đã chạy sẵn ở một cửa sổ khác → mở http://localhost:${PORT}.`);
    console.error('Muốn chạy lại từ đầu thì đóng cửa sổ kia trước. (Mã thoát 3)');
    process.exit(3);
  }
  console.error('[server]', e);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log(`\n🏢 Văn phòng ảo: http://localhost:${PORT}`);
  const auth = process.env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY trong .env (trả theo token)'
    : process.env.CLAUDE_CODE_OAUTH_TOKEN ? `CLAUDE_CODE_OAUTH_TOKEN trong .env (${process.env.CLAUDE_CODE_OAUTH_TOKEN.slice(0, 10)}…)`
    : 'đăng nhập Claude Code trên máy (~/.claude)';
  console.log(`   Claude Code đăng nhập bằng: ${auth}`);
  if (!process.env.OFFICE_TOKEN) console.log(`   Token phiên này: ${TOKEN} (đặt OFFICE_TOKEN trong .env để cố định)`);
});

process.on('SIGINT', () => { console.log('\nĐóng văn phòng…'); process.exit(0); });
