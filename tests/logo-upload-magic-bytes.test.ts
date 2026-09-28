import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Chốt lớp kiểm ĐỊNH DẠNG THẬT của ảnh logo: `File.type` (MIME) là do trình duyệt khai trong
 * request nên giả được — gửi request thủ công với `Content-Type: image/png` mà ruột là file bất
 * kỳ thì lớp kiểm MIME cho qua hết. Lớp thứ hai đọc thẳng vài byte đầu buffer mới là thứ chặn được.
 *
 * Mock session/prisma/next-cache để test THUẦN nhánh từ chối — nhánh này không ghi gì lên đĩa nên
 * không đụng `public/uploads`. Nhánh CHẤP NHẬN cố ý không test ở đây vì nó ghi file thật; đường đó
 * đã có e2e (`tests/e2e/settings.spec.ts`).
 */
vi.mock("@/lib/session", () => ({
  requireUser: vi.fn(async () => "test-user-id"),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn(async () => null), update: vi.fn(async () => ({})) },
  },
}));

import { updateShopInfo } from "@/lib/actions/settings-shop-info";
import { prisma } from "@/lib/prisma";

/** FormData của form "Thông tin shop" kèm 1 file logo. */
function form(logo: File): FormData {
  const fd = new FormData();
  fd.set("shopName", "HogiKids");
  fd.set("shopPhone", "");
  fd.set("logo", logo);
  return fd;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe("updateShopInfo — logo phải khớp magic bytes, không chỉ MIME", () => {
  // Mock `prisma` dùng chung cả file, nên phải dọn giữa từng ca: thiếu bước này thì assertion
  // "không ghi DB" của ca sau vẫn đọc được lượt gọi của ca trước — xanh/đỏ phụ thuộc thứ tự chạy.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("MIME khai image/png nhưng ruột KHÔNG phải PNG → từ chối, không ghi DB", async () => {
    // Ruột là script/HTML — đúng thứ mà lớp kiểm MIME một mình sẽ cho qua.
    const gia = new File([new Uint8Array([0x3c, 0x21, 0x44, 0x4f, 0x43])], "logo.png", {
      type: "image/png",
    });

    const r = await updateShopInfo(form(gia));

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.field).toBe("logo");
    // Không được lưu gì: tên shop cũng không, vì cả thao tác phải hỏng cùng nhau.
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("MIME khai image/jpeg nhưng ruột là PNG → từ chối (không suy ra định dạng từ nhãn)", async () => {
    const lechDinhDang = new File([new Uint8Array(PNG_MAGIC)], "logo.jpg", { type: "image/jpeg" });

    const r = await updateShopInfo(form(lechDinhDang));

    expect(r.ok).toBe(false);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("MIME ngoài allowlist (SVG) → từ chối ngay ở lớp đầu", async () => {
    // SVG là vector XSS phổ biến nhất khi phục vụ lại file do người dùng tải lên — allowlist chỉ
    // nhận PNG/JPG, không được nới.
    const svg = new File(["<svg xmlns='http://www.w3.org/2000/svg'></svg>"], "logo.svg", {
      type: "image/svg+xml",
    });

    const r = await updateShopInfo(form(svg));

    expect(r.ok).toBe(false);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
