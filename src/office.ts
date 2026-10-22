// Lõi văn phòng: quản lý nhân viên, hàng đợi task, trạng thái, xin quyền, phát sự kiện.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { repo } from './db.ts';
import type {
  Agent, AgentAdapter, AgentStatus, Department, EventKind, OfficeApi, OfficeEvent,
  PermissionRequest, PermissionResult, Provider, TaskRecord, Attachment,
} from './types.ts';
import { claudeCodeAdapter } from './adapters/claudeCode.ts';
import { codexAdapter } from './adapters/codex.ts';
import { anthropicChatAdapter, openaiChatAdapter } from './adapters/chat.ts';
import { SessionObserver } from './observer.ts';

const ADAPTERS: Partial<Record<Provider, AgentAdapter>> = {
  'claude-code': claudeCodeAdapter,
  'codex': codexAdapter,
  'anthropic-chat': anthropicChatAdapter,
  'openai-chat': openaiChatAdapter,
};

export const PROVIDERS: Provider[] = ['claude-code', 'codex', 'anthropic-chat', 'openai-chat', 'observer'];

/** Số nhân viên làm việc cùng lúc. Người đang chờ duyệt quyền không tính vào đây. */
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT ?? 6);
/** Xin quyền quá lâu không ai duyệt → tự từ chối để nhân viên làm tiếp phần khác */
const PERMISSION_TIMEOUT_MS = Number(process.env.PERMISSION_TIMEOUT_MIN ?? 30) * 60_000;
/** Một việc bị ngắt bởi khởi động lại tối đa bấy nhiêu lần (tránh vòng lặp sập máy chủ) */
const MAX_RESUMES = 2;
const DENY_BY_USER = 'Người quản lý văn phòng từ chối thao tác này.';
const DENY_BY_TIMEOUT = `Không ai duyệt trong ${PERMISSION_TIMEOUT_MS / 60_000} phút nên tự từ chối. Hãy làm tiếp những phần không cần quyền này, ghi rõ phần còn thiếu trong kết quả.`;
/** Chặn vòng lặp giao việc qua lại vô hạn */
const MAX_DEPTH = Number(process.env.MAX_DELEGATION_DEPTH ?? 3);
/** Mỗi nhân viên được giao tối đa bao nhiêu việc đang chờ */
const MAX_QUEUE_PER_AGENT = Number(process.env.MAX_QUEUE_PER_AGENT ?? 10);

type PendingPerm = PermissionRequest & { resolve: (r: PermissionResult) => void; timer?: NodeJS.Timeout };

export class Office extends EventEmitter implements OfficeApi {
  private status = new Map<string, AgentStatus>();
  private running = new Map<string, { task: TaskRecord; abort: AbortController }>();
  private queue: TaskRecord[] = [];
  private perms = new Map<string, PendingPerm>();
  private observer: SessionObserver;

  constructor() {
    super();
    this.observer = new SessionObserver(
      () => repo.listAgents(),
      (agentId) => (kind, text, data) => this.emitEvent(agentId, kind, text, data),
      (agentId, s) => this.setStatus(agentId, s),
    );
    this.observer.start();
    this.resumeInterrupted();
    this.housekeeping();
  }

  /** Việc đang chờ / đang dở lúc máy chủ tắt → xếp lại hàng đợi, chạy tiếp thay vì bỏ */
  private resumeInterrupted() {
    const tasks = repo.interruptedTasks();
    let resumed = 0;
    for (const t of tasks) {
      const agent = repo.getAgent(t.agentId);
      if (!agent || agent.provider === 'observer') { t.status = 'failed'; t.result = 'Nhân viên không còn'; t.finishedAt = Date.now(); repo.updateTask(t); continue; }
      if (t.status === 'running') {
        t.resumes = (t.resumes ?? 0) + 1;
        if (t.resumes > MAX_RESUMES) {
          t.status = 'failed'; t.result = `Máy chủ bị ngắt ${MAX_RESUMES} lần khi đang làm việc này — dừng để tránh lặp. Hãy giao lại nếu cần.`; t.finishedAt = Date.now();
          repo.updateTask(t);
          this.emitEvent(t.agentId, 'error', t.result);
          continue;
        }
        this.emitEvent(t.agentId, 'system', `Máy chủ khởi động lại khi đang làm dở — sẽ làm tiếp (lần ${t.resumes})`);
      }
      t.status = 'queued';
      repo.updateTask(t);
      this.queue.push(t);
      this.setStatus(t.agentId, 'queued');
      resumed++;
    }
    if (resumed) console.log(`Chạy tiếp ${resumed} việc dở từ lần trước`);
    queueMicrotask(() => this.pump());
  }

