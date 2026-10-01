import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Quyen } from "@/lib/quyen/danh-muc-quyen";

/**
 * Cổng quyền + nhật ký cho nhóm action DÒNG TIỀN (spec phân quyền §1.1, §3.4, §5): khoản tiền khác,
 * chốt số dư cuối tháng, quỹ tối thiểu, import ví Shopee.
 *
 * Ba điều phải đúng cho MỌI action ghi:
 *  - thiếu quyền ⇒ `KHONG_CO_QUYEN`, không ghi gì, có dòng `TU_CHOI_QUYEN` nêu đúng quyền thiếu;
 *  - lượt ghi thật ⇒ đúng một dòng nhật ký OK đúng `hanhDong`, cùng transaction;
 *  - ghi nhật ký ném ⇒ mutation KHÔNG lưu (không bao giờ có thay đổi mà thiếu dấu vết).
 */
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => ({
  ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
  docNguoiDungPhien: vi.fn(),
}));
vi.mock("@/lib/nhat-ky/ghi-nhat-ky", async (goc) => {
  const that = await goc<typeof import("@/lib/nhat-ky/ghi-nhat-ky")>();
  return { ...that, ghiNhatKy: vi.fn(that.ghiNhatKy) };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createCashMovement, deleteCashMovement, updateCashMovement } from "@/lib/actions/cash-movements";
import { luuSoDuChotThang, xoaSoDuChotThang } from "@/lib/actions/so-du-chot-thang";
import { datQuyToiThieu } from "@/lib/actions/so-quy-quy-toi-thieu";
import { importShopeeWallet, previewShopeeWalletImport } from "@/lib/actions/shopee-wallet-import";
import { ghiNhatKy } from "@/lib/nhat-ky/ghi-nhat-ky";
import { prisma } from "@/lib/prisma";
import { docNguoiDungPhien } from "@/lib/quyen/nguoi-dung-phien";
import { KEY_QUY_TOI_THIEU } from "@/lib/so-quy/du-bao-quy-queries";
import { nguoiDungGia } from "./helpers/nguoi-dung-gia";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

const chuShop = () => nguoiDungGia();
const nhanVien = (...quyen: Quyen[]) => nguoiDungGia({ id: "staff-1", email: "nv@hogikids.test", role: "STAFF", quyen: new Set(quyen) });
const dangNhapLa = (nd: ReturnType<typeof nguoiDungGia>) => vi.mocked(docNguoiDungPhien).mockResolvedValue(nd);

const khoanTien = { date: "2026-07-10", kind: "CAPITAL_IN", amount: 100_000_000, description: "Góp vốn" };

async function nhatKy(hanhDong: string) {
  return prisma.auditLog.findMany({ where: { hanhDong }, orderBy: { thoiDiem: "asc" } });
}

async function moSo(): Promise<void> {
  await prisma.cashMovement.create({
    data: { date: new Date(2026, 6, 5), kind: "CAPITAL_IN", amount: 100_000_000, description: "Mở sổ" },
  });
}

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.auditLog.deleteMany();
  await prisma.setting.deleteMany({ where: { key: KEY_QUY_TOI_THIEU } });
  vi.mocked(ghiNhatKy).mockClear();
  dangNhapLa(chuShop());
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.auditLog.deleteMany();
  await prisma.setting.deleteMany({ where: { key: KEY_QUY_TOI_THIEU } });
  await prisma.$disconnect();
});

describe("khoản tiền khác (CashMovement)", () => {
  it("tạo / sửa / xoá ⇒ mỗi lượt đúng một dòng nhật ký OK, đúng đối tượng + actor", async () => {
    expect((await createCashMovement(khoanTien)).ok).toBe(true);
    const row = await prisma.cashMovement.findFirstOrThrow();
    expect((await updateCashMovement(row.id, { ...khoanTien, amount: 90_000_000 })).ok).toBe(true);
    expect((await deleteCashMovement(row.id)).ok).toBe(true);

    for (const hd of ["DONG_TIEN_TAO", "DONG_TIEN_SUA", "DONG_TIEN_XOA"]) {
      const dong = await nhatKy(hd);
      expect(dong, hd).toHaveLength(1);
      expect(dong[0]).toMatchObject({
        ketQua: "OK",
        actorId: "test-user",
        actorEmail: "test-user@hogikids.test",
        doiTuongLoai: "CashMovement",
        doiTuongId: row.id,
      });
    }
  });

  it("nhân sự chỉ có quyền XEM dòng tiền ⇒ KHONG_CO_QUYEN, không ghi, nhật ký nêu quyền thiếu", async () => {
    dangNhapLa(nhanVien("tai-chinh-dong-tien:xem", "tai-chinh-so-quy:sua"));

    const res = await createCashMovement(khoanTien);

    expect(res).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
    expect(await prisma.cashMovement.count()).toBe(0);
    const tuChoi = await nhatKy("TU_CHOI_QUYEN");
    expect(tuChoi).toHaveLength(1);
    expect(tuChoi[0]).toMatchObject({ ketQua: "LOI", actorId: "staff-1", ghiChu: { quyenThieu: "tai-chinh-dong-tien:sua" } });
  });

  it("nhân sự có `tai-chinh-dong-tien:sua` ⇒ ghi được, actor là chính người đó", async () => {
    dangNhapLa(nhanVien("tai-chinh-dong-tien:xem", "tai-chinh-dong-tien:sua"));

    expect((await createCashMovement(khoanTien)).ok).toBe(true);
    expect(await nhatKy("DONG_TIEN_TAO")).toMatchObject([{ actorId: "staff-1", actorEmail: "nv@hogikids.test" }]);
  });

  it("ghi nhật ký ném ⇒ dòng tiền KHÔNG được tạo", async () => {
    vi.mocked(ghiNhatKy).mockRejectedValueOnce(new Error("nhật ký hỏng giả lập"));

    const res = await createCashMovement(khoanTien);

    expect(res.ok).toBe(false);
    expect(await prisma.cashMovement.count()).toBe(0);
  });

  it("ghi nhật ký ném khi XOÁ ⇒ dòng còn nguyên + có dòng LOI nêu mã lỗi", async () => {
    await createCashMovement(khoanTien);
    const row = await prisma.cashMovement.findFirstOrThrow();
    vi.mocked(ghiNhatKy).mockRejectedValueOnce(new Error("nhật ký hỏng giả lập"));

    const res = await deleteCashMovement(row.id);

    expect(res.ok).toBe(false);
    expect(await prisma.cashMovement.count()).toBe(1);
    expect(await prisma.banGhiDaXoa.count()).toBe(0); // ảnh chụp thùng rác rollback theo
    const loi = await prisma.auditLog.findMany({ where: { hanhDong: "DONG_TIEN_XOA" } });
    expect(loi).toMatchObject([{ ketQua: "LOI", doiTuongId: row.id, ghiChu: { lyDo: "Error" } }]);
  });
});

