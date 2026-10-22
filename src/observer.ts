// Chế độ quan sát: gắn nhân viên vào phiên Claude Code / Codex bạn đang chạy trong terminal.
// Chỉ ĐỌC file transcript JSONL, không điều khiển phiên. Định dạng JSONL là nội bộ
// của từng CLI và có thể đổi theo phiên bản → mọi chỗ parse dồn vào parseLine().
import { readdirSync, statSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import type { Agent, EventKind } from './types.ts';

const CLAUDE_DIR = process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects');
const CODEX_DIR = process.env.CODEX_SESSIONS_DIR ?? join(homedir(), '.codex', 'sessions');

export interface DiscoveredSession {
  source: 'claude' | 'codex';
  file: string;
  /** Claude: tên file = session id · Codex: UUID ở cuối tên file rollout-… */
  sessionId: string;
  project: string;
  cwd?: string;
  mtime: number;
  preview: string;
}

function walkJsonl(dir: string, depth: number, out: string[]) {
  if (!existsSync(dir) || depth < 0) return;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) walkJsonl(p, depth - 1, out);
    else if (name.name.endsWith('.jsonl')) out.push(p);
  }
}

function readHead(file: string, bytes = 16384): string {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally { closeSync(fd); }
}

/** Thư mục gốc của phiên — cần đúng cwd thì mới resume được phiên Claude Code */
function sessionCwd(head: string): string {
  for (const line of head.split('\n')) {
    try {
      const o = JSON.parse(line);
      const cwd = o?.cwd ?? o?.payload?.cwd;
      if (typeof cwd === 'string' && cwd) return cwd;
    } catch { /* dòng cắt dở */ }
  }
  return '';
}

function firstUserText(head: string): string {
  for (const line of head.split('\n')) {
    try {
      const o = JSON.parse(line);
      const c = o?.message?.role === 'user' ? o.message.content : o?.payload?.role === 'user' ? o.payload.content : undefined;
      const t = typeof c === 'string' ? c : Array.isArray(c) ? c.find((b: any) => b.type === 'text' || b.type === 'input_text')?.text : undefined;
      if (t && !t.startsWith('<')) return t.slice(0, 120);
    } catch { /* dòng cắt dở */ }
  }
  return '';
}

/** Liệt kê các phiên gần đây để người dùng chọn "gắn vào ghế" */
export function discoverSessions(limit = 30): DiscoveredSession[] {
  const out: DiscoveredSession[] = [];
  const claudeFiles: string[] = []; walkJsonl(CLAUDE_DIR, 1, claudeFiles);
  const codexFiles: string[] = []; walkJsonl(CODEX_DIR, 4, codexFiles);
  for (const [source, files] of [['claude', claudeFiles], ['codex', codexFiles]] as const) {
    for (const file of files) {
      try {
        const st = statSync(file);
        out.push({
          source, file, mtime: st.mtimeMs,
          sessionId: source === 'codex'
            ? (basename(file, '.jsonl').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)?.[0] ?? basename(file, '.jsonl'))
            : basename(file, '.jsonl'),
          project: source === 'claude' ? basename(join(file, '..')).replace(/^-/, '').replace(/-/g, '/') : 'codex',
          preview: '',
        });
      } catch { /* file bị xoá giữa chừng */ }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  const top = out.slice(0, limit);
  for (const s of top) {
    try {
      const head = readHead(s.file);
      s.preview = firstUserText(head);
      s.cwd = sessionCwd(head);
      if (s.cwd) s.project = s.cwd;
    } catch { /* bỏ qua */ }
  }
  return top;
}

type Emit = (kind: EventKind, text: string, data?: unknown) => void;

/** Chuyển 1 dòng JSONL (Claude hoặc Codex) thành sự kiện văn phòng */
function parseLine(line: string, emit: Emit) {
  let o: any;
  try { o = JSON.parse(line); } catch { return; }

  // --- Claude Code transcript
  if (o.type === 'assistant' && o.message?.content) {
    for (const b of o.message.content) {
      if (b.type === 'text' && b.text?.trim()) emit('message', b.text);
      else if (b.type === 'tool_use') emit('tool', `${b.name}`, { tool: b.name });
    }
    return;
  }
  if (o.type === 'user' && typeof o.message?.content === 'string' && !o.message.content.startsWith('<')) {
    emit('task', `Người dùng: ${o.message.content.slice(0, 300)}`);
    return;
  }

  // --- Codex rollout (định dạng có thể đổi; chỉ bắt các loại phổ biến)
  const p = o.payload;
  if (o.type === 'event_msg' && p?.type === 'agent_message' && p.message) emit('message', p.message);
  else if (o.type === 'event_msg' && p?.type === 'user_message' && p.message) emit('task', `Người dùng: ${String(p.message).slice(0, 300)}`);
  else if (o.type === 'response_item' && (p?.type === 'function_call' || p?.type === 'local_shell_call')) emit('tool', p.name ?? 'shell', { tool: p.name ?? 'shell' });
}

interface Tail { offset: number; lastSize: number; lastChange: number; }

/**
 * Theo dõi các nhân viên provider=observer. sessionId của họ là đường dẫn tuyệt đối tới file JSONL.
 * Trạng thái: file vừa thay đổi trong ACTIVE_MS → "working", ngược lại "idle".
 */
export class SessionObserver {
  private tails = new Map<string, Tail>();
  private timer?: NodeJS.Timeout;
  private ACTIVE_MS = 8000;

  constructor(
    private getAgents: () => Agent[],
    private emitFor: (agentId: string) => Emit,
    private setStatus: (agentId: string, s: 'working' | 'idle' | 'offline') => void,
  ) {}

  start(intervalMs = 1500) {
    this.timer = setInterval(() => this.tick(), intervalMs);
  }
  stop() { clearInterval(this.timer); }

  private tick() {
    const now = Date.now();
    for (const a of this.getAgents()) {
      if (a.provider !== 'observer' || !a.sessionId) continue;
      const file = a.sessionId;
      let size: number;
      try { size = statSync(file).size; } catch { this.setStatus(a.id, 'offline'); continue; }

      let t = this.tails.get(a.id);
      if (!t) {
        // Lần đầu gắn: bỏ qua lịch sử cũ, chỉ theo dõi từ bây giờ
        t = { offset: size, lastSize: size, lastChange: 0 };
        this.tails.set(a.id, t);
      }
      if (size < t.offset) t.offset = 0; // file bị ghi lại
      if (size > t.offset) {
        const fd = openSync(file, 'r');
        try {
          const len = Math.min(size - t.offset, 2 * 1024 * 1024);
          const buf = Buffer.alloc(len);
          readSync(fd, buf, 0, len, t.offset);
          const chunk = buf.toString('utf8');
          const lastNl = chunk.lastIndexOf('\n');
          if (lastNl >= 0) {
            const emit = this.emitFor(a.id);
            for (const line of chunk.slice(0, lastNl).split('\n')) if (line.trim()) parseLine(line, emit);
            t.offset += Buffer.byteLength(chunk.slice(0, lastNl + 1));
          }
        } finally { closeSync(fd); }
      }
      if (size !== t.lastSize) { t.lastSize = size; t.lastChange = now; }
      this.setStatus(a.id, now - t.lastChange < this.ACTIVE_MS ? 'working' : 'idle');
    }
  }

  forget(agentId: string) { this.tails.delete(agentId); }
}
