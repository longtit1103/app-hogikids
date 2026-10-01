import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Nhật ký thao tác (`AuditLog`) của `POST /api/restore` — mã `PHUC_HOI`.
 *
 * Hợp đồng (quyết định sau review cuối):
 * - OK ghi SAU khi đã thu hồi phiên VÀ đã nhả khoá bảo trì, vào DB VỪA phục hồi (ghi trước lúc nạp là
 *   bị chính bản sao lưu xoá mất). CHỈ khi thu hồi phiên xong và vẫn là chủ khoá.
 * - Nạp xong nhưng chưa thu hồi được phiên (mất khoá / thu hồi lỗi) ⇒ HTTP vẫn 200 + `canhBao`, nhưng
 *   nhật ký là LOI kèm mã lý do cố định — không bao giờ OK.
 * - LOI khi từ chối 400/409/422/500 — bằng `ghiNhatKyLoi` sau khi nhả khoá (đang giữ khoá thì hàm đó tự
 *   bỏ qua ⇒ ghi trong vùng khoá là mất dòng).
 * - Lượt khác đang giữ khoá (409 "đang có lượt khác") ⇒ không ghi gì vào schema lượt kia đang thay.
 *
 * Không chạy pg thật: `runRestore`/`runPgDump`/thu hồi phiên được mock; khoá việc nặng + SyncLog +
 * nhật ký chạy thật xuống DB test.
 */
vi.mock("@/lib/quyen/nguoi-dung-phien", async (importActual) => {
  const that = await importActual<typeof import("@/lib/quyen/nguoi-dung-phien")>();
  const { nguoiDungGia } = await import("./helpers/nguoi-dung-gia");
  return {
    ...that,
    docNguoiDungPhien: vi.fn(async () =>
      nguoiDungGia({ id: "test-nhat-ky-phuc-hoi", email: "chu-shop-phuc-hoi@hogikids.test" }),
    ),
  };
});
vi.mock("@/lib/backup/run-pg-dump", () => ({ runPgDump: vi.fn(async () => Buffer.from("PGDMP bản lùi")) }));
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  unlink: vi.fn(async () => undefined),
}));
vi.mock("@/lib/backup/run-restore", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("@/lib/backup/run-restore");
  return {
    ...real,
    kiemDumCoM1: vi.fn(async () => undefined),
    runRestore: vi.fn(async () => ({ format: "custom" as const })),
  };
});
vi.mock("@/lib/backup/thu-hoi-phien-co-han", () => ({ thuHoiMoiPhienCoHan: vi.fn(async () => undefined) }));

/** Trạng thái lúc ghi nhật ký — chứng minh THỜI ĐIỂM ghi, không chỉ việc có dòng. */
const lucGhi = vi.hoisted(() => ({ dangPhucHoi: [] as boolean[] }));
vi.mock("@/lib/nhat-ky/ghi-nhat-ky", async (importOriginal) => {
  const thuc = await importOriginal<typeof import("@/lib/nhat-ky/ghi-nhat-ky")>();
  const { dangPhucHoi } = await import("@/lib/backup/khoa-bao-tri");
  return {
    ...thuc,
    ghiNhatKy: vi.fn(async (...a: Parameters<typeof thuc.ghiNhatKy>) => {
      lucGhi.dangPhucHoi.push(dangPhucHoi());
      return thuc.ghiNhatKy(...a);
    }),
    ghiNhatKyLoi: vi.fn(async (...a: Parameters<typeof thuc.ghiNhatKyLoi>) => {
      lucGhi.dangPhucHoi.push(dangPhucHoi());
      return thuc.ghiNhatKyLoi(...a);
    }),
  };
});

import { POST } from "@/app/api/restore/route";
import { thuGiuKhoaPhucHoi } from "@/lib/backup/khoa-bao-tri";
import { LoiBackupTruocPhanQuyen } from "@/lib/backup/kiem-migration-trong-dump";
import { kiemDumCoM1, runRestore } from "@/lib/backup/run-restore";
import { thuHoiMoiPhienCoHan } from "@/lib/backup/thu-hoi-phien-co-han";
import { ghiNhatKy } from "@/lib/nhat-ky/ghi-nhat-ky";
import { prisma } from "@/lib/prisma";
import { donKhoaPhucHoi } from "./helpers/khoa-bao-tri-reset";

const ACTOR = "test-nhat-ky-phuc-hoi";

