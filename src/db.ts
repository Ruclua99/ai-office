// Lưu trữ SQLite dùng node:sqlite (có sẵn trong Node >= 22.13, không cần build native)
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent, Department, ModelTotals, OfficeEvent, TaskRecord, UsageRecord } from './types.ts';

mkdirSync('data', { recursive: true });
export const db = new DatabaseSync(process.env.DB_PATH ?? 'data/office.db');

db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL,
  x REAL NOT NULL, z REAL NOT NULL, w REAL NOT NULL, d REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '',
  department_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT, cwd TEXT,
  system_prompt TEXT, permission_mode TEXT, session_id TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, from_agent_id TEXT, parent_task_id TEXT,
  depth INTEGER NOT NULL DEFAULT 0, prompt TEXT NOT NULL, status TEXT NOT NULL,
  result TEXT, created_at INTEGER NOT NULL, finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, ts INTEGER NOT NULL,
  kind TEXT NOT NULL, text TEXT NOT NULL, data TEXT
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, role TEXT NOT NULL,
  content TEXT NOT NULL, ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent_id, id);
CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_agent ON chat_messages(agent_id, id);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, task_id TEXT, ts INTEGER NOT NULL,
  provider TEXT NOT NULL, model TEXT NOT NULL, input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0, cost_usd REAL, cost_source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage(ts);