  /** Dọn sự kiện cũ, sao lưu DB: lúc khởi động và mỗi giờ */
  private housekeeping() {
    const run = () => {
      try {
        const n = repo.pruneEvents(Number(process.env.KEEP_EVENTS_PER_AGENT ?? 2000));
        if (n) console.log(`Đã dọn ${n} sự kiện cũ`);
        const f = repo.backup();
        if (f) console.log(`Đã sao lưu dữ liệu: ${f}`);
      } catch (e) { console.warn('[housekeeping]', e); }
    };
    setTimeout(run, 3000);
    setInterval(run, 60 * 60_000).unref();
  }

  // ---------------- Trạng thái & sự kiện
  getStatus(agentId: string): AgentStatus {
    return this.status.get(agentId) ?? (repo.getAgent(agentId)?.provider === 'observer' ? 'offline' : 'idle');
  }

  private setStatus(agentId: string, s: AgentStatus) {
    if (this.status.get(agentId) === s) return;
    this.status.set(agentId, s);
    this.emit('status', { agentId, status: s });
  }

  emitEvent(agentId: string, kind: EventKind, text: string, data?: unknown) {
    const ev: OfficeEvent = { agentId, ts: Date.now(), kind, text: text.length > 4000 ? text.slice(0, 4000) + '…' : text, data };
    ev.id = repo.insertEvent(ev);
    this.emit('event', ev);
  }

  snapshot() {
    return {
      departments: repo.listDepartments(),
      agents: repo.listAgents().map(a => ({
        ...a,
        status: this.getStatus(a.id),
        currentTask: this.running.get(a.id)?.task ?? null,
        queued: this.queue.filter(t => t.agentId === a.id).length,
      })),
      permissions: [...this.perms.values()].map(({ resolve, timer, ...p }) => p),
      feed: repo.recentEvents(30),
      limits: { maxConcurrent: MAX_CONCURRENT, maxDepth: MAX_DEPTH },
    };
  }

  // ---------------- Quản lý nhân viên / phòng ban
  createAgent(input: Partial<Agent> & { name: string; departmentId: string; provider: Provider }): Agent {
    if (!PROVIDERS.includes(input.provider)) throw new Error(`provider không hợp lệ: ${input.provider}`);
    if (!repo.listDepartments().some(d => d.id === input.departmentId)) throw new Error('Phòng ban không tồn tại');
    const a: Agent = {
      id: input.id || slug(input.name) + '-' + randomUUID().slice(0, 4),
      name: input.name, role: input.role ?? '', departmentId: input.departmentId, provider: input.provider,
      model: input.model || null, cwd: input.cwd || null, systemPrompt: input.systemPrompt || null,
      permissionMode: input.permissionMode || 'default', sessionId: input.sessionId || null, createdAt: Date.now(),
    };
    repo.insertAgent(a);
    this.emitEvent(a.id, 'system', `${a.name} nhận ghế ở phòng ${this.deptName(a.departmentId)}`);
    this.emit('changed');
    return a;
  }

  updateAgent(id: string, patch: Partial<Agent>): Agent {
    const cur = repo.getAgent(id);
    if (!cur) throw new Error('Không tìm thấy nhân viên');
    const next: Agent = { ...cur, ...patch, id: cur.id, createdAt: cur.createdAt };
    repo.updateAgent(next);
    if (patch.sessionId !== undefined) this.observer.forget(id);
    this.emit('changed');
    return next;
  }

  deleteAgent(id: string) {
    this.stopAgent(id);
    this.queue = this.queue.filter(t => t.agentId !== id);
    repo.deleteAgent(id);
    this.status.delete(id);
    this.observer.forget(id);
    this.emit('changed');
  }

  /** Bắt đầu phiên mới (quên session cũ, xoá lịch sử chat) */
  resetSession(id: string) {
    repo.clearChat(id);
    this.updateAgent(id, { sessionId: null });
    this.emitEvent(id, 'system', 'Đã bắt đầu phiên mới');
  }

  upsertDepartment(d: Department) {
    repo.upsertDepartment(d);
    this.emit('changed');
  }

  private deptName(id: string) {
    return repo.listDepartments().find(d => d.id === id)?.name ?? id;
  }

