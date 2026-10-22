// Nhân viên = 1 phiên Claude Code thật, điều khiển qua Claude Agent SDK.
// Phiên được lưu ở ~/.claude/projects như phiên Claude Code bình thường, nên có thể
// mở lại trong terminal bằng `claude --resume <sessionId>`.
import { query, createSdkMcpServer, tool, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { AgentAdapter, ModelTotals } from '../types.ts';
import { officeBrief, clip } from './common.ts';
import { attachmentNote, inlineImage, b64, UPLOAD_DIR } from '../attachments.ts';

/** Tool an toàn, cho phép chạy không cần hỏi */
const OFFICE_TOOLS = ['mcp__office__list_staff', 'mcp__office__assign_task', 'mcp__office__get_task'];
// ToolSearch chỉ tải schema tool (MCP tool thường được nạp trễ qua nó) → phải cho phép
const SAFE_TOOLS = new Set([...OFFICE_TOOLS, 'ToolSearch', 'Read', 'Glob', 'Grep', 'TodoWrite', 'LS', 'NotebookRead']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * Biến môi trường của phiên Claude Code cha (khi bạn chạy server từ trong terminal Claude Code)
 * có thể làm phiên con tự duyệt mọi tool → lọc bỏ trước khi spawn.
 */
function cleanEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || v === '') continue;   // biến rỗng trong .env (vd ANTHROPIC_API_KEY=) có thể che token OAuth
    // Giữ lại thông tin đăng nhập (CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CODE_USE_BEDROCK…)
    if (/^(CLAUDECODE$|CCR_AUTO_MODE|CLAUDE_AUTO_|CLAUDE_CODE_(ENTRYPOINT|SESSION_ID|CHILD_SESSION|SESSION_ATTENDED)$)/.test(k)) continue;
    out[k] = v;
  }
  return out;
}

const fmtTok = (n: number) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);

