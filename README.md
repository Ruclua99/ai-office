# AI Office — văn phòng ảo 3D, mỗi nhân viên là một phiên AI

Chạy trên máy bạn. Tuyển nhân viên AI vào các phòng ban, giao việc, nhân viên tự giao việc cho nhau, xin duyệt quyền
trước khi sửa file hay chạy lệnh, và bạn xem tất cả trên một sàn văn phòng 3D: ai đang gõ phím, ai đang chờ duyệt,
ai đang ra quán cà phê vì rảnh.

Mỗi nhân viên là một phiên **Claude Code**, **OpenAI Codex**, hoặc một cuộc chat qua API Anthropic / OpenAI.
Phiên là phiên thật, mở lại được trong terminal bằng `claude --resume` hay `codex resume`.

![Toàn cảnh văn phòng](docs/overview.jpg)

| Khu cà phê — nhân viên rảnh ra đây uống nước | Khu game — chơi trên TV hoặc máy arcade |
|---|---|
| ![](docs/cafe.jpg) | ![](docs/game.jpg) |

| Giao việc kèm ảnh / tệp | Token & chi phí từng người |
|---|---|
| ![](docs/attachments.jpg) | ![](docs/cost.jpg) |

> **English:** a local 3D "virtual office" where every employee is an AI session (Claude Code, OpenAI Codex, or a chat API).
> Assign briefs, let agents delegate to each other, approve tool permissions, and watch it all on an isometric office floor.
> The UI is in Vietnamese; the code comments are Vietnamese too. Requires Node ≥ 22.13. `npm install && npm start`.

## Cài đặt

Yêu cầu **Node.js ≥ 22.13** (dùng `node:sqlite` có sẵn, không cần build native) và ít nhất một trong các thứ sau:

