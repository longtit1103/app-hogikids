import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Writer APP-OWNED (giá vốn, tài khoản) kiểm cờ phục hồi MỘT LẦN ở cửa rồi mở transaction — lượt đã
 * qua cửa vẫn COMMIT sau khi lượt phục hồi chụp bản lùi, bị bản nạp lại đè (giá vốn không lấy lại
 * được từ Pancake). Kiểm lần hai BÊN TRONG transaction, sau khoá dòng đầu và ngay trước commit: cờ
 * bật giữa chừng ⇒ ném ⇒ transaction cuộn lại, action trả đúng câu "đang phục hồi" và KHÔNG ghi nhật ký.
 *
 * Giả lập transaction: `$transaction` chạy callback với `fakeTx`, bắt lỗi để đánh dấu "đã cuộn lại"
 * rồi ném lại — đúng hợp đồng Prisma (callback ném ⇒ rollback).
 */
const nguon = vi.hoisted(() => ({
  daCuonLai: { v: false },
  fakeTx: {
    variant: { update: vi.fn(), updateMany: vi.fn() },
    user: { update: vi.fn(), create: vi.fn(), delete: vi.fn() },
    $queryRaw: vi.fn(),
  },
  ghiNhatKy: vi.fn(async () => {}),
  ghiNhatKyLoi: vi.fn(async () => {}),
  chuShop: {
    id: "o1",
    email: "o@hogikids.test",
    tenHienThi: "",
    role: "OWNER",
    quyen: new Set(),
    phaiDoiMatKhau: false,
    mocPhien: "0",
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      try {
        return await cb(nguon.fakeTx);
      } catch (loi) {
        nguon.daCuonLai.v = true;
        throw loi;
      }
    },
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/nhat-ky/ghi-nhat-ky", () => ({
  ghiNhatKy: nguon.ghiNhatKy,
  ghiNhatKyLoi: nguon.ghiNhatKyLoi,
}));
vi.mock("@/lib/quyen/cong-action", () => ({
  congAction: vi.fn(async () => ({ ok: true, nguoiDung: nguon.chuShop })),
  congChuShopAction: vi.fn(async () => ({ ok: true, nguoiDung: nguon.chuShop })),
}));
vi.mock("@/lib/actions/cong-gia-von", () => ({ kiemQuyenXemGiaVon: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/password", () => ({ hashPassword: vi.fn(async () => "hash") }));
vi.mock("@/lib/session", () => ({
  sinhMocPhien: vi.fn(() => "0".repeat(32)),
  thuHoiPhienCuaNguoi: vi.fn(async () => "0".repeat(32)),
}));

import { importCostPrices, updateVariantCost } from "@/lib/actions/cost-price";
import { suaQuyenTaiKhoan, taoTaiKhoan } from "@/lib/actions/tai-khoan";
import { LOI_DANG_PHUC_HOI, thuGiuKhoaPhucHoi } from "@/lib/backup/khoa-bao-tri";
import { kiemKhongPhucHoiTrongTx, LoiDangPhucHoiTrongTx } from "@/lib/backup/kiem-khong-phuc-hoi-trong-tx";
import { donKhoaPhucHoi } from "../../helpers/khoa-bao-tri-reset";

const bat = () => {
  expect(thuGiuKhoaPhucHoi()).not.toBeNull();
};

beforeEach(() => {
  donKhoaPhucHoi();
  nguon.daCuonLai.v = false;
  nguon.ghiNhatKy.mockClear();
  nguon.ghiNhatKyLoi.mockClear();
  nguon.fakeTx.variant.update.mockReset().mockResolvedValue({});
  nguon.fakeTx.variant.updateMany.mockReset().mockResolvedValue({ count: 1 });
  nguon.fakeTx.user.update.mockReset().mockResolvedValue({});
  nguon.fakeTx.user.create.mockReset().mockResolvedValue({ id: "u-moi" });
  nguon.fakeTx.$queryRaw
    .mockReset()
    .mockResolvedValue([
      { id: "u1", email: "nv@hogikids.test", role: "STAFF", isActive: true, sessionEpoch: "0", mustChangePassword: false },
    ]);
});
afterEach(() => donKhoaPhucHoi());

describe("kiemKhongPhucHoiTrongTx", () => {
  it("không phục hồi → không ném", () => {
    expect(() => kiemKhongPhucHoiTrongTx()).not.toThrow();
  });

  it("đang phục hồi → ném LoiDangPhucHoiTrongTx mang đúng câu báo dùng chung", () => {
    bat();
    expect(() => kiemKhongPhucHoiTrongTx()).toThrow(LoiDangPhucHoiTrongTx);
    expect(() => kiemKhongPhucHoiTrongTx()).toThrow(LOI_DANG_PHUC_HOI);
  });
});

describe("cờ phục hồi bật GIỮA transaction → cuộn lại", () => {
  it("updateVariantCost: lượt phục hồi bắt đầu sau câu UPDATE ⇒ cuộn lại, trả câu đang-phục-hồi", async () => {
    nguon.fakeTx.variant.update.mockImplementation(async () => {
      bat();
      return {};
    });
    const kq = await updateVariantCost("v1", 12_000);
    expect(kq).toEqual({ ok: false, error: LOI_DANG_PHUC_HOI });
    expect(nguon.daCuonLai.v).toBe(true);
  });

  it("updateVariantCost: không có phục hồi → vẫn thành công, không cuộn lại", async () => {
    const kq = await updateVariantCost("v1", 12_000);
    expect(kq.ok).toBe(true);
    expect(nguon.daCuonLai.v).toBe(false);
    expect(nguon.ghiNhatKy).toHaveBeenCalledTimes(1);
  });

  it("importCostPrices: cờ bật giữa vòng áp giá ⇒ cuộn lại cả lượt", async () => {
    nguon.fakeTx.variant.updateMany.mockImplementation(async () => {
      bat();
      return { count: 1 };
    });
    const kq = await importCostPrices([{ sku: "SKU-1", costPrice: 5_000, lowStockThreshold: null }]);
    expect(kq).toEqual({ ok: false, error: LOI_DANG_PHUC_HOI });
    expect(nguon.daCuonLai.v).toBe(true);
  });

  it("suaQuyenTaiKhoan: cờ bật sau khoá dòng đích ⇒ cuộn lại, KHÔNG ghi dòng nhật ký lỗi vào schema sắp bị thay", async () => {
    nguon.fakeTx.user.update.mockImplementation(async () => {
      bat();
      return {};
    });
    const kq = await suaQuyenTaiKhoan("u1", []);
    expect(kq).toEqual({ ok: false, error: LOI_DANG_PHUC_HOI });
    expect(nguon.daCuonLai.v).toBe(true);
    expect(nguon.ghiNhatKyLoi).not.toHaveBeenCalled();
  });

  it("taoTaiKhoan: cờ bật sau câu tạo user ⇒ cuộn lại, không lộ mật khẩu tạm", async () => {
    nguon.fakeTx.user.create.mockImplementation(async () => {
      bat();
      return { id: "u-moi" };
    });
    const form = new FormData();
    form.set("email", "nv-moi@hogikids.test");
    form.set("tenHienThi", "Nhân viên mới");
    const kq = await taoTaiKhoan(form);
    expect(kq).toEqual({ ok: false, error: LOI_DANG_PHUC_HOI });
    expect(nguon.daCuonLai.v).toBe(true);
    expect(nguon.ghiNhatKyLoi).not.toHaveBeenCalled();
  });
});
