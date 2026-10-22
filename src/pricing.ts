// Bảng giá để ƯỚC TÍNH chi phí cho các loại AI không tự báo tiền (Codex, chat API).
// Claude Code tự báo chi phí nên không cần bảng giá này.
// Giá điền trong pricing.json, đơn vị USD / 1 triệu token. Đọc lại mỗi lần tính → sửa file không cần khởi động lại.
import { readFileSync, existsSync, statSync } from 'node:fs';
import type { UsageRecord } from './types.ts';

interface Price { input?: number | null; output?: number | null; cacheRead?: number | null; cacheWrite?: number | null }
interface PricingFile { usdToVnd?: number | null; models?: Record<string, Price> }

const FILE = 'pricing.json';
let cache: { mtime: number; data: PricingFile } | undefined;

export function pricing(): PricingFile {
  try {
    if (!existsSync(FILE)) return {};
    const mtime = statSync(FILE).mtimeMs;
    if (!cache || cache.mtime !== mtime) cache = { mtime, data: JSON.parse(readFileSync(FILE, 'utf8')) };
    return cache.data;
  } catch (e) {
    console.warn('[pricing] pricing.json lỗi cú pháp, bỏ qua:', (e as Error).message);
    return {};
  }
}

/** Tìm giá theo tên model: khớp chính xác, rồi tới khớp tiền tố dài nhất (vd "claude-sonnet" khớp "claude-sonnet-5-5") */
function priceFor(model: string): Price | undefined {
  const models = pricing().models ?? {};
  if (models[model]) return models[model];
  const key = Object.keys(models).filter(k => model.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  return key ? models[key] : undefined;
}

/** Gắn chi phí ước tính cho một bản ghi chưa có tiền */
export function estimate(u: Omit<UsageRecord, 'costUsd' | 'costSource'>): UsageRecord {
  const p = priceFor(u.model);
  if (!p || p.input == null || p.output == null) return { ...u, costUsd: null, costSource: 'none' };
  const cost = (u.input * p.input + u.output * p.output
    + u.cacheRead * (p.cacheRead ?? p.input) + u.cacheWrite * (p.cacheWrite ?? p.input)) / 1e6;
  return { ...u, costUsd: cost, costSource: 'estimated' };
}