| Loại nhân viên | Cần gì | Làm được gì |
|---|---|---|
| `claude-code` | [Claude Code](https://docs.claude.com/en/docs/claude-code) đã đăng nhập (`claude` rồi `/login`), hoặc `ANTHROPIC_API_KEY` | Đọc/sửa file, chạy lệnh, xem ảnh, giao việc cho đồng nghiệp qua tool MCP `office` |
| `codex` | `npm i -g @openai/codex` + `codex login`, hoặc `CODEX_API_KEY` | Đọc/sửa file, chạy lệnh trong sandbox, xem ảnh |
| `anthropic-chat` | `ANTHROPIC_API_KEY` | Chỉ chat (viết content, dịch, tư vấn); đọc được ảnh, PDF, file chữ |
| `openai-chat` | `OPENAI_API_KEY` | Chỉ chat |
| `observer` | Không cần gì | Xem một phiên bạn đang gõ trong terminal |

```bash
git clone https://github.com/linhvvn/ai-office.git
cd ai-office
npm install
cp .env.example .env        # Windows: copy .env.example .env
npm start                   # hoặc: npm run dev (tự reload khi sửa code)
```

Mở **http://localhost:4800**. Windows có sẵn `Mo van phong ao.bat`: bấm đúp là cài, chạy và mở trình duyệt;
máy chủ bị tắt ngang sẽ tự mở lại sau 5 giây.

Lần chạy đầu tạo sẵn 7 phòng ban, 2 khu nghỉ và 6 nhân viên mẫu từ `office.config.json`. Muốn làm lại từ đầu thì xoá thư mục `data/`.

**Đăng nhập Claude Code bằng gói Pro/Max** (không cần API key): chạy `npx @anthropic-ai/claude-code setup-token`,
dán token vào `.env` dưới dạng `CLAUDE_CODE_OAUTH_TOKEN=…`. Dòng khởi động sẽ in ra văn phòng đang đăng nhập bằng gì.

### Nhân vật 3D (tuỳ chọn, 10 phút)

Repo không kèm nhân vật vì giấy phép Mixamo không cho phân phối lại. Không có nhân vật thì văn phòng vẫn chạy với
người dựng bằng code. Muốn có nhân vật thật với animation đi bộ, gõ phím, uống cà phê:

1. Vào [mixamo.com](https://www.mixamo.com) (tài khoản Adobe miễn phí). Mục **Characters**, chọn vài nhân vật
   (ví dụ Remy, Suzie, Louise, Josh, Martha, Joe, Lewis, Sophie). Download: **Format FBX Binary, Pose T-pose, With Skin**.
   Lưu vào `tools/mixamo/in/characters/`, tên file tuỳ ý (`suzie.fbx`).
2. Mục **Animations**, chọn **một** nhân vật rồi tải 8 animation, **Without Skin, 30 fps**, lưu vào `tools/mixamo/in/animations/`
   với đúng tên sau:

   | Tên file | Tìm trên Mixamo | Dùng khi |
   |---|---|---|
   | `typing.fbx` | Typing | đang làm việc |
   | `idle.fbx` | Sitting Idle | ngồi rảnh |
   | `look.fbx` | Sitting Looking Side To Side | nhìn quanh |
   | `impatient.fbx` | Sitting And Impatiently Waiting | chờ việc |
   | `thumbsup.fbx` | Sitting Thumbs Up | vừa xong việc |
   | `disbelief.fbx` | Sitting Disbelief | gặp lỗi |
   | `talking.fbx` | Sitting Talking | nói chuyện ở lounge / quán cà phê |
   | `beckon.fbx` | Waving Someone Over While Seated | xin duyệt quyền |

3. `npm run nhanvat`. Công cụ chuyển FBX → GLB nén, lấy thêm animation đi bộ / chạy từ nhân vật mẫu X Bot
   của three.js, và ghi `public/models/people/people.json`. Thiếu animation nào thì tạm thay bằng `idle`.

## Cách dùng

- **Giao brief**: gửi việc cho Trưởng điều phối. Người này dùng tool `assign_task` chia việc cho các phòng; kết quả tự báo ngược về người giao.
- **Bấm vào nhân viên** để mở panel: nhật ký, giao việc (Ctrl+Enter), Dừng, Phiên mới, Sửa, Xoá.
- **Đính kèm**: dán ảnh (Ctrl+V), kéo thả tệp, hoặc nút kẹp giấy. Tối đa 10 tệp × 25 MB. Claude Code và Codex nhìn được ảnh và tự mở tệp theo đường dẫn; chat API đọc được ảnh, PDF và file chữ.
- **Xin duyệt**: nhân viên giơ tay, hiện dấu `!`, màn hình viền cam → bấm *Cho phép* hoặc *Từ chối* trong panel. Quá 30 phút không ai duyệt thì tự từ chối để nhân viên làm tiếp phần khác (`PERMISSION_TIMEOUT_MIN`).
- **Chi phí**: nút *Chi phí* trên thanh công cụ: token và tiền theo ngày / tuần / tháng, từng nhân viên, từng model. Claude Code tự báo chi phí; Codex và chat API cần điền giá vào `pricing.json` (USD / 1 triệu token, thêm `usdToVnd` để hiện VNĐ).
- **Gắn phiên có sẵn** quét `~/.claude/projects` và `~/.codex/sessions`:
  - *Quan sát*: chỉ đọc transcript, an toàn.
  - *Tiếp quản*: văn phòng resume phiên đó và giao việc tiếp. Đóng phiên trong terminal trước để hai bên không cùng ghi vào một phiên.
- **Giờ nghỉ**: nhân viên rảnh một lúc sẽ đứng dậy đi ra quán cà phê hoặc khu game, có việc thì chạy về bàn. Thử nhanh: `http://localhost:4800/?nghi=nhanh`.
- **Máy chủ tắt ngang** (mất điện, khởi động lại): việc đang chờ chạy tiếp, việc đang dở được gửi lại phiên cũ với lời nhắn "làm tiếp từ chỗ đang dở". Nhật ký máy chủ ở `data/server.log`, sao lưu DB hằng ngày ở `data/backup/`.

### Chế độ quyền (Claude Code & Codex)

| Chế độ | Claude Code | Codex |
|---|---|---|
| Hỏi trước (`default`) | Đọc tự do; sửa file / chạy lệnh / web phải được duyệt | sandbox `workspace-write` |
| Tự sửa file (`acceptEdits`) | Sửa file tự do, chạy lệnh phải duyệt | sandbox `workspace-write` |
| Chỉ đọc (`plan`) | Chặn mọi thao tác ghi / chạy lệnh | sandbox `read-only` |
| ⚠ Toàn quyền (`bypassPermissions`) | Không hỏi gì | `danger-full-access` |

Với Claude Code, việc duyệt quyền chạy qua hook `PreToolUse`, nên văn phòng vẫn kiểm soát được kể cả khi `~/.claude/settings.json` có rule `allow`.
Codex chạy headless (`approvalPolicy: never`), chỉ được giới hạn bằng sandbox và không có bước xin duyệt.

### Cấu hình (`.env`)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT`, `HOST` | `4800`, `127.0.0.1` | Chỉ nghe trên máy bạn. Đừng mở ra mạng ngoài: ai vào được giao diện là điều khiển được AI chạy lệnh trên máy bạn. |
| `OFFICE_TOKEN` | tự sinh | Token chống trang web lạ gọi API localhost |
| `MAX_CONCURRENT` | `6` | Số nhân viên làm cùng lúc (người đang chờ duyệt không tính) |
| `PERMISSION_TIMEOUT_MIN` | `30` | Xin quyền quá lâu → tự từ chối (`0` = chờ mãi) |
| `MAX_DELEGATION_DEPTH` | `3` | Giao việc lồng nhau tối đa mấy cấp (chặn vòng lặp) |
| `MAX_QUEUE_PER_AGENT` | `10` | Mỗi nhân viên chờ tối đa bao nhiêu việc |
| `KEEP_EVENTS_PER_AGENT` | `2000` | Nhật ký mỗi người giữ bao nhiêu dòng gần nhất |

## Cấu trúc

```
src/
  server.ts            HTTP + WebSocket, token chống CSRF, chặn Host lạ, upload tệp
  office.ts            Lõi: hàng đợi, giới hạn song song, xin quyền, giao việc lồng nhau, chạy tiếp việc dở
  db.ts                SQLite (data/office.db): phòng ban, nhân viên, task, sự kiện, token, sao lưu
  attachments.ts       Tệp đính kèm (data/uploads)
  pricing.ts           Ước tính chi phí theo pricing.json
  observer.ts          Đọc transcript JSONL của Claude Code / Codex
  log.ts               Ghi data/server.log, giữ máy chủ sống khi một nhân viên gây lỗi
  adapters/
    claudeCode.ts      Claude Agent SDK + MCP server "office" (list_staff, assign_task, get_task)
    codex.ts           @openai/codex-sdk
    chat.ts            Anthropic Messages API, OpenAI Responses API
    common.ts          Bối cảnh văn phòng, giao việc bằng dòng "@giao <id>: …"
public/
  index.html           Khung giao diện, CSS (Three.js + font phục vụ local, chạy được khi offline)
  js/main.js           Dữ liệu, WebSocket, HUD, panel, modal, đính kèm, bảng chi phí
  js/scene/
    office3d.js        Cảnh 3D: toà nhà, phòng ban, khu nghỉ, đèn, hậu kỳ, giờ nghỉ của nhân viên
    furniture.js       Nội thất dựng bằng code
    leisure.js         Quầy cà phê, TV, máy arcade, bàn bi lắc, màn hình game
    mixamo.js          Nhân vật Mixamo: ngồi đúng ghế, đi / chạy theo đường, cầm ly, cầm tay cầm
    nav.js             Lưới tìm đường A* để nhân viên đi vòng qua bàn ghế
    people.js          Nhân vật dựng bằng code (khi chưa có Mixamo)
    textures.js        Gạch sàn, skyline đêm, chữ trên sàn, nội dung màn hình
    materials.js       Bảng màu & vật liệu
    util.js            Seed ngẫu nhiên, gộp mesh tĩnh để giảm draw call
tools/mixamo/          Chuyển FBX Mixamo → GLB (npm run nhanvat)
office.config.json     Phòng ban & nhân viên mẫu (chỉ dùng lần chạy đầu)
pricing.json           Bảng giá để ước tính chi phí
```

**Thêm một loại AI mới** (Gemini, Ollama, LM Studio…): viết một file trong `src/adapters/` triển khai `AgentAdapter.run()`,
thêm vào `ADAPTERS` và `PROVIDERS` trong `office.ts`. Nhân viên không có tool sẽ giao việc bằng dòng `@giao <agent_id>: <việc>`.

## Tuỳ biến 3D

**Phòng ban**: nút **Phòng ban** trên giao diện để đổi tên, màu thảm, vị trí, kích thước, kiểu khu vực, nội dung màn hình.
Sàn rộng x −18…18, z −14…14 (mét); x/z là tâm khu vực.

| `style.shape` | Hiển thị |
|---|---|
| `zone` | Thảm bo tròn + cụm bàn bench 6–8 chỗ (tự thêm cụm khi đông người) |
| `lounge` | Thảm tròn, sofa cong, ghế bành, bàn cà phê; nhân viên ngồi gõ laptop |
| `room` | Phòng họp vách kính sát tường bên, bàn tròn 4 chỗ |
| `cafe` | Quầy bar, ghế cao, bàn tròn — khu nghỉ, không xếp nhân viên vào |
| `game` | TV + sofa, 2 máy arcade, bàn bi lắc — khu nghỉ |

`style.screenTheme`: `code`, `design`, `charts`, `media`, `video`, `docs`.

**Chất lượng hình** (nút trên thanh công cụ): Cao = ambient occlusion + bloom + bóng 2048; Vừa = bloom + bóng 1024;
Thấp = không hậu kỳ. Máy dưới 30 FPS tự hạ một bậc. Tham số URL `?q=high|medium|low&auto=0`. Trong console, `__office.stats()`.

**Thay đồ dựng bằng code bằng model thật**: tạo `public/models/manifest.json`, chép `.glb` vào `public/models/`.
Model đặt gốc ở sàn, mặt trước hướng +z. Key không có trong manifest tự quay về bản dựng bằng code.

```json
{
  "plant_big":    [{ "file": "monstera.glb" }, { "file": "fiddle_fig.glb", "scale": 1.1 }],
  "chair_office": { "file": "chair.glb", "scale": 0.01, "rotationY": 3.1416 },
  "armchair":     { "file": "armchair.glb" },
  "coffee_table": { "file": "coffee_table.glb" },
  "bookshelf":    { "file": "bookshelf.glb" },
  "floor_lamp":   { "file": "floor_lamp.glb" }
}
```

## API (header `x-office-token`)

| Method | Đường dẫn | Việc |
|---|---|---|
| GET | `/api/state` | Toàn bộ trạng thái văn phòng |
| POST | `/api/agents` | Tuyển nhân viên |
| PATCH / DELETE | `/api/agents/:id` | Sửa / xoá |
| POST | `/api/agents/:id/tasks` `{prompt, attachments?}` | Giao việc (`attachments`: id từ `/api/uploads`) |
| POST | `/api/uploads` (thân = dữ liệu tệp, header `x-filename`) | Tải tệp đính kèm |
| POST | `/api/agents/:id/stop` | Dừng việc đang chạy + huỷ việc chờ |
| POST | `/api/agents/:id/reset` | Bắt đầu phiên mới |
| GET | `/api/agents/:id/events` | Nhật ký |
| POST | `/api/permissions/:id` `{allow}` | Duyệt / từ chối |
| GET | `/api/usage?range=today\|7d\|30d\|all` | Token & chi phí |
| POST | `/api/departments` | Thêm / sửa phòng ban |
| GET | `/api/discover` | Liệt kê phiên Claude Code / Codex trên máy |
| WS | `/ws?token=…` | Sự kiện real-time |

## Lưu ý

- **Chi phí**: mỗi việc là một lượt gọi model, và nhân viên tự giao việc cho nhau nên một brief có thể thành nhiều lượt.
  Giữ `MAX_CONCURRENT` và `MAX_DELEGATION_DEPTH` thấp, cho nhân viên phụ dùng model rẻ hơn, và xem nút *Chi phí* thường xuyên.
- **Gói subscription**: nếu dùng đăng nhập Claude Pro/Max hoặc ChatGPT để chạy tự động nhiều phiên, hãy tự kiểm tra điều khoản
  sử dụng của Anthropic và OpenAI. Chi phí hiện ra với gói subscription là giá trị tương đương API, không phải tiền bị trừ.
- **Định dạng transcript JSONL** là nội bộ của từng CLI và có thể đổi khi nâng cấp. Mọi chỗ parse nằm ở `parseLine()` trong `observer.ts`.
- Nhân vật Mixamo: xem `public/models/CREDITS.md`.

## Giấy phép

MIT — xem `LICENSE`. Nhân vật Mixamo và model bên thứ ba không thuộc giấy phép này.
