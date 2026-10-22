// Tệp đính kèm khi giao việc (ảnh dán, file kéo thả). Lưu ở data/uploads/<id>/<tên file>
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, extname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Attachment } from './types.ts';

export const UPLOAD_DIR = resolve('data/uploads');
export const MAX_UPLOAD = 25 * 1024 * 1024;
/** Giới hạn ảnh gửi thẳng cho model (Anthropic: 5MB/ảnh) */
export const MAX_INLINE_IMAGE = 5 * 1024 * 1024;
const MAX_INLINE_TEXT = 200 * 1024;

const EXT_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json',
  '.html': 'text/html', '.xml': 'application/xml', '.yaml': 'text/yaml', '.yml': 'text/yaml', '.srt': 'text/plain',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.zip': 'application/zip',
};
const TEXT_EXT = new Set(['.txt', '.md', '.csv', '.json', '.html', '.xml', '.yaml', '.yml', '.srt', '.ts', '.js', '.py', '.css', '.sql', '.log', '.tsv']);

const ID_RE = /^[0-9a-f-]{36}$/;
const safeName = (n: string) => basename(n).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+/, '').slice(-120) || 'tep';

export function saveUpload(rawName: string, mimeHint: string, buf: Buffer): Attachment {
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw new Error('Tệp rỗng');
  if (buf.length > MAX_UPLOAD) throw new Error(`Tệp quá lớn (tối đa ${MAX_UPLOAD / 1048576}MB)`);
  const name = safeName(rawName);
  const ext = extname(name).toLowerCase();
  const mime = (mimeHint && mimeHint !== 'application/octet-stream' ? mimeHint : EXT_MIME[ext]) || 'application/octet-stream';
  const id = randomUUID();
  const dir = join(UPLOAD_DIR, id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, buf);
  const att: Attachment = { id, name, mime, size: buf.length, path };
  writeFileSync(join(dir, '.meta.json'), JSON.stringify(att));
  return att;
}

export function getUpload(id: string): Attachment | undefined {
  if (!ID_RE.test(id)) return undefined;
  const meta = join(UPLOAD_DIR, id, '.meta.json');
  if (!existsSync(meta)) return undefined;
  try {
    const a = JSON.parse(readFileSync(meta, 'utf8')) as Attachment;
    return existsSync(a.path) ? a : undefined;
  } catch { return undefined; }
}

export const isImage = (a: Attachment) => /^image\/(png|jpeg|gif|webp)$/.test(a.mime);
export const isPdf = (a: Attachment) => a.mime === 'application/pdf';
export const isText = (a: Attachment) => a.mime.startsWith('text/') || a.mime === 'application/json' || TEXT_EXT.has(extname(a.name).toLowerCase());
export const inlineImage = (a: Attachment) => isImage(a) && a.size <= MAX_INLINE_IMAGE;
export const inlineText = (a: Attachment) => isText(a) && a.size <= MAX_INLINE_TEXT;

export const b64 = (a: Attachment) => readFileSync(a.path).toString('base64');
export const textOf = (a: Attachment) => readFileSync(a.path, 'utf8');

const kb = (n: number) => n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(n / 1024)) + 'KB';

/** Danh sách tệp kèm đường dẫn trên máy — cho agent có tool đọc file (Claude Code, Codex) */
export function attachmentNote(atts: Attachment[], opts: { canReadFiles: boolean; inlined?: (a: Attachment) => boolean }): string {
  if (!atts.length) return '';
  const lines = atts.map(a => {
    const shown = opts.inlined?.(a) ? ' — đã gửi kèm nội dung' : '';
    return opts.canReadFiles ? `- ${a.name} (${a.mime}, ${kb(a.size)})${shown} → ${a.path}` : `- ${a.name} (${a.mime}, ${kb(a.size)})${shown}`;
  });
  const tail = opts.canReadFiles
    ? 'Đọc tệp bằng đường dẫn trên khi cần. Muốn dùng tệp trong dự án thì sao chép vào thư mục làm việc, đừng sửa bản gốc.'
    : '';
  return `\n\n---\nTệp đính kèm (${atts.length}):\n${lines.join('\n')}${tail ? '\n' + tail : ''}`;
}
