# Nguồn model 3D

## Nhân vật & animation — Mixamo (Adobe)

Repo **không chứa** file nhân vật. Mỗi người tự tải từ https://www.mixamo.com bằng tài khoản Adobe của mình
rồi chạy `npm run nhanvat` (xem README). Theo FAQ của Adobe, nhân vật và animation Mixamo dùng được trong dự án
cá nhân và thương mại không mất phí bản quyền, nhưng **không được phân phối lại file gốc** như một bộ asset.
Vì vậy đừng commit thư mục `public/models/people/` lên repo công khai.

Bộ animation gợi ý (tên trên Mixamo): Typing · Sitting Idle · Sitting Looking Side To Side · Sitting And Impatiently Waiting ·
Sitting Thumbs Up · Sitting Disbelief · Sitting Talking · Waving Someone Over While Seated.

`walk` / `run` được công cụ lấy tự động từ nhân vật mẫu **X Bot** trong bộ ví dụ three.js
(`examples/models/gltf/Xbot.glb`) và chuyển hệ xương sang nhân vật của bạn.

## Nội thất

Toàn bộ bàn ghế, máy tính, cây, sofa, đèn, quầy cà phê, TV, máy arcade, bàn bi lắc… dựng bằng code trong
`public/js/scene/furniture.js` và `public/js/scene/leisure.js` — không có giấy phép bên thứ ba.
Hình game trên TV / arcade vẽ bằng canvas.

## Thay bằng model thật (tuỳ chọn)

Chép `.glb` vào `public/models/` và khai báo trong `public/models/manifest.json` (xem README). Nhớ ghi nguồn và giấy phép vào đây.
