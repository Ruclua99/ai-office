// Nhân viên "chỉ chat" — không đụng file, phù hợp cho viết content, dịch, tư vấn chiến lược.
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { AgentAdapter } from '../types.ts';
import { repo } from '../db.ts';
import { officeBrief, applyTextDelegations } from './common.ts';
import { estimate } from '../pricing.ts';
import { attachmentNote, inlineImage, inlineText, isPdf, b64, textOf } from '../attachments.ts';
import type { Attachment } from '../types.ts';

/** Chat API không đọc được file trên máy → gửi nội dung: ảnh, PDF, file chữ. Loại khác chỉ báo tên. */
const sendable = (a: Attachment) => inlineImage(a) || inlineText(a) || (isPdf(a) && a.size <= 30 * 1024 * 1024);
const textBlocks = (atts: Attachment[]) => atts.filter(inlineText).map(a => `\n\n--- Nội dung tệp ${a.name} ---\n${textOf(a)}\n--- Hết tệp ${a.name} ---`).join('');
const unsentNote = (atts: Attachment[]) => {
  const skipped = atts.filter(a => !sendable(a));
  return skipped.length ? `\n(Lưu ý: ${skipped.map(a => a.name).join(', ')} không gửi được cho loại nhân viên chat API — chỉ nhân viên Claude Code / Codex mới mở được loại tệp này.)` : '';
};

let anthropic: Anthropic | undefined;
let openai: OpenAI | undefined;

/** Anthropic Messages API — lịch sử hội thoại lưu trong SQLite */
export const anthropicChatAdapter: AgentAdapter = {
  async run(agent, prompt, ctx) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('Nhân viên loại "Claude chat (API)" cần ANTHROPIC_API_KEY trong .env. Không có API key thì đổi nhân viên này sang loại "Claude Code" (dùng gói Claude đã đăng nhập).');
    }
    anthropic ??= new Anthropic(); // đọc ANTHROPIC_API_KEY
    // 20 lượt gần nhất, mỗi tin tối đa 6k ký tự → chi phí mỗi lượt không phình theo thời gian
    const history = repo.chatHistory(agent.id).map(m => ({ ...m, content: m.content.length > 6000 ? m.content.slice(0, 6000) + '\n…(đã cắt bớt)' : m.content }));
    const atts = ctx.task.attachments ?? [];
    const userText = prompt + attachmentNote(atts, { canReadFiles: false, inlined: sendable }) + textBlocks(atts) + unsentNote(atts);
    const content: any = atts.length
      ? [
          ...atts.filter(inlineImage).map(a => ({ type: 'image', source: { type: 'base64', media_type: a.mime, data: b64(a) } })),
          ...atts.filter(a => isPdf(a) && sendable(a)).map(a => ({ type: 'document', title: a.name, source: { type: 'base64', media_type: 'application/pdf', data: b64(a) } })),
          { type: 'text', text: userText },
        ]
      : prompt;
    if (atts.some(a => !sendable(a))) ctx.emit('system', unsentNote(atts).trim());
    const res = await anthropic.messages.create({
      model: agent.model || process.env.DEFAULT_ANTHROPIC_MODEL || 'claude-sonnet-5-5',
      max_tokens: 8000,
      system: officeBrief(agent, ctx.office, false),
      messages: [...history, { role: 'user', content }],
    }, { signal: ctx.signal });

    const text = res.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
    const au: any = res.usage;
    ctx.recordUsage(estimate({ model: res.model, input: au.input_tokens ?? 0, output: au.output_tokens ?? 0, cacheRead: au.cache_read_input_tokens ?? 0, cacheWrite: au.cache_creation_input_tokens ?? 0 }));
    // Lịch sử chỉ lưu chữ (ảnh không gửi lại ở các lượt sau cho đỡ tốn token)
    repo.addChat(agent.id, 'user', atts.length ? `${prompt}\n[Đã đính kèm: ${atts.map(a => a.name).join(', ')}]` : prompt);
    repo.addChat(agent.id, 'assistant', text);
    ctx.emit('message', text);
    ctx.emit('result', `Xong · ${res.usage.input_tokens} in / ${res.usage.output_tokens} out tokens`, { usage: res.usage });
    applyTextDelegations(agent, text, ctx);
    return text;
  },
};

/** OpenAI Responses API — ngữ cảnh nối tiếp bằng previous_response_id (lưu vào sessionId) */
export const openaiChatAdapter: AgentAdapter = {
  async run(agent, prompt, ctx) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('Nhân viên loại "OpenAI chat (API)" cần OPENAI_API_KEY trong .env. Không có API key thì đổi sang loại "OpenAI Codex" (dùng tài khoản ChatGPT đã đăng nhập trong Codex).');
    }
    openai ??= new OpenAI(); // đọc OPENAI_API_KEY
    const atts = ctx.task.attachments ?? [];
    if (atts.some(a => !sendable(a))) ctx.emit('system', unsentNote(atts).trim());
    const input: any = atts.length
      ? [{
          role: 'user',
          content: [
            { type: 'input_text', text: prompt + attachmentNote(atts, { canReadFiles: false, inlined: sendable }) + textBlocks(atts) + unsentNote(atts) },
            ...atts.filter(inlineImage).map(a => ({ type: 'input_image', detail: 'auto', image_url: `data:${a.mime};base64,${b64(a)}` })),
            ...atts.filter(a => isPdf(a) && sendable(a)).map(a => ({ type: 'input_file', filename: a.name, file_data: `data:application/pdf;base64,${b64(a)}` })),
          ],
        }]
      : prompt;
    const res = await openai.responses.create({
      model: agent.model || process.env.DEFAULT_OPENAI_MODEL || 'gpt-5',
      instructions: officeBrief(agent, ctx.office, false),
      input,
      previous_response_id: agent.sessionId || undefined,
      store: true,
    }, { signal: ctx.signal });

    ctx.setSessionId(res.id);
    const ou: any = res.usage ?? {};
    const cached = ou.input_tokens_details?.cached_tokens ?? 0;
    ctx.recordUsage(estimate({ model: res.model, input: Math.max(0, (ou.input_tokens ?? 0) - cached), output: ou.output_tokens ?? 0, cacheRead: cached, cacheWrite: 0 }));
    const text = res.output_text ?? '';
    ctx.emit('message', text);
    ctx.emit('result', `Xong · ${res.usage?.input_tokens ?? 0} in / ${res.usage?.output_tokens ?? 0} out tokens`, { usage: res.usage });
    applyTextDelegations(agent, text, ctx);
    return text;
  },
};
