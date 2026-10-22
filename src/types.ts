// Kiểu dữ liệu dùng chung cho toàn bộ văn phòng ảo

/** Loại "nhân viên" — mỗi loại tương ứng một adapter */
export type Provider =
  | 'claude-code'    // Phiên Claude Code thật, điều khiển qua Claude Agent SDK (có tool, đọc/ghi file)
  | 'codex'          // Phiên OpenAI Codex CLI, điều khiển qua @openai/codex-sdk
  | 'anthropic-chat' // Chỉ chat, gọi Anthropic Messages API
  | 'openai-chat'    // Chỉ chat, gọi OpenAI Responses API
  | 'observer';      // Gắn vào phiên Claude Code đang chạy sẵn (chỉ xem)

export type AgentStatus = 'idle' | 'queued' | 'working' | 'waiting' | 'error' | 'offline';

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

export type DeptShape = 'zone' | 'lounge' | 'room';
export type ScreenTheme = 'code' | 'design' | 'charts' | 'media' | 'video' | 'docs';

/** Kiểu hiển thị 3D của phòng ban */
export interface DeptStyle {
  /** zone: thảm bo tròn có cụm bàn · lounge: khu sofa trung tâm · room: phòng họp vách kính */
  shape?: DeptShape;
  /** Nội dung hiện trên màn hình của nhân viên phòng này */
  screenTheme?: ScreenTheme;
  /** Chữ in trên sàn (mặc định = tên phòng) */
  label?: string;
  /** Seed cho đồ trang trí ngẫu nhiên nhưng ổn định */
  seed?: number;
}

export interface Department {
  id: string;
  name: string;
  color: string;
  /** Toạ độ tâm & kích thước khu vực trên sàn 3D (đơn vị mét). Sàn: x -18..18, z -14..14 */
  x: number; z: number; w: number; d: number;
  style?: DeptStyle | null;
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  departmentId: string;
  provider: Provider;
  model?: string | null;
  cwd?: string | null;
  systemPrompt?: string | null;
  permissionMode?: PermissionMode | null;
  /** Claude: session_id · Codex: thread_id · OpenAI chat: previous_response_id · Observer: id file JSONL */
  sessionId?: string | null;
  createdAt: number;
}

export interface Attachment { id: string; name: string; mime: string; size: number; path: string }

export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface TaskRecord {
  id: string;
  agentId: string;
  fromAgentId?: string | null;
  parentTaskId?: string | null;
  depth: number;
  prompt: string;
  /** Ảnh / tệp người giao gửi kèm */
  attachments?: Attachment[];
  status: TaskStatus;
  result?: string | null;
  createdAt: number;
  finishedAt?: number | null;
  /** Số lần máy chủ khởi động lại giữa chừng và chạy tiếp việc này */
  resumes?: number;
}

export interface PermissionResult { allow: boolean; reason: string }

export type EventKind = 'status' | 'message' | 'tool' | 'result' | 'error' | 'task' | 'permission' | 'system';

export interface OfficeEvent {
  id?: number;
  agentId: string;
  ts: number;
  kind: EventKind;
  text: string;
  data?: unknown;
}

export interface PermissionRequest {
  id: string;
  agentId: string;
  tool: string;
  input: unknown;
  createdAt: number;
}

/** API văn phòng mà adapter được phép gọi (giao việc, xem đồng nghiệp…) */
export interface OfficeApi {
  listStaff(): Array<Pick<Agent, 'id' | 'name' | 'role' | 'departmentId' | 'provider'> & { department: string; status: AgentStatus }>;
  assignTask(toAgentId: string, prompt: string, fromAgentId: string, parentTaskId?: string, attachments?: Attachment[]): TaskRecord;
  getTask(taskId: string): TaskRecord | undefined;
}

/** Một lần dùng token (một việc / một model) */
export interface UsageRecord {
  model: string;
  input: number;        // token vào (không gồm cache)
  output: number;       // token ra
  cacheRead: number;    // token đọc từ cache (rẻ hơn)
  cacheWrite: number;   // token ghi vào cache
  costUsd: number | null;
  /** reported: do Claude Code tự tính · estimated: tính theo pricing.json · none: chưa có bảng giá */
  costSource: 'reported' | 'estimated' | 'none';
}

export interface AdapterContext {
  task: TaskRecord;
  office: OfficeApi;
  emit(kind: EventKind, text: string, data?: unknown): void;
  setStatus(status: AgentStatus): void;
  setSessionId(id: string): void;
  /** Hỏi người dùng (qua UI) có cho phép agent dùng tool này không */
  requestPermission(tool: string, input: unknown): Promise<PermissionResult>;
  /** Ghi nhận token/chi phí của việc đang chạy */
  recordUsage(rec: UsageRecord): void;
  /** Mốc cộng dồn của một phiên Claude Code (để tính phần chênh lệch) */
  getBaseline(sessionId: string): Record<string, ModelTotals> | undefined;
  setBaseline(sessionId: string, totals: Record<string, ModelTotals>): void;
  signal: AbortSignal;
}

export interface ModelTotals { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }

export interface AgentAdapter {
  /** Chạy 1 task, trả về câu trả lời cuối cùng */
  run(agent: Agent, prompt: string, ctx: AdapterContext): Promise<string>;
}
