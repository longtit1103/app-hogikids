# Gói phụ thuộc lưu thẳng trong repo

Thư mục này giữ tarball của gói **không cài được từ registry npm công khai**. Mục đích DUY NHẤT: `npm ci`
(bao gồm lượt dựng lại trong `Dockerfile` và đường phục hồi thảm hoạ) **không phụ thuộc một domain nào ngoài
`registry.npmjs.org`**.

## `xlsx-0.20.3.tgz` — SheetJS

| | |
|---|---|
| **Nguồn tải** | `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` |
| **Ngày tải** | 2026-08-18 |
| **Kích thước** | 2.409.319 byte |
| **sha512 (khuôn npm `integrity`)** | `sha512-oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA==` |
| **sha256** | `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8` |

**Vì sao không lấy từ npm:** registry công khai chỉ có `xlsx@0.18.5`, bản đó **còn lỗ hổng**
(CVE-2023-30533 prototype pollution · CVE-2024-22363 ReDoS). SheetJS chuyển sang phát hành qua CDN riêng từ
`0.20.x`. ⚠️ **TUYỆT ĐỐI không "sửa" phụ thuộc này bằng cách lùi về `0.18.5`** — đó là lùi về bản có lỗ.

**Vì sao lưu thẳng vào repo thay vì trỏ CDN:** `package.json` trước đây khai thẳng URL tarball CDN, nên mỗi
lượt build **bắt buộc** vào được `cdn.sheetjs.com` — domain ngoài tầm kiểm soát. CDN sập / đổi địa chỉ / bị
chặn đúng lúc cần dựng lại (sự cố, khôi phục thảm hoạ) là **build gãy, không có đường chạy offline**. Chủ shop
chốt phương án này 18/08 sau khi cân 4 lựa chọn (xem `plans/260815-1101-hang-doi-viec-con-treo/` mục C3).

**Bằng chứng file này giống hệt bản đang chạy prod:** sha512 ở trên **khớp tuyệt đối** với trường `integrity`
mà `package-lock.json` đã ghi từ trước khi đổi. Sau khi đổi sang `file:`, npm giữ **nguyên** giá trị
`integrity` đó — tức gói cài ra giống hệt tới từng bit, không phải bản đóng gói lại.

## Khi cần nâng bản

1. Tải tarball bản mới từ `https://cdn.sheetjs.com/xlsx-<bản>/xlsx-<bản>.tgz`.
2. **Đối chiếu checksum trước khi tin** — ghi lại sha512 + sha256 vào bảng trên:
   ```bash
   python3 -c "import hashlib,base64,sys; b=open(sys.argv[1],'rb').read(); \
     print('sha512-'+base64.b64encode(hashlib.sha512(b).digest()).decode()); \
     print(hashlib.sha256(b).hexdigest())" third-party/xlsx-<bản>.tgz
   ```
3. Đổi đường dẫn trong `package.json`, chạy `npm install`, **xoá file tarball cũ**.
4. Kiểm: `package-lock.json` không còn dòng nào chứa `cdn.sheetjs.com`; `npm ci` chạy sạch; ba bộ test
   `shopee-wallet-xlsx` · `pnl-export-excel-rows` · `cost-excel` xanh; `npm run build` qua.