function post(noiDung: string): Promise<Response> {
  const fd = new FormData();
  fd.set("file", new File([new Uint8Array(Buffer.from(noiDung))], "backup.dump"));
  return POST(new Request("http://localhost/api/restore", { method: "POST", body: fd }));
}

async function dongNhatKy() {
  return prisma.auditLog.findMany({ where: { actorId: ACTOR }, orderBy: { thoiDiem: "asc" } });
}

async function don(): Promise<void> {
  await prisma.auditLog.deleteMany({ where: { actorId: ACTOR } });
  await prisma.setting.deleteMany({ where: { key: "khoaViecNang" } });
  await prisma.syncLog.deleteMany();
}

beforeEach(async () => {
  await don();
  lucGhi.dangPhucHoi.length = 0;
  vi.mocked(kiemDumCoM1).mockReset().mockResolvedValue(undefined);
  vi.mocked(runRestore).mockReset().mockResolvedValue({ format: "custom" });
  vi.mocked(thuHoiMoiPhienCoHan).mockClear();
  vi.mocked(ghiNhatKy).mockClear();
});

afterEach(() => {
  donKhoaPhucHoi();
});

afterAll(async () => {
  await don();
  await prisma.$disconnect();
});

describe("POST /api/restore — nhật ký PHUC_HOI", () => {
  it("OK ⇒ 1 dòng OK, ghi SAU thu hồi phiên và SAU khi đã nhả khoá bảo trì", async () => {
    const res = await post("PGDMP dữ liệu giả");
    expect(res.status).toBe(200);

    const dong = await dongNhatKy();
    expect(dong).toHaveLength(1);
    expect(dong[0]).toMatchObject({
      hanhDong: "PHUC_HOI",
      ketQua: "OK",
      actorEmail: "chu-shop-phuc-hoi@hogikids.test",
      doiTuongLoai: "BanSaoLuu",
    });
    expect(dong[0].doiTuongMoTa).toMatch(/^custom · \d+ byte$/);
    expect(dong[0].ghiChu).toBeNull();
    expect(lucGhi.dangPhucHoi).toEqual([false]);
    expect(vi.mocked(thuHoiMoiPhienCoHan).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(ghiNhatKy).mock.invocationCallOrder[0],
    );
  });

  it("ghi nhật ký OK hỏng ⇒ vẫn 200 (dữ liệu đã nạp xong, không được biến thành 500)", async () => {
    vi.mocked(ghiNhatKy).mockRejectedValueOnce(new Error("mất kết nối"));
    const res = await post("PGDMP dữ liệu giả");
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("dump đời trước phân quyền ⇒ 422 + 1 dòng LOI lý do cố định, ghi khi đã nhả khoá", async () => {
    vi.mocked(kiemDumCoM1).mockRejectedValue(new LoiBackupTruocPhanQuyen());
    const res = await post("PGDMP dữ liệu giả");
    expect(res.status).toBe(422);
    const dong = await dongNhatKy();
    expect(dong).toHaveLength(1);
    expect(dong[0]).toMatchObject({
      hanhDong: "PHUC_HOI",
      ketQua: "LOI",
      ghiChu: { lyDo: "Bản sao lưu đời trước phân quyền" },
    });
  });

  it("file không phải bản sao lưu ⇒ 400 + dòng LOI (không định dạng ⇒ không đối tượng)", async () => {
    const res = await post("không phải dump");
    expect(res.status).toBe(400);
    const dong = await dongNhatKy();
    expect(dong).toHaveLength(1);
    expect(dong[0]).toMatchObject({ ketQua: "LOI", doiTuongLoai: null, ghiChu: { lyDo: "File sao lưu không hợp lệ" } });
  });

  it("nạp hỏng (500, lỗi TRONG vùng giữ khoá) ⇒ dòng LOI vẫn được ghi — ghi sau khi nhả, không bị tự bỏ qua", async () => {
    vi.mocked(runRestore).mockRejectedValue(new Error("pg_restore: lỗi giữa chừng"));
    const res = await post("PGDMP dữ liệu giả");
    expect(res.status).toBe(500);
    expect(lucGhi.dangPhucHoi).toEqual([false]);
    const dong = await dongNhatKy();
    expect(dong).toHaveLength(1);
    expect(dong[0]).toMatchObject({ ketQua: "LOI", ghiChu: { lyDo: "Phục hồi thất bại" } });
  });

  it("nạp xong nhưng lượt KHÁC giành khoá giữa chừng ⇒ 200 kèm cảnh báo, KHÔNG ghi dòng OK chen vào lượt kia", async () => {
    vi.mocked(thuHoiMoiPhienCoHan).mockImplementationOnce(async () => {
      // Mô phỏng TTL nhả cờ rồi lượt khác giành: cờ bảo trì giờ thuộc về thẻ khác.
      donKhoaPhucHoi();
      expect(thuGiuKhoaPhucHoi()).not.toBeNull();
    });
    const res = await post("PGDMP dữ liệu giả");
    expect(res.status).toBe(200);
    expect((await res.json()).canhBao).toBeTruthy();
    expect(ghiNhatKy).not.toHaveBeenCalled();
    expect(await dongNhatKy()).toHaveLength(0);
  });

  // Ba ca "nạp xong nhưng CHƯA thu hồi được phiên": dữ liệu đã bị thay nên vẫn 200 + `canhBao` (nói
  // "chưa làm gì" là xui chủ shop bấm lại), nhưng nhật ký KHÔNG được ghi OK — thiết bị khác có thể còn
  // đăng nhập. Mã lý do cố định để lọc được, không chép câu cảnh báo tự do.
  it("thu hồi phiên NÉM (vẫn giữ khoá) ⇒ 200 + cảnh báo, 1 dòng LOI lý do CHUA_THU_HOI_PHIEN_LOI, không OK", async () => {
    vi.mocked(thuHoiMoiPhienCoHan).mockRejectedValueOnce(new Error("statement timeout"));
    const res = await post("PGDMP dữ liệu giả");
    expect(res.status).toBe(200);
    expect((await res.json()).canhBao).toBeTruthy();
    expect(ghiNhatKy).not.toHaveBeenCalled();
    const dong = await dongNhatKy();
    expect(dong).toHaveLength(1);
    expect(dong[0]).toMatchObject({
      hanhDong: "PHUC_HOI",
      ketQua: "LOI",
      doiTuongLoai: "BanSaoLuu",
      ghiChu: { lyDo: "CHUA_THU_HOI_PHIEN_LOI" },
    });
  });

  it("mất khoá TRƯỚC bước thu hồi phiên (TTL nhả trong lúc nạp) ⇒ 200 + cảnh báo, LOI lý do mất khoá, không OK", async () => {
    vi.mocked(runRestore).mockImplementationOnce(async () => {
      // TTL nhả cờ trong lúc nạp, chưa ai giành lại ⇒ chốt gia hạn trước thu hồi phiên trả false.
      donKhoaPhucHoi();
      return { format: "custom" };
    });
    const res = await post("PGDMP dữ liệu giả");
    expect(res.status).toBe(200);
    expect((await res.json()).canhBao).toBeTruthy();
    expect(thuHoiMoiPhienCoHan).not.toHaveBeenCalled();
    expect(ghiNhatKy).not.toHaveBeenCalled();
    const dong = await dongNhatKy();
    expect(dong).toHaveLength(1);
    expect(dong[0]).toMatchObject({ ketQua: "LOI", ghiChu: { lyDo: "CHUA_THU_HOI_PHIEN_MAT_KHOA" } });
  });

  it("mất khoá SAU khi thu hồi phiên chạy xong ⇒ 200 + cảnh báo, LOI lý do mất khoá, không OK", async () => {
    vi.mocked(thuHoiMoiPhienCoHan).mockImplementationOnce(async () => {
      // Câu thu hồi treo quá TTL rồi mới xong: cờ đã tự nhả, chưa ai giành lại.
      donKhoaPhucHoi();
    });
    const res = await post("PGDMP dữ liệu giả");
    expect(res.status).toBe(200);
    expect((await res.json()).canhBao).toBeTruthy();
    expect(ghiNhatKy).not.toHaveBeenCalled();
    const dong = await dongNhatKy();
    expect(dong).toHaveLength(1);
    expect(dong[0]).toMatchObject({ ketQua: "LOI", ghiChu: { lyDo: "CHUA_THU_HOI_PHIEN_MAT_KHOA" } });
  });

  it("lượt phục hồi KHÁC đang giữ khoá ⇒ 409, KHÔNG ghi dòng nào vào schema lượt kia đang thay", async () => {
    expect(thuGiuKhoaPhucHoi()).not.toBeNull();
    const res = await post("PGDMP dữ liệu giả");
    expect(res.status).toBe(409);
    expect(await dongNhatKy()).toHaveLength(0);
  });
});
