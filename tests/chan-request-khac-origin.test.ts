import { describe, expect, it } from "vitest";

import { chanRequestKhacOrigin } from "@/lib/chan-request-khac-origin";

/**
 * Dựng `Request`: đo thử trực tiếp trên Node 24 (undici) cho thấy `new Request(url, { headers })`
 * CHO đặt `Host` bình thường (không giống `fetch()` trình duyệt, nơi `Host` là forbidden header
 * name) — không cần cách dựng vòng qua. Dùng thẳng `new Request(...)` cho mọi ca dưới đây.
 */
function tao(headers: Record<string, string>): Request {
  return new Request("https://app.example.com/api/backup", {
    method: "POST",
    headers,
  });
}

describe("chanRequestKhacOrigin", () => {
  it("cho qua khi Origin cùng Host (request hợp lệ từ chính app)", () => {
    const req = tao({ Origin: "https://app.example.com", Host: "app.example.com" });
    expect(chanRequestKhacOrigin(req)).toBeNull();
  });

  it("chặn 403 khi Origin khác Host (dấu hiệu CSRF)", async () => {
    const req = tao({ Origin: "https://evil.com", Host: "app.example.com" });
    const res = chanRequestKhacOrigin(req);
    expect(res).not.toBeNull();
    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(403);
  });

  it("cho qua khi VẮNG header Origin — HÀNH VI CỐ Ý, không phải lỗ hổng", async () => {
    // curl / cron nội bộ / runbook DR gọi tay đều KHÔNG gắn Origin (không phải trình duyệt).
    // Nếu đổi cổng này sang fail-CLOSED khi vắng Origin, đường phục hồi (chạy tay lúc sự cố,
    // đúng lúc cần nhất) sẽ tự khoá chính mình. Trình duyệt LUÔN gắn Origin cho POST cross-site
    // và không giả được từ JS, nên "vắng Origin" không phải cửa cho kẻ tấn công — chỉ là dấu
    // hiệu "không phải lượt gọi từ trình duyệt". Lớp xác thực phiên (cookie) vẫn đứng trước cổng
    // này, KHÔNG được bỏ. ĐỪNG "sửa" ca này thành 403 — xem docblock chanRequestKhacOrigin.
    const req = tao({ Host: "app.example.com" });
    expect(chanRequestKhacOrigin(req)).toBeNull();
  });

  it("cho qua khi có Origin nhưng vắng Host (không so được, không bịa kết luận)", () => {
    const req = tao({ Origin: "https://app.example.com" });
    expect(chanRequestKhacOrigin(req)).toBeNull();
  });

  it("chặn 403 khi Origin méo, không parse được bằng URL()", () => {
    const req = tao({ Origin: "not a url", Host: "app.example.com" });
    const res = chanRequestKhacOrigin(req);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it("chặn 403 khi cùng host nhưng khác cổng (URL.host gồm cả cổng)", () => {
    const req = tao({
      Origin: "https://app.example.com:8443",
      Host: "app.example.com",
    });
    const res = chanRequestKhacOrigin(req);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it("cho qua khi cùng host khác scheme (dev http vs prod https)", () => {
    // Chỉ so `host` (không so scheme) CỐ Ý: sau Cloudflare Tunnel, TLS terminate ở tầng trước —
    // container app nhận request nội bộ dạng http trong khi trình duyệt gõ https, còn dev chạy
    // thẳng http://localhost:3000. So cả scheme sẽ gãy CẢ HAI ca hợp lệ này. Origin giả mạo thay
    // scheme nhưng KHÔNG đổi được host thật thì vẫn không lợi gì cho kẻ tấn công — host mới là
    // ranh giới bảo mật ở đây.
    const req = tao({ Origin: "http://localhost:3000", Host: "localhost:3000" });
    expect(chanRequestKhacOrigin(req)).toBeNull();
  });

  it("body JSON của response 403 có trường error", async () => {
    const req = tao({ Origin: "https://evil.com", Host: "app.example.com" });
    const res = chanRequestKhacOrigin(req);
    expect(res).not.toBeNull();
    const body = await res!.json();
    expect(body).toHaveProperty("error");
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
  });
});

/**
 * Ca SỐNG CÒN cho triển khai thật: app chạy sau Cloudflare Tunnel. Nếu `cloudflared` (hoặc một
 * reverse proxy khác) viết lại `Host` thành `localhost:3000` trong khi trình duyệt gửi
 * `Origin: https://app.example.com`, một cổng chỉ so `host` sẽ 403 MỌI lượt hợp lệ — khoá đúng
 * hai chức năng cứu hộ vào đúng ngày cần. Bộ ca dưới đây khoá hành vi tránh né đó.
 */
describe("chanRequestKhacOrigin — sau reverse proxy viết lại Host", () => {
  it("cho qua khi Origin khớp x-forwarded-host dù Host đã bị proxy viết lại", () => {
    const req = new Request("https://app.example.com/api/backup", {
      method: "POST",
      headers: {
        Origin: "https://app.example.com",
        Host: "localhost:3000",
        "X-Forwarded-Host": "app.example.com",
      },
    });
    expect(chanRequestKhacOrigin(req)).toBeNull();
  });

  it("vẫn chặn 403 khi Origin không khớp CẢ HAI header host", () => {
    const req = new Request("https://app.example.com/api/backup", {
      method: "POST",
      headers: {
        Origin: "https://evil.com",
        Host: "localhost:3000",
        "X-Forwarded-Host": "app.example.com",
      },
    });
    const res = chanRequestKhacOrigin(req);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it("cho qua khi Origin khớp Host gốc dù có x-forwarded-host khác", () => {
    // Ca gọi nội bộ theo tên container: Host = tên thật, x-forwarded-host do tầng khác gắn.
    const req = new Request("https://app.example.com/api/backup", {
      method: "POST",
      headers: {
        Origin: "http://hogikids-app:3000",
        Host: "hogikids-app:3000",
        "X-Forwarded-Host": "app.example.com",
      },
    });
    expect(chanRequestKhacOrigin(req)).toBeNull();
  });
});

/**
 * `Origin: null` là chuỗi "null" chứ không phải header vắng — trình duyệt gửi nó từ iframe
 * sandbox và sau redirect cross-origin. Hiện nó ra 403 NHỜ `new URL("null")` ném; ai đổi sang
 * `URL.parse()` (trả `null`, không ném) sẽ lật ngầm thành fail-open. Ca này khoá lại hành vi.
 */
describe("chanRequestKhacOrigin — Origin: null", () => {
  it("chặn 403 với Origin đúng chuỗi 'null' (iframe sandbox / redirect cross-origin)", () => {
    const req = new Request("https://app.example.com/api/backup", {
      method: "POST",
      headers: { Origin: "null", Host: "app.example.com" },
    });
    const res = chanRequestKhacOrigin(req);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });
});