  // ---------------- OfficeApi (adapter dùng)
  listStaff() {
    const depts = repo.listDepartments();
    return repo.listAgents().map(a => ({
      id: a.id, name: a.name, role: a.role, departmentId: a.departmentId, provider: a.provider,
      department: depts.find(d => d.id === a.departmentId)?.name ?? a.departmentId,
      status: this.getStatus(a.id),
    }));
  }

  getTask(id: string) { return repo.getTask(id); }

  assignTask(toAgentId: string, prompt: string, fromAgentId?: string, parentTaskId?: string, attachments: Attachment[] = []): TaskRecord {
    const agent = repo.getAgent(toAgentId);
    if (!agent) throw new Error(`Không có nhân viên "${toAgentId}"`);
    if (agent.provider === 'observer') throw new Error(`${agent.name} là phiên quan sát, không nhận việc được`);
    if (!prompt.trim() && !attachments.length) throw new Error('Nội dung việc trống');
    if (!prompt.trim()) prompt = 'Xem các tệp đính kèm.';
    if (attachments.length > 10) throw new Error('Tối đa 10 tệp đính kèm mỗi việc');
    const parent = parentTaskId ? repo.getTask(parentTaskId) : undefined;
    const depth = parent ? parent.depth + 1 : 0;
    if (depth > MAX_DEPTH) throw new Error(`Quá ${MAX_DEPTH} cấp giao việc lồng nhau — dừng để tránh vòng lặp`);
    if (this.queue.filter(t => t.agentId === toAgentId).length >= MAX_QUEUE_PER_AGENT) throw new Error(`${agent.name} đang có quá nhiều việc chờ`);

    const t: TaskRecord = {
      id: randomUUID(), agentId: toAgentId, fromAgentId: fromAgentId ?? null, parentTaskId: parentTaskId ?? null,
      depth, prompt, attachments: attachments.length ? attachments : undefined, status: 'queued', createdAt: Date.now(),
    };
    repo.insertTask(t);
    this.queue.push(t);
    const from = fromAgentId ? repo.getAgent(fromAgentId)?.name ?? fromAgentId : 'Quản lý';
    const attInfo = attachments.map(a => ({ id: a.id, name: a.name, mime: a.mime, size: a.size }));
    this.emitEvent(toAgentId, 'task', `${from} giao: ${prompt.slice(0, 300)}${attachments.length ? ` · 📎 ${attachments.length} tệp` : ''}`,
      { taskId: t.id, fromAgentId, ...(attachments.length ? { attachments: attInfo } : {}) });
    if (!this.running.has(toAgentId)) this.setStatus(toAgentId, 'queued');
    queueMicrotask(() => this.pump());
    return t;
  }

  // ---------------- Hàng đợi
  /** Số người thật sự đang chạy (không tính người đang chờ duyệt) */
  private activeCount() {
    let n = 0;
    for (const id of this.running.keys()) if (this.status.get(id) !== 'waiting') n++;
    return n;
  }

  private pump() {
    while (this.activeCount() < MAX_CONCURRENT) {
      const idx = this.queue.findIndex(t => !this.running.has(t.agentId));
      if (idx < 0) return;
      const [task] = this.queue.splice(idx, 1);
      void this.execute(task);
    }
  }

