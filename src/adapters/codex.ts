// Nhân viên = 1 thread OpenAI Codex CLI, điều khiển qua @openai/codex-sdk.
// Cần đã cài `npm i -g @openai/codex` và `codex login` (hoặc đặt CODEX_API_KEY).
// Thread lưu ở ~/.codex/sessions, mở lại bằng `codex resume <threadId>`.
import { Codex, type ThreadOptions, type Input } from '@openai/codex-sdk';
import type { AgentAdapter } from '../types.ts';
import { officeBrief, applyTextDelegations, clip } from './common.ts';
import { estimate } from '../pricing.ts';
import { attachmentNote, isImage } from '../attachments.ts';

let codex: Codex | undefined;

/** Map quyền kiểu Claude sang sandbox của Codex */
function sandboxFor(mode?: string | null): ThreadOptions['sandboxMode'] {
  if (mode === 'plan') return 'read-only';
  if (mode === 'bypassPermissions') return 'danger-full-access';
  return 'workspace-write';
}

export const codexAdapter: AgentAdapter = {
  async run(agent, prompt, ctx) {
    codex ??= new Codex();
    const opts: ThreadOptions = {
      workingDirectory: agent.cwd || process.cwd(),
      skipGitRepoCheck: true,
      model: agent.model || undefined,
      sandboxMode: sandboxFor(agent.permissionMode),
      approvalPolicy: 'never', // chạy headless: không có ai bấm duyệt trong terminal
    };
    const isNew = !agent.sessionId;
    const thread = isNew ? codex.startThread(opts) : codex.resumeThread(agent.sessionId!, opts);

    // Codex SDK chưa có system prompt riêng → gửi bối cảnh văn phòng ở lượt đầu
    const atts = ctx.task.attachments ?? [];
    const text = (isNew ? `${officeBrief(agent, ctx.office, false)}\n\n---\nViệc cần làm:\n${prompt}` : prompt)
      + attachmentNote(atts, { canReadFiles: true, inlined: isImage });
    // Ảnh gửi dạng local_image để Codex nhìn được; tệp khác Codex tự đọc theo đường dẫn
    const input: Input = atts.length
      ? [{ type: 'text', text }, ...atts.filter(isImage).map(a => ({ type: 'local_image' as const, path: a.path }))]
      : text;
    const { events } = await thread.runStreamed(input, { signal: ctx.signal });

    let finalText = '';
    for await (const e of events) {
      switch (e.type) {
        case 'thread.started':
          ctx.setSessionId(e.thread_id);
          ctx.emit('system', `Thread ${e.thread_id.slice(0, 8)}`);
          break;
        case 'item.completed': {
          const it: any = e.item;
          if (it.type === 'agent_message') { finalText = it.text; ctx.emit('message', it.text); }
          else if (it.type === 'command_execution') ctx.emit('tool', `$ ${clip(it.command, 200)} → exit ${it.exit_code ?? '?'}`, { tool: 'shell' });
          else if (it.type === 'file_change') ctx.emit('tool', `Sửa file: ${it.changes?.map((c: any) => c.path).join(', ')}`, { tool: 'edit' });
          else if (it.type === 'mcp_tool_call') ctx.emit('tool', `${it.server}.${it.tool}`, { tool: it.tool });
          else if (it.type === 'web_search') ctx.emit('tool', `Tìm web: ${it.query}`, { tool: 'web_search' });
          else if (it.type === 'error') ctx.emit('error', it.message);
          break;
        }
        case 'turn.completed':
          if (e.usage) {
            const u: any = e.usage;
            ctx.recordUsage(estimate({
              model: agent.model || 'codex-mac-dinh',
              input: Math.max(0, (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0)),
              output: u.output_tokens ?? 0,
              cacheRead: u.cached_input_tokens ?? 0,
              cacheWrite: u.cache_write_input_tokens ?? 0,
            }));
          }
          ctx.emit('result', `Xong · ${e.usage?.input_tokens ?? 0} in / ${e.usage?.output_tokens ?? 0} out tokens`, { usage: e.usage });
          break;
        case 'turn.failed':
          throw new Error(e.error?.message ?? 'Codex turn failed');
        case 'error':
          throw new Error(e.message);
      }
    }
    if (thread.id) ctx.setSessionId(thread.id);
    applyTextDelegations(agent, finalText, ctx);
    return finalText;
  },
};
