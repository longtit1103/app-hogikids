import { describe, expect, it } from "vitest";

import { laChuyenHuong, lyDoTuChoiDichN8n } from "@/lib/n8n/kiem-dich-den-n8n";

/**
 * Luật "địa chỉ n8n này có được làm đích fetch không".
 *
 * 🔴 Khối CHO PHÉP ở dưới quan trọng hơn khối TỪ CHỐI, và là lý do file test này tồn tại.
 * Bản plan đầu của đợt này kê luật SSRF sách vở ("cấm loopback + 10/8 + 172.16/12 + 192.168/16"),
 * review đối kháng xếp CHẶN SHIP: n8n prod chạy ở `http://hogikids-n8n:5678` — TÊN CONTAINER, nên
 * DNS Docker trả IP bridge `172.x`. Luật đó sẽ giết nút "Cài / cập nhật workflows" và "Đồng bộ ngay"
 * ngay lượt deploy, và triệu chứng lộ ra muộn nhất đúng lúc đang cần khôi phục.
 *
 * Mấy ca CHO PHÉP dưới đây neo quyết định ấy lại. Ai đó "sửa cho chặt" ở lượt sau sẽ thấy đỏ tại
 * đây kèm lý do, thay vì thấy prod chết.
 */

describe("kiểm đích n8n — CHO PHÉP (chống vá quá tay)", () => {
  it.each([
    ["tên container — CHÍNH LÀ cấu hình prod", "http://hogikids-n8n:5678"],
    ["URL sync-now đầy đủ path", "http://hogikids-n8n:5678/webhook/hogikids-sync-now"],
    ["loopback", "http://127.0.0.1:5678"],
    ["localhost", "http://localhost:5678"],
    ["dải 172.16/12 (bridge Docker)", "http://172.18.0.5:5678"],
    ["dải 10/8", "http://10.0.0.7:5678"],
    ["dải 192.168/16", "http://192.168.1.50:5678"],
    ["Tailscale 100.x", "http://100.120.195.87:5678"],
    ["tên miền công khai https", "https://n8n.example.com"],
    // Chuẩn hoá dấu chấm cuối KHÔNG được biến thành cái cớ chặn tên miền hợp lệ.
    ["tên miền có dấu chấm cuối", "https://n8n.example.com./"],
    // IPv4 bọc IPv6 của một địa chỉ HỢP LỆ vẫn phải qua — phép giải ngược không được chặn bừa.
    ["IPv4 bọc IPv6, địa chỉ private hợp lệ", "http://[::ffff:172.18.0.5]:5678"],
    // Hostname bắt đầu bằng "fe8…" nhưng là TÊN MIỀN, không phải IPv6 link-local.
    ["tên miền bắt đầu bằng fe8", "https://fe80shop.example.com"],
  ])("cho phép %s", (_ten, url) => {
    expect(lyDoTuChoiDichN8n(url)).toBeNull();
  });
});

describe("kiểm đích n8n — TỪ CHỐI", () => {
  it.each([
    ["endpoint metadata cloud (IPv4 link-local)", "http://169.254.169.254/latest/meta-data/"],
    ["bất kỳ địa chỉ link-local nào khác", "http://169.254.1.1:5678"],
    ["metadata GCP theo tên", "http://metadata.google.internal/computeMetadata/v1/"],
    ["0.0.0.0", "http://0.0.0.0:5678"],
    ["IPv6 link-local", "http://[fe80::1]:5678"],
    // Ba dạng dưới đây `new URL()` TỰ chuẩn hoá về 169.254.169.254 — giữ ca test để chốt lại điều
    // đó, kẻo ai đó thấy "thiếu xử lý dạng thập phân" rồi thêm code thừa.
    ["IP dạng thập phân", "http://2852039166/"],
    ["IP dạng hex", "http://0xA9FEA9FE/"],
    ["IP dạng octal", "http://0251.0376.0251.0376/"],
    // Hai dạng dưới là ĐƯỜNG VÒNG THẬT, tự tìm ra khi soi lại bản thi công 22/09 — bản đầu LỌT.
    ["IPv4 bọc trong IPv6", "http://[::ffff:169.254.169.254]/"],
    ["metadata có dấu chấm cuối", "http://metadata.google.internal./"],
  ])("từ chối %s", (_ten, url) => {
    expect(lyDoTuChoiDichN8n(url)).not.toBeNull();
  });

  it("từ chối scheme không phải http/https", () => {
    expect(lyDoTuChoiDichN8n("file:///etc/passwd")).toContain("http://");
    expect(lyDoTuChoiDichN8n("ftp://host/x")).toContain("http://");
  });

  it("từ chối chuỗi không phải URL", () => {
    expect(lyDoTuChoiDichN8n("khong-phai-url")).toBe("không phải URL hợp lệ");
    expect(lyDoTuChoiDichN8n("")).toBe("không phải URL hợp lệ");
  });

  it("lý do từ chối là tiếng Việt, KHÔNG chứa giá trị khoá", () => {
    const lyDo = lyDoTuChoiDichN8n("http://169.254.169.254") ?? "";
    // Message hiện nguyên văn lên UI qua ActionResult — bất biến của cả nhánh n8n.
    expect(lyDo).toContain("link-local");
    expect(lyDo).not.toMatch(/api[_-]?key|secret|password/i);
  });
});

describe("chặn chuyển hướng", () => {
  it.each([301, 302, 303, 307, 308])("nhận diện %i là chuyển hướng", (mã) => {
    expect(laChuyenHuong(mã)).toBe(true);
  });

  it.each([200, 401, 404, 500])("KHÔNG nhận nhầm %i", (mã) => {
    expect(laChuyenHuong(mã)).toBe(false);
  });
});