  private async execute(task: TaskRecord) {
    const agent = repo.getAgent(task.agentId);
    const adapter = agent && ADAPTERS[agent.provider];
    if (!agent || !adapter) {
      task.status = 'failed'; task.result = 'Không có adapter'; task.finishedAt = Date.now();
      repo.updateTask(task);
      return;
    }
    const abort = new AbortController();
    this.running.set(agent.id, { task, abort });
    task.status = 'running';
    repo.updateTask(task);
    this.setStatus(agent.id, 'working');

    // Việc chạy tiếp sau khởi động lại: phiên cũ còn ngữ cảnh → chỉ cần nhắc tiếp tục
    const prompt = task.resumes && agent.sessionId
      ? `Máy chủ văn phòng vừa khởi động lại khi bạn đang làm việc dưới đây. Hãy xem lại những gì đã làm trong phiên này và làm tiếp từ chỗ đang dở, đừng làm lại từ đầu. Nếu đã xong rồi thì chỉ cần báo kết quả.\n\n---\nViệc được giao:\n${task.prompt}`
      : task.prompt;
    try {
      const result = await adapter.run(agent, prompt, {
        task,
        office: {
          listStaff: () => this.listStaff(),
          getTask: (id) => this.getTask(id),
          assignTask: (to, p, from, parent, atts) => this.assignTask(to, p, from, parent, atts),
        },
        signal: abort.signal,
        emit: (kind, text, data) => this.emitEvent(agent.id, kind, text, data),
        setStatus: (s) => this.setStatus(agent.id, s),
        setSessionId: (sid) => {
          if (repo.getAgent(agent.id)?.sessionId !== sid) { repo.setSessionId(agent.id, sid); this.emit('changed'); }
        },
        requestPermission: (tool, input) => this.requestPermission(agent.id, tool, input, abort.signal),
        recordUsage: (u) => {
          repo.insertUsage(agent.id, task.id, agent.provider, u);
          this.emit('usage', { agentId: agent.id, taskId: task.id, ...u });
        },
        getBaseline: (sid) => repo.getBaseline(sid),
        setBaseline: (sid, totals) => repo.setBaseline(sid, totals),
      });
      task.status = 'done';
      task.result = result;
    } catch (e: any) {
      const cancelled = abort.signal.aborted;
      task.status = cancelled ? 'cancelled' : 'failed';
      task.result = cancelled ? 'Đã dừng' : (e?.message ?? String(e));
      this.emitEvent(agent.id, cancelled ? 'system' : 'error', task.result!);
    } finally {
      task.finishedAt = Date.now();
      repo.updateTask(task);
      this.running.delete(agent.id);
      this.setStatus(agent.id, task.status === 'failed' ? 'error' : this.queue.some(t => t.agentId === agent.id) ? 'queued' : 'idle');
      this.notifyRequester(task, agent);
      this.pump();
    }
  }

  /** Việc do đồng nghiệp giao xong → báo vào nhật ký người giao */
  private notifyRequester(task: TaskRecord, agent: Agent) {
    if (!task.fromAgentId) return;
    const label = task.status === 'done' ? 'hoàn thành' : task.status === 'cancelled' ? 'đã dừng' : 'thất bại';
    this.emitEvent(task.fromAgentId, 'result', `${agent.name} ${label} việc ${task.id.slice(0, 8)}: ${(task.result ?? '').slice(0, 500)}`, { taskId: task.id });
  }

  stopAgent(agentId: string) {
    this.running.get(agentId)?.abort.abort();
    for (const p of this.perms.values()) if (p.agentId === agentId) this.resolvePermission(p.id, false);
  }

  cancelQueued(agentId: string) {
    const removed = this.queue.filter(t => t.agentId === agentId);
    this.queue = this.queue.filter(t => t.agentId !== agentId);
    for (const t of removed) { t.status = 'cancelled'; t.finishedAt = Date.now(); repo.updateTask(t); }
    if (!this.running.has(agentId)) this.setStatus(agentId, 'idle');
    return removed.length;
  }

  // ---------------- Xin quyền
  private requestPermission(agentId: string, tool: string, input: unknown, signal: AbortSignal): Promise<PermissionResult> {
    return new Promise((resolve) => {
      const req: PendingPerm = { id: randomUUID(), agentId, tool, input, createdAt: Date.now(), resolve };
      this.perms.set(req.id, req);
      this.setStatus(agentId, 'waiting');
      const { resolve: _r, timer: _t, ...pub } = req;
      this.emitEvent(agentId, 'permission', `Xin quyền dùng ${tool}`, pub);
      this.emit('permission', pub);
      signal.addEventListener('abort', () => this.resolvePermission(req.id, false), { once: true });
      if (PERMISSION_TIMEOUT_MS > 0) req.timer = setTimeout(() => this.resolvePermission(req.id, false, 'timeout'), PERMISSION_TIMEOUT_MS).unref();
      queueMicrotask(() => this.pump());   // người này tạm dừng → nhường suất cho việc đang chờ
    });
  }

  resolvePermission(id: string, allow: boolean, why: 'user' | 'timeout' = 'user') {
    const p = this.perms.get(id);
    if (!p) return false;
    this.perms.delete(id);
    clearTimeout(p.timer);
    p.resolve({ allow, reason: allow ? 'Quản lý đã duyệt' : why === 'timeout' ? DENY_BY_TIMEOUT : DENY_BY_USER });
    if (this.running.has(p.agentId)) this.setStatus(p.agentId, 'working');
    this.emitEvent(p.agentId, 'system', allow ? `Cho phép ${p.tool}` : why === 'timeout' ? `Hết ${PERMISSION_TIMEOUT_MS / 60_000} phút không ai duyệt ${p.tool} → tự từ chối` : `Từ chối ${p.tool}`);
    this.emit('permission-resolved', { id, allow });
    return true;
  }
}

function slug(s: string) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'agent';
}
