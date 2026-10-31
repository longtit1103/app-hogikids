import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `POST /api/restore/cat-phien` — lối cắt phiên script mồ côi đang giữ khoá ghi chung (nút "Cắt phiên"
 * ở modal phục hồi khi `/api/restore` trả 409 kèm `phienDangGiu`).
 *
 * Hợp đồng: chỉ chủ shop (403 còn lại), pid phải hợp lệ (400), pid KHÔNG giữ khoá ⇒ từ chối 409 và
 * KHÔNG ghi dòng thành công, pid đúng ⇒ gọi `catPhienGiuKhoaChung` đúng pid + một dòng nhật ký OK,
 * đang phục hồi ⇒ 409 mà không đụng phiên nào (khoá X của chính lượt phục hồi cũng là advisory lock
 * trên cùng số khoá).
 *
 * `catPhienGiuKhoaChung` mock: việc nó chỉ cắt đúng phiên đang giữ khoá (cùng role/DB) do
 * `tests/backup/khoa-chung-cli-hai-tien-trinh.test.ts` chứng minh trên Postgres thật.
 */
const phien = vi.hoisted(() => ({ role: "OWNER" as "OWNER" | "STAFF" }));
vi.mock("@/lib/quyen/nguoi-dung-phien", async (importActual) => {
  const that = await importActual<typeof import("@/lib/quyen/nguoi-dung-phien")>();
  const { nguoiDungGia } = await import("./helpers/nguoi-dung-gia");
  return {
    ...that,
    docNguoiDungPhien: vi.fn(async () => nguoiDungGia({ id: "test-cat-phien", email: "chu-shop@hogikids.test", role: phien.role })),
  };
});
vi.mock("@/lib/backup/khoa-chung-cli", async (importActual) => {
  const that = await importActual<typeof import("@/lib/backup/khoa-chung-cli")>();
  return { ...that, catPhienGiuKhoaChung: vi.fn(async () => ({ ketQua: "da-cat" as const })) };
});
vi.mock("@/lib/nhat-ky/ghi-nhat-ky", () => ({
  ghiNhatKy: vi.fn(async () => undefined),
  ghiNhatKyLoi: vi.fn(async () => undefined),
}));

import { POST } from "@/app/api/restore/cat-phien/route";
import { thuGiuKhoaPhucHoi } from "@/lib/backup/khoa-bao-tri";
import { catPhienGiuKhoaChung } from "@/lib/backup/khoa-chung-cli";
import { ghiNhatKy, ghiNhatKyLoi } from "@/lib/nhat-ky/ghi-nhat-ky";
import { donKhoaPhucHoi } from "./helpers/khoa-bao-tri-reset";

const URL_GOC = "http://localhost/api/restore/cat-phien";

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return POST(
    new Request(URL_GOC, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  phien.role = "OWNER";
  vi.mocked(catPhienGiuKhoaChung).mockReset().mockResolvedValue({ ketQua: "da-cat" });
  vi.mocked(ghiNhatKy).mockClear();
  vi.mocked(ghiNhatKyLoi).mockClear();
});

afterEach(() => {
  donKhoaPhucHoi();
});

