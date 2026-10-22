// Tiện ích dùng chung cho các adapter
import type { Agent, AdapterContext, OfficeApi } from '../types.ts';

/** Bối cảnh văn phòng chèn vào system prompt để agent biết mình là ai, làm với ai */
export function officeBrief(agent: Agent, office: OfficeApi, canUseTools: boolean): string {
  const staff = office.listStaff()
    .filter(s => s.id !== agent.id && s.provider !== 'observer')
    .map(s => `- ${s.id} | ${s.name} | ${s.role} | phòng ${s.department}`)
    .join('\n');
  const how = canUseTools
    ? 'Muốn giao việc cho đồng nghiệp: gọi tool `assign_task` (agent_id, task). Xem kết quả bằng `get_task`.'
    : 'Muốn giao việc cho đồng nghiệp: viết MỘT dòng riêng theo đúng mẫu `@giao <agent_id>: <mô tả việc>` trong câu trả lời. Văn phòng sẽ tự chuyển việc.';
  return [
    `Bạn là "${agent.name}", vai trò: ${agent.role || 'nhân viên'}, làm việc trong một văn phòng agency ảo.`,
    agent.systemPrompt ? `\nHướng dẫn riêng:\n${agent.systemPrompt}` : '',
    `\nĐồng nghiệp hiện có:\n${staff || '(chưa có)'}`,
    `\n${how} Chỉ giao việc khi thực sự cần; không giao lại cho người vừa giao việc cho bạn.`,
  ].join('\n');
}

const DELEGATE_RE = /^@giao\s+([\w-]+)\s*:\s*(.+)$/gim;

/** Với agent không có tool (Codex / chat API): đọc các dòng `@giao id: việc` trong câu trả lời */
export function applyTextDelegations(agent: Agent, text: string, ctx: AdapterContext) {
  for (const m of text.matchAll(DELEGATE_RE)) {
    try {
      const t = ctx.office.assignTask(m[1], m[2].trim(), agent.id, ctx.task.id);
      ctx.emit('task', `Giao việc ${t.id.slice(0, 8)} cho ${m[1]}`);
    } catch (e: any) {
      ctx.emit('error', `Không giao được việc cho ${m[1]}: ${e.message}`);
    }
  }
}

export const clip = (s: unknown, n = 400) => {
  const str = typeof s === 'string' ? s : JSON.stringify(s);
  return str && str.length > n ? str.slice(0, n) + '…' : (str ?? '');
};