export const claudeCodeAdapter: AgentAdapter = {
  async run(agent, prompt, ctx) {
    const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

    // MCP server chạy trong cùng process: cho agent "nói chuyện" với văn phòng
    const officeMcp = createSdkMcpServer({
      name: 'office',
      version: '1.0.0',
      tools: [
        tool('list_staff', 'Liệt kê nhân viên trong văn phòng, phòng ban và trạng thái hiện tại', {},
          async () => text(JSON.stringify(ctx.office.listStaff(), null, 2))),
        tool('assign_task', 'Giao một việc cho đồng nghiệp. Trả về task_id để theo dõi.',
          {
            agent_id: z.string().describe('id nhân viên nhận việc'),
            task: z.string().describe('mô tả việc cần làm, đủ bối cảnh'),
            forward_attachments: z.boolean().optional().describe('true = chuyển kèm toàn bộ ảnh/tệp mà quản lý đã đính kèm trong việc hiện tại (vd ảnh tham khảo cho designer)'),
          },
          async ({ agent_id, task, forward_attachments }) => {
            try {
              const t = ctx.office.assignTask(agent_id, task, agent.id, ctx.task.id, forward_attachments ? ctx.task.attachments : undefined);
              ctx.emit('task', `Giao việc ${t.id.slice(0, 8)} cho ${agent_id}`);
              return text(`Đã giao. task_id=${t.id}`);
            } catch (e: any) {
              return text(`Lỗi: ${e.message}`);
            }
          }),
        tool('get_task', 'Xem trạng thái và kết quả của một task đã giao', { task_id: z.string() },
          async ({ task_id }) => {
            const t = ctx.office.getTask(task_id);
            return text(t ? JSON.stringify({ status: t.status, result: t.result }, null, 2) : 'Không tìm thấy task');
          }),
      ],
    });

    const abort = new AbortController();
    ctx.signal.addEventListener('abort', () => abort.abort(), { once: true });

    // SDK MCP server yêu cầu prompt dạng stream (AsyncIterable)
    // Ảnh nhỏ gửi thẳng để model "nhìn" được; mọi tệp đều kèm đường dẫn để đọc bằng Read
    const atts = ctx.task.attachments ?? [];
    const content: any = atts.length
      ? [
          ...atts.filter(inlineImage).map(a => ({ type: 'image', source: { type: 'base64', media_type: a.mime, data: b64(a) } })),
          { type: 'text', text: prompt + attachmentNote(atts, { canReadFiles: true, inlined: inlineImage })
            + '\nCần đưa các tệp này cho đồng nghiệp thì gọi assign_task với forward_attachments=true.' },
        ]
      : prompt;
    async function* input(): AsyncGenerator<SDKUserMessage> {
      yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null } as SDKUserMessage;
    }

    const mode = agent.permissionMode ?? 'default';
    const newSessionId = randomUUID();
    if (!agent.sessionId) ctx.setSessionId(newSessionId);
    const q = query({
      prompt: input(),
      options: {
        cwd: agent.cwd || process.cwd(),
        additionalDirectories: atts.length ? [UPLOAD_DIR] : undefined,
        resume: agent.sessionId || undefined,
        // Phiên mới: tự cấp UUID để mỗi nhân viên chắc chắn có phiên riêng
        sessionId: agent.sessionId ? undefined : newSessionId,
        model: agent.model || undefined,
        // 'plan' và 'acceptEdits' do hook bên dưới tự xử lý → SDK chỉ cần default/bypass
        permissionMode: mode === 'bypassPermissions' ? 'bypassPermissions' : 'default',
        allowDangerouslySkipPermissions: mode === 'bypassPermissions' ? true : undefined,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: officeBrief(agent, ctx.office, true) },
        mcpServers: { office: officeMcp },
        allowedTools: OFFICE_TOOLS,
        abortController: abort,
        env: cleanEnv(),
        // Cổng duyệt quyền chính: hook PreToolUse chạy TRƯỚC các rule allow trong settings,
        // nên văn phòng luôn kiểm soát được (canUseTool có thể bị settings "che" mất).
        hooks: {
          PreToolUse: [{
            hooks: [async (input: any) => {
              const name: string = input.tool_name;
              const decide = (d: 'allow' | 'deny', reason: string) =>
                ({ hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: d, permissionDecisionReason: reason } });
              if (SAFE_TOOLS.has(name) || mode === 'bypassPermissions') return decide('allow', 'Tool an toàn');
              if (mode === 'plan') return decide('deny', 'Nhân viên này chỉ được đọc và lập kế hoạch.');
              if (mode === 'acceptEdits' && EDIT_TOOLS.has(name)) return decide('allow', 'Được phép sửa file');
              const r = await ctx.requestPermission(name, input.tool_input);
              return r.allow ? decide('allow', 'Quản lý đã duyệt') : decide('deny', r.reason);
            }],
          }],
        },
        // Dự phòng nếu CLI vẫn hỏi quyền sau hook
        canUseTool: async (toolName, toolInput) => {
          const r = await ctx.requestPermission(toolName, toolInput);
          return r.allow
            ? { behavior: 'allow', updatedInput: toolInput }
            : { behavior: 'deny', message: r.reason };
        },
      },
    });

    const resumedUnknown = !!agent.sessionId;   // phiên có sẵn: chưa chắc có mốc cộng dồn
    let finalText = '';
    let usageDone = false;
    let runCost: number | null = null;     // chi phí riêng lần chạy này (đã trừ phần cũ của phiên)
    let runTokens = 0;
    const recordUsage = (m: any) => {
      if (usageDone || !m.session_id || !m.modelUsage) return;
      usageDone = true;
      const cur: Record<string, ModelTotals> = {};
      for (const [model, u] of Object.entries<any>(m.modelUsage)) {
        cur[model] = { input: u.inputTokens ?? 0, output: u.outputTokens ?? 0, cacheRead: u.cacheReadInputTokens ?? 0, cacheWrite: u.cacheCreationInputTokens ?? 0, cost: u.costUSD ?? 0 };
      }
      let prev = ctx.getBaseline(m.session_id);
      if (!prev && resumedUnknown) {
        // Phiên tạo ngoài văn phòng (hoặc trước khi có tính năng này): lấy mức hiện tại làm mốc, không tính phần cũ
        const old = Object.values(cur).reduce((s, v) => s + v.cost, 0);
        ctx.setBaseline(m.session_id, cur);
        if (old > 0) ctx.emit('system', `Phiên cũ đã dùng ~$${old.toFixed(2)} trước khi vào văn phòng — không tính vào chi phí văn phòng.`);
        return;
      }
      prev ??= {};
      for (const [model, c] of Object.entries(cur)) {
        const p = prev[model];
        // tổng nhỏ hơn mốc → phiên đã bị /clear hoặc nén → tính từ 0
        const d = p && c.input >= p.input && c.output >= p.output
          ? { input: c.input - p.input, output: c.output - p.output, cacheRead: Math.max(0, c.cacheRead - p.cacheRead), cacheWrite: Math.max(0, c.cacheWrite - p.cacheWrite), cost: Math.max(0, c.cost - p.cost) }
          : c;
        if (d.input + d.output + d.cacheRead + d.cacheWrite === 0) continue;
        ctx.recordUsage({ model, input: d.input, output: d.output, cacheRead: d.cacheRead, cacheWrite: d.cacheWrite, costUsd: d.cost, costSource: 'reported' });
        runCost = (runCost ?? 0) + d.cost;
        runTokens += d.input + d.output + d.cacheRead + d.cacheWrite;
      }
      ctx.setBaseline(m.session_id, cur);
    };
    for await (const m of q as AsyncIterable<any>) {
      if (m.session_id) ctx.setSessionId(m.session_id);

      if (m.type === 'system' && m.subtype === 'init') {
        ctx.emit('system', `Phiên ${m.session_id?.slice(0, 8)} · model ${m.model ?? '?'}`);
      } else if (m.type === 'assistant') {
        for (const b of m.message?.content ?? []) {
          if (b.type === 'text' && b.text?.trim()) ctx.emit('message', b.text);
          else if (b.type === 'tool_use') ctx.emit('tool', `${b.name} ${clip(b.input, 200)}`, { tool: b.name });
        }
      } else if (m.type === 'result') {
        try { recordUsage(m); } catch (e) { console.warn('[usage]', e); }
        const rc = runCost as number | null;
        const cost = rc != null ? ` · ${fmtTok(runTokens)} token · ~$${rc.toFixed(4)}` : "";
        if (m.subtype === 'success' && m.is_error && /authenticat|OAuth|401/i.test(m.result ?? '')) {
          throw new Error('Claude Code chưa đăng nhập hoặc phiên đăng nhập đã hết hạn. Chạy `npx @anthropic-ai/claude-code setup-token`, dán token vào .env (CLAUDE_CODE_OAUTH_TOKEN=…) rồi khởi động lại văn phòng.');
        }
        if (m.subtype === 'success') {
          finalText = m.result ?? '';
          ctx.emit('result', `Xong (${m.num_turns ?? '?'} lượt${cost})`, { cost: runCost });
        } else {
          const msg = [m.result, ...(m.errors ?? [])].filter(Boolean).join(' · ');
          if (/authenticat|OAuth|401|login/i.test(msg)) {
            throw new Error('Claude Code chưa đăng nhập hoặc phiên đăng nhập đã hết hạn. Chạy `npx @anthropic-ai/claude-code setup-token`, dán token vào .env (CLAUDE_CODE_OAUTH_TOKEN=…) rồi khởi động lại văn phòng.');
          }
          throw new Error(`Claude Code dừng: ${m.subtype}${msg ? ' · ' + msg : ''}`);
        }
      }
    }
    return finalText;
  },
};
