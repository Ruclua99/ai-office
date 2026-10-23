#!/usr/bin/env node
import { parseArgs } from 'node:util';

const BASE_URL = process.env.OFFICE_URL || 'http://127.0.0.1:4800';
const TOKEN = process.env.OFFICE_TOKEN || 'a1b2c3d4e5f6-office-token';

async function api(path, opts = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'x-office-token': TOKEN,
      ...(opts.headers || {})
    }
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Office API ${res.status}: ${err}`);
  }
  return res.json();
}

async function listStaff() {
  const state = await api('/api/state');
  console.log('🏢 DANH SÁCH NHÂN SỰ VĂN PHÒNG ẢO 3D:');
  const depts = new Map(state.departments.map(d => [d.id, d.name]));
  for (const a of state.agents) {
    const st = a.status || 'idle';
    const stIcon = st === 'working' ? '⚡ Đang làm việc' : (st === 'waiting' ? '⏳ Chờ duyệt' : '☕ Đang nghỉ');
    console.log(`- [${a.id}] ${a.name} (${depts.get(a.departmentId) || a.departmentId}) | Model: ${a.model || a.provider} | ${stIcon}`);
    if (a.role) console.log(`  Vai trò: ${a.role}`);
  }
}

async function assignTask(agentId, prompt, wait = true) {
  const res = await api(`/api/agents/${agentId}/tasks`, {
    method: 'POST',
    body: JSON.stringify({ prompt })
  });
  console.log(`✅ Đã giao việc cho [${agentId}] (Task ID: ${res.id})`);
  console.log(`Nhiệm vụ: "${prompt}"`);

  if (!wait) return;

  console.log('⏳ Đang chờ nhân viên xử lý trên văn phòng 3D...');
  const start = Date.now();
  let lastEventId = 0;
  let finished = false;

  while (Date.now() - start < 120000) {
    await new Promise(r => setTimeout(r, 1200));
    const events = await api(`/api/agents/${agentId}/events?limit=8`);
    for (const ev of events) {
      if (ev.id && ev.id > lastEventId) {
        lastEventId = ev.id;
        if (ev.kind === 'message') {
          console.log(`\n💬 [${agentId}]:\n${ev.text}`);
        } else if (ev.kind === 'task') {
          console.log(`\n🔄 [Giao việc chéo]: ${ev.text}`);
        } else if (ev.kind === 'result') {
          console.log(`\n🎉 [Hoàn thành]: ${ev.text}`);
          finished = true;
          break;
        } else if (ev.kind === 'error') {
          console.error(`\n❌ [Lỗi]: ${ev.text}`);
          finished = true;
          break;
        }
      }
    }
    if (finished) break;
  }
}

const args = process.argv.slice(2);
const cmd = args[0] || 'list';

try {
  if (cmd === 'list') {
    await listStaff();
  } else if (cmd === 'giao' || cmd === 'assign') {
    const agentId = args[1];
    const prompt = args.slice(2).join(' ');
    if (!agentId || !prompt) {
      console.error('Cách dùng: node office-tool.mjs giao <agent_id> <nội dung nhiệm vụ>');
      process.exit(1);
    }
    await assignTask(agentId, prompt, true);
  } else if (cmd === 'brief') {
    const prompt = args.slice(1).join(' ');
    if (!prompt) {
      console.error('Cách dùng: node office-tool.mjs brief <nhiệm vụ lớn cho Trưởng điều phối>');
      process.exit(1);
    }
    await assignTask('dieu-phoi', prompt, true);
  } else {
    console.log('Lệnh hỗ trợ: list | giao <agent_id> <prompt> | brief <prompt>');
  }
} catch (e) {
  console.error('Error:', e.message);
  process.exit(1);
}