CREATE INDEX IF NOT EXISTS idx_usage_agent ON usage(agent_id, ts);
CREATE TABLE IF NOT EXISTS usage_baseline (session_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
`);

// Migration: cột style (JSON) cho phòng ban — DB tạo từ bản cũ chưa có
const deptCols = (db.prepare('PRAGMA table_info(departments)').all() as Array<{ name: string }>).map(c => c.name);
if (!deptCols.includes('style')) db.exec('ALTER TABLE departments ADD COLUMN style TEXT');
// Migration: tệp đính kèm của task, số lần chạy tiếp sau khi khởi động lại
const taskCols = (db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map(c => c.name);
if (!taskCols.includes('attachments')) db.exec('ALTER TABLE tasks ADD COLUMN attachments TEXT');
if (!taskCols.includes('resumes')) db.exec('ALTER TABLE tasks ADD COLUMN resumes INTEGER NOT NULL DEFAULT 0');

type Row = Record<string, any>;

const parseJson = (v: unknown) => { try { return v ? JSON.parse(String(v)) : null; } catch { return null; } };
const toDept = (r: Row): Department => ({ id: r.id, name: r.name, color: r.color, x: r.x, z: r.z, w: r.w, d: r.d, style: parseJson(r.style) });
const toAgent = (r: Row): Agent => ({
  id: r.id, name: r.name, role: r.role, departmentId: r.department_id, provider: r.provider,
  model: r.model, cwd: r.cwd, systemPrompt: r.system_prompt, permissionMode: r.permission_mode,
  sessionId: r.session_id, createdAt: r.created_at,
});
const toTask = (r: Row): TaskRecord => ({
  id: r.id, agentId: r.agent_id, fromAgentId: r.from_agent_id, parentTaskId: r.parent_task_id,
  depth: r.depth, prompt: r.prompt, attachments: parseJson(r.attachments) ?? undefined, status: r.status, result: r.result,
  createdAt: r.created_at, finishedAt: r.finished_at, resumes: r.resumes ?? 0,
});
const toEvent = (r: Row): OfficeEvent => ({
  id: r.id, agentId: r.agent_id, ts: r.ts, kind: r.kind, text: r.text,
  data: r.data ? JSON.parse(r.data) : undefined,
});

export const repo = {
  // ---- Phòng ban
  listDepartments: () => (db.prepare('SELECT * FROM departments ORDER BY rowid').all() as Row[]).map(toDept),
  upsertDepartment(d: Department) {
    db.prepare(`INSERT INTO departments (id,name,color,x,z,w,d,style) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,color=excluded.color,x=excluded.x,z=excluded.z,w=excluded.w,d=excluded.d,style=excluded.style`)
      .run(d.id, d.name, d.color, d.x, d.z, d.w, d.d, d.style ? JSON.stringify(d.style) : null);
  },

  // ---- Nhân viên
  listAgents: () => (db.prepare('SELECT * FROM agents ORDER BY created_at').all() as Row[]).map(toAgent),
  getAgent(id: string) {
    const r = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Row | undefined;
    return r ? toAgent(r) : undefined;
  },
  insertAgent(a: Agent) {
    db.prepare(`INSERT INTO agents (id,name,role,department_id,provider,model,cwd,system_prompt,permission_mode,session_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(a.id, a.name, a.role, a.departmentId, a.provider, a.model ?? null, a.cwd ?? null,
        a.systemPrompt ?? null, a.permissionMode ?? null, a.sessionId ?? null, a.createdAt);
  },
  updateAgent(a: Agent) {
    db.prepare(`UPDATE agents SET name=?,role=?,department_id=?,provider=?,model=?,cwd=?,system_prompt=?,permission_mode=?,session_id=? WHERE id=?`)
      .run(a.name, a.role, a.departmentId, a.provider, a.model ?? null, a.cwd ?? null,
        a.systemPrompt ?? null, a.permissionMode ?? null, a.sessionId ?? null, a.id);
  },
  setSessionId(agentId: string, sessionId: string) {
    db.prepare('UPDATE agents SET session_id = ? WHERE id = ?').run(sessionId, agentId);
  },
  deleteAgent(id: string) {
    db.prepare('DELETE FROM agents WHERE id = ?').run(id);
    db.prepare('DELETE FROM chat_messages WHERE agent_id = ?').run(id);
  },

  // ---- Task
  insertTask(t: TaskRecord) {
    db.prepare(`INSERT INTO tasks (id,agent_id,from_agent_id,parent_task_id,depth,prompt,status,result,created_at,finished_at,attachments)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(t.id, t.agentId, t.fromAgentId ?? null, t.parentTaskId ?? null, t.depth, t.prompt, t.status,
        t.result ?? null, t.createdAt, t.finishedAt ?? null, t.attachments?.length ? JSON.stringify(t.attachments) : null);
  },
  updateTask(t: TaskRecord) {
    db.prepare('UPDATE tasks SET status=?, result=?, finished_at=?, resumes=? WHERE id=?')
      .run(t.status, t.result ?? null, t.finishedAt ?? null, t.resumes ?? 0, t.id);
  },
  getTask(id: string) {
    const r = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return r ? toTask(r) : undefined;
  },
  listTasks(agentId?: string, limit = 50) {
    const rows = agentId
      ? db.prepare('SELECT * FROM tasks WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?').all(agentId, limit)
      : db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?').all(limit);
    return (rows as Row[]).map(toTask);
  },
  /** Task đang chờ hoặc đang chạy dở lúc server tắt (để chạy tiếp khi khởi động lại) */
  interruptedTasks() {
    return (db.prepare(`SELECT * FROM tasks WHERE status IN ('queued','running') ORDER BY created_at`).all() as Row[]).map(toTask);
  },

  // ---- Dọn dẹp & sao lưu
  /** Mỗi nhân viên chỉ giữ `keep` sự kiện gần nhất; trả về số dòng đã xoá */
  pruneEvents(keep = 2000) {
    let removed = 0;
    for (const { agent_id } of db.prepare('SELECT DISTINCT agent_id FROM events').all() as Array<{ agent_id: string }>) {
      const edge = db.prepare('SELECT id FROM events WHERE agent_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?').get(agent_id, keep) as { id: number } | undefined;
      if (edge) removed += Number(db.prepare('DELETE FROM events WHERE agent_id = ? AND id <= ?').run(agent_id, edge.id).changes);
    }
    if (removed) db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return removed;
  },
  /** Sao lưu DB vào data/backup/office-YYYY-MM-DD.db (mỗi ngày 1 bản, giữ `keepDays` bản gần nhất) */
  backup(keepDays = 7) {
    const dir = 'data/backup';
    mkdirSync(dir, { recursive: true });
    const d = new Date(), name = `office-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.db`;
    const file = join(dir, name);
    if (existsSync(file)) return null;
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const old = readdirSync(dir).filter(f => /^office-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -keepDays);
    for (const f of old) { try { unlinkSync(join(dir, f)); } catch { /* bỏ qua */ } }
    return file;
  },

  // ---- Sự kiện
  insertEvent(e: OfficeEvent): number {
    const r = db.prepare('INSERT INTO events (agent_id,ts,kind,text,data) VALUES (?,?,?,?,?)')
      .run(e.agentId, e.ts, e.kind, e.text, e.data === undefined ? null : JSON.stringify(e.data));
    return Number(r.lastInsertRowid);
  },
  listEvents(agentId: string, limit = 200) {
    const rows = db.prepare('SELECT * FROM (SELECT * FROM events WHERE agent_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id').all(agentId, limit);
    return (rows as Row[]).map(toEvent);
  },
  recentEvents(limit = 30) {
    const rows = db.prepare(`SELECT * FROM (SELECT * FROM events WHERE kind IN ('task','result','error','permission') ORDER BY id DESC LIMIT ?) ORDER BY id`).all(limit);
    return (rows as Row[]).map(toEvent);
  },

  // ---- Token & chi phí
  insertUsage(agentId: string, taskId: string | null, provider: string, u: UsageRecord) {
    db.prepare(`INSERT INTO usage (agent_id,task_id,ts,provider,model,input,output,cache_read,cache_write,cost_usd,cost_source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(agentId, taskId, Date.now(), provider, u.model, u.input, u.output, u.cacheRead, u.cacheWrite, u.costUsd, u.costSource);
  },
  /** Tổng hợp theo nhân viên + model từ thời điểm `since` (ms) */
  usageSummary(since: number) {
    return db.prepare(`SELECT agent_id AS agentId, provider, model,
        SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cacheRead, SUM(cache_write) AS cacheWrite,
        SUM(COALESCE(cost_usd,0)) AS costUsd, SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced,
        SUM(CASE WHEN cost_source='reported' THEN 1 ELSE 0 END) AS reported,
        COUNT(DISTINCT task_id) AS tasks, COUNT(*) AS rows, MAX(ts) AS lastTs
      FROM usage WHERE ts >= ? GROUP BY agent_id, provider, model ORDER BY costUsd DESC`).all(since) as any[];
  },
  usageByDay(since: number) {
    return db.prepare(`SELECT date(ts/1000,'unixepoch','localtime') AS day, SUM(input+output+cache_read+cache_write) AS tokens,
        SUM(COALESCE(cost_usd,0)) AS costUsd FROM usage WHERE ts >= ? GROUP BY day ORDER BY day`).all(since) as any[];
  },
  getBaseline(sessionId: string): Record<string, ModelTotals> | undefined {
    const r = db.prepare('SELECT data FROM usage_baseline WHERE session_id = ?').get(sessionId) as Row | undefined;
    return r ? JSON.parse(r.data) : undefined;
  },
  setBaseline(sessionId: string, totals: Record<string, ModelTotals>) {
    db.prepare(`INSERT INTO usage_baseline (session_id,data,updated_at) VALUES (?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`).run(sessionId, JSON.stringify(totals), Date.now());
  },

  // ---- Lịch sử chat (cho anthropic-chat)
  chatHistory(agentId: string, limit = 20) {
    const rows = db.prepare('SELECT * FROM (SELECT * FROM chat_messages WHERE agent_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id').all(agentId, limit) as Row[];
    return rows.map(r => ({ role: r.role as 'user' | 'assistant', content: r.content as string }));
  },
  addChat(agentId: string, role: 'user' | 'assistant', content: string) {
    db.prepare('INSERT INTO chat_messages (agent_id,role,content,ts) VALUES (?,?,?,?)').run(agentId, role, content, Date.now());
  },
  clearChat(agentId: string) {
    db.prepare('DELETE FROM chat_messages WHERE agent_id = ?').run(agentId);
  },
};