describe("chốt số dư cuối tháng", () => {
  const chot = { thang: "2026-08-15", soDuBank: 85_000_000, tienMat: 5_000_000, note: "" };

  it("lưu / xoá ⇒ nhật ký OK kèm tháng (không kèm số tiền)", async () => {
    await moSo();
    expect((await luuSoDuChotThang(chot)).ok).toBe(true);
    expect((await xoaSoDuChotThang({ thang: "2026-08-01" })).ok).toBe(true);

    const luu = await nhatKy("CHOT_SO_DU_LUU");
    expect(luu).toMatchObject([{ ketQua: "OK", doiTuongLoai: "SoDuChotThang", ghiChu: { thang: "2026-08" } }]);
    expect(await nhatKy("CHOT_SO_DU_XOA")).toMatchObject([{ ketQua: "OK", ghiChu: { thang: "2026-08" } }]);
  });

  it("xoá tháng chưa chốt ⇒ lỗi như cũ, KHÔNG ghi dòng nhật ký OK", async () => {
    await moSo();
    const res = await xoaSoDuChotThang({ thang: "2026-08-01" });
    expect(res.ok).toBe(false);
    expect(await nhatKy("CHOT_SO_DU_XOA")).toHaveLength(0);
  });

  it("chỉ có quyền sổ quỹ ⇒ không chốt được số dư (quyền dòng tiền)", async () => {
    await moSo();
    dangNhapLa(nhanVien("tai-chinh-so-quy:xem", "tai-chinh-so-quy:sua"));

    expect(await luuSoDuChotThang(chot)).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
    expect(await prisma.soDuChotThang.count()).toBe(0);
  });

  it("ghi nhật ký ném ⇒ bản chốt không lưu", async () => {
    await moSo();
    vi.mocked(ghiNhatKy).mockRejectedValueOnce(new Error("nhật ký hỏng giả lập"));

    await expect(luuSoDuChotThang(chot)).rejects.toThrow();
    expect(await prisma.soDuChotThang.count()).toBe(0);
  });
});

describe("quỹ tối thiểu", () => {
  it("chủ shop đặt ⇒ nhật ký OK, không lộ số tiền", async () => {
    expect((await datQuyToiThieu({ soTien: 20_000_000 })).ok).toBe(true);
    const dong = await nhatKy("QUY_TOI_THIEU_DAT");
    expect(dong).toMatchObject([{ ketQua: "OK", doiTuongLoai: "Setting", doiTuongId: KEY_QUY_TOI_THIEU }]);
    expect(dong[0].ghiChu).toBeNull();
  });

  it("quyền dòng tiền KHÔNG đủ đặt quỹ tối thiểu (thuộc sổ quỹ)", async () => {
    dangNhapLa(nhanVien("tai-chinh-dong-tien:xem", "tai-chinh-dong-tien:sua"));

    expect(await datQuyToiThieu({ soTien: 20_000_000 })).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
    expect(await prisma.setting.count({ where: { key: KEY_QUY_TOI_THIEU } })).toBe(0);
    expect(await nhatKy("TU_CHOI_QUYEN")).toMatchObject([{ ghiChu: { quyenThieu: "tai-chinh-so-quy:sua" } }]);
  });

  it("ghi nhật ký ném ⇒ ô Setting không đổi", async () => {
    vi.mocked(ghiNhatKy).mockRejectedValueOnce(new Error("nhật ký hỏng giả lập"));

    expect((await datQuyToiThieu({ soTien: 20_000_000 })).ok).toBe(false);
    expect(await prisma.setting.count({ where: { key: KEY_QUY_TOI_THIEU } })).toBe(0);
  });
});

describe("import ví Shopee", () => {
  it("chỉ quyền XEM ⇒ xem trước được (qua cổng), import thì KHONG_CO_QUYEN", async () => {
    dangNhapLa(nhanVien("tai-chinh-dong-tien:xem"));

    const xemTruoc = await previewShopeeWalletImport(new FormData());
    expect(xemTruoc.ok).toBe(false);
    if (!xemTruoc.ok) expect(xemTruoc.code).not.toBe("KHONG_CO_QUYEN"); // lỗi thiếu file, không phải quyền

    expect(await importShopeeWallet(new FormData())).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
  });

  it("không có quyền dòng tiền ⇒ cả xem trước cũng bị chặn", async () => {
    dangNhapLa(nhanVien("chi-phi:xem", "chi-phi:sua"));

    expect(await previewShopeeWalletImport(new FormData())).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
  });
});