describe("POST /api/restore/cat-phien", () => {
  it("không phải chủ shop ⇒ 403, KHÔNG cắt phiên nào", async () => {
    phien.role = "STAFF";

    const res = await post({ pid: 4242 });

    expect(res.status).toBe(403);
    expect(catPhienGiuKhoaChung).not.toHaveBeenCalled();
    expect(ghiNhatKy).not.toHaveBeenCalled();
  });

  it("request khác origin ⇒ 403, KHÔNG cắt phiên nào", async () => {
    const res = await post({ pid: 4242 }, { origin: "https://ke-tan-cong.example", host: "app.example.test" });

    expect(res.status).toBe(403);
    expect(catPhienGiuKhoaChung).not.toHaveBeenCalled();
  });

  it.each([
    ["thân không phải JSON", "không-phải-json"],
    ["thiếu pid", {}],
    ["pid là chuỗi", { pid: "4242" }],
    ["pid không nguyên", { pid: 12.5 }],
    ["pid âm", { pid: -1 }],
    ["pid bằng 0", { pid: 0 }],
    ["backendStart không phải thời điểm ISO", { pid: 4242, backendStart: "hôm qua" }],
  ])("%s ⇒ 400, KHÔNG cắt phiên nào", async (_ten, body) => {
    const res = await post(body);

    expect(res.status).toBe(400);
    expect(catPhienGiuKhoaChung).not.toHaveBeenCalled();
  });

  it("pid KHÔNG giữ khoá ⇒ từ chối 409, ghi dòng LOI, không ghi dòng OK", async () => {
    vi.mocked(catPhienGiuKhoaChung).mockResolvedValue({ ketQua: "khong-chan" });

    const res = await post({ pid: 777 });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("777");
    expect(body.khacRole).toBeUndefined();
    expect(catPhienGiuKhoaChung).toHaveBeenCalledWith(expect.anything(), 777, undefined);
    expect(ghiNhatKy).not.toHaveBeenCalled();
    expect(ghiNhatKyLoi).toHaveBeenCalledTimes(1);
  });

  it("phiên thuộc role KHÁC ⇒ 409 nói đúng lý do (role + lệnh superuser cắt tay), cờ khacRole, ghi dòng LOI", async () => {
    vi.mocked(catPhienGiuKhoaChung).mockResolvedValue({ ketQua: "khac-role", usename: "supabase_admin" });

    const res = await post({ pid: 777 });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ khacRole: true, usename: "supabase_admin" });
    expect(body.error).toContain('role "supabase_admin"');
    expect(body.error).toContain("SELECT pg_terminate_backend(777);");
    // Câu "đã tự thoát" là sai sự thật với phiên còn sống của role khác.
    expect(body.error).not.toMatch(/tự thoát/);
    expect(ghiNhatKy).not.toHaveBeenCalled();
    expect(ghiNhatKyLoi).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ghiNhatKyLoi).mock.calls[0][0]).toMatchObject({ ghiChu: { lyDo: "PHIEN_THUOC_ROLE_KHAC" } });
  });

  it("pid đúng ⇒ gọi catPhienGiuKhoaChung đúng pid, trả ok, ghi một dòng nhật ký OK", async () => {
    const res = await post({ pid: 4242 });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, pid: 4242 });
    expect(catPhienGiuKhoaChung).toHaveBeenCalledTimes(1);
    expect(catPhienGiuKhoaChung).toHaveBeenCalledWith(
      expect.objectContaining({ application_name: "hogikids-cat-phien" }),
      4242,
      undefined,
    );
    expect(ghiNhatKy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ghiNhatKy).mock.calls[0][1]).toMatchObject({
      hanhDong: "PHUC_HOI_CAT_PHIEN",
      actor: { id: "test-cat-phien", email: "chu-shop@hogikids.test" },
      doiTuong: { loai: "PhienDb", id: "4242" },
    });
    expect(ghiNhatKyLoi).not.toHaveBeenCalled();
  });

  it("backendStart từ danh sách 409 được chuyển nguyên cho bước cắt (pid cũ có thể đã thuộc phiên mới)", async () => {
    const res = await post({ pid: 4242, backendStart: "2026-10-28T01:00:00.123Z" });

    expect(res.status).toBe(200);
    expect(catPhienGiuKhoaChung).toHaveBeenCalledWith(expect.anything(), 4242, "2026-10-28T01:00:00.123Z");
  });

  it("ghi nhật ký OK hỏng ⇒ vẫn 200 (phiên đã bị cắt, không được biến thành 500)", async () => {
    vi.mocked(ghiNhatKy).mockRejectedValueOnce(new Error("mất kết nối"));

    const res = await post({ pid: 4242 });

    expect(res.status).toBe(200);
  });

  it("DB không phản hồi lúc cắt ⇒ 500 có câu nói rõ, không ghi dòng OK", async () => {
    vi.mocked(catPhienGiuKhoaChung).mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await post({ pid: 4242 });

    expect(res.status).toBe(500);
    expect(ghiNhatKy).not.toHaveBeenCalled();
  });

  it("đang có lượt phục hồi chạy ⇒ 409 và KHÔNG cắt (khoá X của lượt đó cùng số khoá)", async () => {
    expect(thuGiuKhoaPhucHoi()).not.toBeNull();

    const res = await post({ pid: 4242 });

    expect(res.status).toBe(409);
    expect(catPhienGiuKhoaChung).not.toHaveBeenCalled();
  });
});
