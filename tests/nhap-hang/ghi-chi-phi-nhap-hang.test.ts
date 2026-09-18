import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  vanTayDeXuatPhieuNhap,
  type PhieuNhapDeXuat,
} from "@/lib/nhap-hang/doi-chieu-phieu-nhap";

/**
 * Cổng TỪ CHỐI của lượt ghi chi phí nhập hàng — phần không cần DB.
 *
 * Ba cổng dưới đây là thứ đứng giữa "chủ shop duyệt tập A" và "app ghi tập B": vân tay danh sách,
 * uuid phải thuộc đề xuất server vừa đọc, và ràng buộc số tiền. Mỗi cổng hỏng là một dòng tiền hàng
 * chục triệu vào sổ mà không ai chủ ý.
 */

vi.mock("@/lib/session", () => ({ requireUser: vi.fn(async () => "test-user-id") }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const findMany = vi.fn(async () => [] as { refId: string | null }[]);
const createMany = vi.fn(async (args: { data: unknown[] }) => ({ count: args.data.length }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    expense: {
      findMany: (...a: unknown[]) => findMany(...(a as [])),
      createMany: (...a: unknown[]) => createMany(...(a as [{ data: unknown[] }])),
    },
  },
}));

const docDeXuatPhieuNhap = vi.fn();
vi.mock("@/lib/nhap-hang/doc-phieu-nhap-bronze", () => ({
  docDeXuatPhieuNhap: () => docDeXuatPhieuNhap(),
}));

// Số đếm nhắc việc ghi `Setting` — không thuộc phạm vi suite này (và prisma đã bị thay giả).
const capNhatSoPhieuNhapChuaGhi = vi.fn(async () => ({ choDuyet: 0, hauKiem: 0 }));
vi.mock("@/lib/nhap-hang/cap-nhat-so-phieu-nhap", () => ({
  capNhatSoPhieuNhapChuaGhi: () => capNhatSoPhieuNhapChuaGhi(),
}));

const { ghiChiPhiNhapHang } = await import("@/lib/actions/chi-phi-nhap-hang");

function phieu(uuid: string, soTien: number, displayId: number): PhieuNhapDeXuat {
  return {
    uuid,
    displayId,
    ngay: new Date(2026, 8, 10),
    soTien,
    soLuong: 10,
    soDongHang: 2,
    nhaCungCap: null,
    ghiChu: null,
    refId: `PANCAKE_PURCHASE:${uuid}`,
    lechLuoiKiem: false,
  };
}

const DE_XUAT = [phieu("uuid-a", 28_999_920, 181), phieu("uuid-b", 59_559_808, 182)];

beforeEach(() => {
  findMany.mockClear();
  createMany.mockClear();
  docDeXuatPhieuNhap.mockReset();
  docDeXuatPhieuNhap.mockResolvedValue({ deXuat: DE_XUAT });
});

describe("vanTayDeXuatPhieuNhap", () => {
  it("cùng danh sách ⇒ cùng vân tay; đổi tiền hoặc đổi phiếu ⇒ khác", () => {
    const goc = vanTayDeXuatPhieuNhap(DE_XUAT);

    expect(vanTayDeXuatPhieuNhap([...DE_XUAT])).toBe(goc);
    expect(vanTayDeXuatPhieuNhap([DE_XUAT[0]])).not.toBe(goc);
    expect(
      vanTayDeXuatPhieuNhap([DE_XUAT[0], { ...DE_XUAT[1], soTien: 59_559_809 }]),
    ).not.toBe(goc);
  });

  it("tráo phiếu mà giữ nguyên số dòng + tổng tiền vẫn bị bắt (nhờ băm uuid)", () => {
    const traoDoi = [phieu("uuid-a", 28_999_920, 181), phieu("uuid-khac", 59_559_808, 999)];

    expect(vanTayDeXuatPhieuNhap(traoDoi)).not.toBe(vanTayDeXuatPhieuNhap(DE_XUAT));
  });
});

describe("ghiChiPhiNhapHang — cổng từ chối", () => {
  it("vân tay đổi (ảnh Bronze mới land giữa chừng) ⇒ từ chối, KHÔNG ghi dòng nào", async () => {
    const kq = await ghiChiPhiNhapHang({
      vanTay: "2:0:0",
      chon: [{ uuid: "uuid-a", soTien: 28_999_920 }],
    });

    expect(kq.ok).toBe(false);
    if (!kq.ok) expect(kq.code).toBe("DANH_SACH_DA_DOI");
    expect(createMany).not.toHaveBeenCalled();
  });

  it("uuid không nằm trong đề xuất server vừa đọc ⇒ từ chối CẢ LƯỢT", async () => {
    const kq = await ghiChiPhiNhapHang({
      vanTay: vanTayDeXuatPhieuNhap(DE_XUAT),
      // Phiếu hợp lệ đi kèm một uuid bịa: không được ghi phiếu hợp lệ rồi bỏ qua cái lạ.
      chon: [
        { uuid: "uuid-a", soTien: 28_999_920 },
        { uuid: "uuid-bia", soTien: 1_000_000 },
      ],
    });

    expect(kq.ok).toBe(false);
    if (!kq.ok) expect(kq.code).toBe("DANH_SACH_DA_DOI");
    expect(createMany).not.toHaveBeenCalled();
  });

  it("số tiền vượt trần 2 tỷ ⇒ từ chối TRƯỚC khi đọc đề xuất", async () => {
    const kq = await ghiChiPhiNhapHang({
      vanTay: vanTayDeXuatPhieuNhap(DE_XUAT),
      chon: [{ uuid: "uuid-a", soTien: 2_000_000_001 }],
    });

    expect(kq.ok).toBe(false);
    if (!kq.ok) expect(kq.error).toContain("tối đa 2 tỷ");
    expect(docDeXuatPhieuNhap).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
  });

  it.each([
    ["âm", -1],
    ["bằng 0", 0],
    ["lẻ đồng (không nguyên)", 1_000.5],
  ])("số tiền %s ⇒ từ chối", async (_ten, soTien) => {
    const kq = await ghiChiPhiNhapHang({
      vanTay: vanTayDeXuatPhieuNhap(DE_XUAT),
      chon: [{ uuid: "uuid-a", soTien }],
    });

    expect(kq.ok).toBe(false);
    expect(createMany).not.toHaveBeenCalled();
  });

  it("chọn rỗng ⇒ từ chối", async () => {
    const kq = await ghiChiPhiNhapHang({ vanTay: vanTayDeXuatPhieuNhap(DE_XUAT), chon: [] });

    expect(kq.ok).toBe(false);
    expect(createMany).not.toHaveBeenCalled();
  });

  it("vân tay khớp + số tiền sửa tay hợp lệ ⇒ ghi đúng dòng đã chọn, danh mục purchase", async () => {
    // Chủ shop mới trả một phần cho NCC: sửa 59.559.808 → 20.000.000.
    const kq = await ghiChiPhiNhapHang({
      vanTay: vanTayDeXuatPhieuNhap(DE_XUAT),
      chon: [{ uuid: "uuid-b", soTien: 20_000_000 }],
    });

    expect(kq.ok).toBe(true);
    if (kq.ok) expect(kq.data).toEqual({ daGhi: 1, boQua: 0, tongTien: 20_000_000 });
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany.mock.calls[0][0]).toMatchObject({
      skipDuplicates: true,
      data: [
        {
          categoryId: "purchase",
          amount: 20_000_000,
          source: "MANUAL",
          refId: "PANCAKE_PURCHASE:uuid-b",
          channelId: null,
        },
      ],
    });
  });
});
