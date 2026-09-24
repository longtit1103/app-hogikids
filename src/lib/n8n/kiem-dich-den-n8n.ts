/**
 * MỘT nguồn luật cho câu hỏi "địa chỉ n8n này có được phép làm đích fetch không".
 *
 * Bối cảnh: lượt "Cài / cập nhật workflows" GỬI SECRET THẬT (mật khẩu DB chỉ-đọc `n8nDbRoPassword`
 * + khoá webhook `n8nIngestSecret`) tới địa chỉ chủ shop gõ ở `/cai-dat`. Trước bản vá này, kiểm
 * duy nhất là "protocol có phải http/https không".
 *
 * 🔴 VÌ SAO KHÔNG CẤM DẢI PRIVATE — đọc kỹ trước khi "sửa cho chặt":
 * n8n prod chạy ở `http://hogikids-n8n:5678`, tức TÊN CONTAINER trên mạng `supabase_default`, nên
 * DNS Docker trả IP bridge `172.x` — nằm gọn trong `172.16/12`. Đường "Đồng bộ ngay" cũng vậy
 * (`N8N_SYNC_WEBHOOK_URL=http://hogikids-n8n:5678/...`). Cấm private IP = giết chính cấu hình đang
 * chạy: nút "Cài / cập nhật workflows" và "Đồng bộ ngay" chết ngay lượt deploy, và triệu chứng lộ
 * ra muộn nhất đúng lúc đang cần khôi phục. Luật SSRF sách vở KHÔNG áp được ở đây.
 *
 * MÔ HÌNH ĐE DOẠ THẬT: app 1 người dùng, sau Cloudflare Access + Tailscale. Thứ cần chặn là
 * (1) GÕ NHẦM địa chỉ, và (2) đích CHUYỂN HƯỚNG về endpoint metadata của nhà cung cấp cloud.
 * Vì thế denylist ở đây cố ý HẸP, và phần chặn chuyển hướng nằm ở `redirect: "manual"` nơi gọi.
 *
 * CŨNG CỐ Ý KHÔNG phân giải DNS rồi mới kết luận: `fetch()` tự phân giải lại lúc gửi nên kiểm
 * trước chỉ là TOCTOU (DNS rebinding đi qua được); muốn chặt thật phải ghim IP qua custom lookup —
 * việc lớn hơn nhiều và không tương xứng với mô hình đe doạ trên. Thêm nữa, trong CI thì
 * `hogikids-n8n` không phân giải được, nên ca test "địa chỉ prod thật vẫn qua" sẽ luôn đỏ.
 */

/** Hostname bị cấm tuyệt đối — endpoint metadata của các nhà cung cấp cloud. */
// `new URL()` luôn trả IPv6 trong ngoặc vuông, nên `"[::]"` là dạng duy nhất gặp được — không khai
// `"::"` trần ở đây, nó sẽ là mục chết.
const HOST_CAM = new Set(["metadata.google.internal", "metadata.goog", "0.0.0.0", "[::]"]);

/** IPv4 link-local `169.254.0.0/16` — chứa `169.254.169.254` (metadata AWS/GCP/Azure/DO). */
const IPV4_LINK_LOCAL = /^169\.254\.\d{1,3}\.\d{1,3}$/;

/** IPv6 link-local `fe80::/10`, dạng hostname trong URL là `[fe80::1]`. */
const IPV6_LINK_LOCAL = /^\[?fe[89ab][0-9a-f]:/i;

/** IPv4 bọc trong IPv6 — `new URL()` chuẩn hoá `[::ffff:169.254.169.254]` thành `[::ffff:a9fe:a9fe]`. */
const IPV4_TRONG_IPV6 = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/i;

/**
 * Chuẩn hoá hostname về một dạng DUY NHẤT trước khi so denylist. Hai đường vòng đo được 22/09:
 *
 *  - **Dấu chấm cuối**: `http://metadata.google.internal./` → `new URL()` GIỮ NGUYÊN dấu chấm, nên so
 *    trực tiếp với danh sách là trượt. (DNS coi `a.b.` và `a.b` là một.)
 *  - **IPv4 bọc IPv6**: `http://[::ffff:169.254.169.254]/` → hostname thành `[::ffff:a9fe:a9fe]`,
 *    không khớp regex IPv4 nào. Phải giải ngược về dạng chấm rồi mới so.
 *
 * ✅ Dạng thập phân / hex / octal thì KHÔNG cần xử ở đây — đo thật: `http://2852039166/`,
 * `http://0xA9FEA9FE/`, `http://0251.0376.0251.0376/` đều được `new URL()` tự chuẩn hoá về
 * `169.254.169.254`. Đừng thêm code cho mấy dạng đó, nó đã được chặn rồi.
 */
function chuanHoaHost(host: string): string {
  const bo = host.toLowerCase().replace(/\.$/, "");
  const m = IPV4_TRONG_IPV6.exec(bo);
  if (!m) return bo;
  const cao = Number.parseInt(m[1], 16);
  const thap = Number.parseInt(m[2], 16);
  return `${cao >> 8}.${cao & 0xff}.${thap >> 8}.${thap & 0xff}`;
}

/**
 * `null` = cho phép. Chuỗi = lý do từ chối, hiện nguyên văn lên UI nên phải là tiếng Việt và
 * KHÔNG chứa giá trị khoá nào.
 */
export function lyDoTuChoiDichN8n(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return "không phải URL hợp lệ";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return "phải là URL http:// hoặc https://";
  }

  const host = chuanHoaHost(u.hostname);
  if (HOST_CAM.has(host)) {
    return `địa chỉ "${host}" là endpoint nội bộ của nhà cung cấp cloud — không phải n8n của shop`;
  }
  if (IPV4_LINK_LOCAL.test(host) || IPV6_LINK_LOCAL.test(host)) {
    return `địa chỉ "${host}" thuộc dải link-local (169.254.x.x / fe80::) — thường là endpoint metadata, không phải n8n của shop`;
  }
  return null;
}

/**
 * Chặn chuyển hướng cho mọi lượt fetch tới n8n. n8n Public API không bao giờ 3xx, nên một lượt
 * chuyển hướng hoặc là cấu hình sai, hoặc là đích đang lái secret đi nơi khác.
 *
 * Dùng kèm `redirect: "manual"` ở nơi gọi: undici trả về chính response 3xx thay vì đi theo, nên
 * ta nhận ra và báo bằng tiếng Việt thay vì để nó hiện thành "lỗi HTTP 302" khó hiểu.
 */
export function laChuyenHuong(status: number): boolean {
  return status >= 300 && status < 400;
}
