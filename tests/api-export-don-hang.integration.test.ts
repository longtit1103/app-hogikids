import { format } from "date-fns";
import * as XLSX from "xlsx";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Người gọi GIẢ cho cổng route — mỗi ca tự đặt quyền bằng `datNguoiDung`.
vi.mock("@/lib/quyen/nguoi-dung-phien", async (importActual) => {
  const that = await importActual<typeof import("@/lib/quyen/nguoi-dung-phien")>();
  const { nguoiDungGia } = await import("./helpers/nguoi-dung-gia");
  return { ...that, docNguoiDungPhien: vi.fn(async () => nguoiDungGia()) };
});

import { GET as xuatDonHang } from "@/app/api/export/don-hang/route";
import { prisma } from "@/lib/prisma";
import type { Quyen } from "@/lib/quyen/danh-muc-quyen";
import { docNguoiDungPhien } from "@/lib/quyen/nguoi-dung-phien";

import { nguoiDungGia } from "./helpers/nguoi-dung-gia";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * XUẤT EXCEL ĐƠN HÀNG QUA ROUTE SERVER: cổng `don-hang:xem` ∧ `xuat-du-lieu`; thiếu quyền giá vốn ⇒ file
 * không cột Giá vốn/Lãi đơn/Biên/Thiếu giá vốn VÀ bộ lọc/sắp xếp theo lãi bị bỏ (không suy được lãi qua
 * tập đơn). Gọi thẳng handler `GET` — không server, không cookie.
 *
 * Đơn dò: 2 cái × giá vốn 7.331.117 = 14.662.234, itemsTotal 240.000 ⇒ lãi −14.422.234. Hai số này chỉ
 * được xuất hiện ở file của người có quyền giá vốn.
 */

const ACTOR = "test-xuat-don-hang";
const GIA_VON_DOC = 7_331_117;
const COGS_DOC = 2 * GIA_VON_DOC; // 14.662.234
const LAI_DOC = 240_000 - COGS_DOC; // −14.422.234
const MA_DON_DO = "XD-DO";
const MA_DON_THIEU_GV = "XD-THIEU";

const CO_XEM_VA_XUAT: Quyen[] = ["don-hang:xem", "xuat-du-lieu"];
const req = (qs = "") => new Request(`http://localhost/api/export/don-hang${qs}`);

function datNguoiDung(p: { role?: "OWNER" | "STAFF"; quyen?: readonly Quyen[] } | null) {
  vi.mocked(docNguoiDungPhien).mockResolvedValue(
    p === null
      ? null
      : nguoiDungGia({ id: ACTOR, email: "xuat-don@hogikids.test", role: p.role ?? "STAFF", quyen: new Set(p.quyen ?? []) }),
  );
}

async function docSheet(res: Response): Promise<{ header: string[]; dong: Record<string, unknown>[] }> {
  const wb = XLSX.read(Buffer.from(await res.arrayBuffer()));
  expect(wb.SheetNames).toEqual(["Don hang"]);
  const ws = wb.Sheets["Don hang"];
  const header = (XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 })[0] ?? []) as string[];
  return { header, dong: XLSX.utils.sheet_to_json<Record<string, unknown>>(ws) };
}

const maDon = (dong: Record<string, unknown>[]) => dong.map((d) => d["Mã đơn"]).sort();

async function nhatKy(hanhDong: string) {
  return prisma.auditLog.findMany({ where: { actorId: ACTOR, hanhDong }, orderBy: { thoiDiem: "asc" } });
}

beforeAll(async () => {
  await seedReference();
  await truncateBusinessTables();
  const now = new Date();
  const product = await prisma.product.create({
    data: { pancakeId: "XD-P1", name: "Áo dò giá vốn", imageUrl: null, syncedAt: now },
  });
  const variant = await prisma.variant.create({
    data: {
      pancakeId: "XD-V1",
      productId: product.id,
      sku: "SKU-DO-GIA-VON",
      label: "90/Đỏ",
      sellPrice: 120_000,
      stock: 3,
      costPrice: GIA_VON_DOC,
      syncedAt: now,
    },
  });
  const donDo = await prisma.order.create({
    data: {
      pancakeId: "XD-ORD-1",
      code: MA_DON_DO,
      channelId: "shopee",
      status: "COMPLETED",
      orderedAt: now,
      itemsTotal: 240_000,
      platformFeeEst: 0,
      syncedAt: now,
    },
  });
  await prisma.orderItem.create({
    data: { orderId: donDo.id, variantId: variant.id, sku: "SKU-DO-GIA-VON", productName: "Áo dò giá vốn", quantity: 2, unitPrice: 120_000 },
  });
  // Đơn dòng hàng không khớp biến thể ⇒ "thiếu giá vốn" (để `loc=thieu_gv` có tập đơn khác đơn dò).
  const donThieu = await prisma.order.create({
    data: {
      pancakeId: "XD-ORD-2",
      code: MA_DON_THIEU_GV,
      channelId: "shopee",
      status: "COMPLETED",
      orderedAt: now,
      itemsTotal: 100_000,
      platformFeeEst: 0,
      syncedAt: now,
    },
  });
  await prisma.orderItem.create({
    data: { orderId: donThieu.id, variantId: null, sku: "SKU-LA", productName: "Hàng lạ", quantity: 1, unitPrice: 100_000 },
  });
}, 60_000);

beforeEach(async () => {
  await prisma.auditLog.deleteMany({ where: { actorId: ACTOR } });
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { actorId: ACTOR } });
  await truncateBusinessTables();
  await prisma.$disconnect();
});

describe("/api/export/don-hang — cổng quyền", () => {
  it("chưa đăng nhập ⇒ 401", async () => {
    datNguoiDung(null);
    expect((await xuatDonHang(req())).status).toBe(401);
  });

  it("có don-hang:xem nhưng thiếu xuat-du-lieu ⇒ 403 + nhật ký TU_CHOI_QUYEN, không XUAT_FILE", async () => {
    datNguoiDung({ quyen: ["don-hang:xem"] });
    const res = await xuatDonHang(req());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "KHONG_CO_QUYEN" });
    const loi = await nhatKy("TU_CHOI_QUYEN");
    expect(loi).toHaveLength(1);
    expect(loi[0].ghiChu).toEqual({ quyenThieu: "xuat-du-lieu" });
    expect(await nhatKy("XUAT_FILE")).toHaveLength(0);
  });

  it("thiếu don-hang:xem (chỉ xuat-du-lieu) ⇒ 403 ngay ở cổng", async () => {
    datNguoiDung({ quyen: ["xuat-du-lieu"] });
    expect((await xuatDonHang(req())).status).toBe(403);
    expect(await nhatKy("XUAT_FILE")).toHaveLength(0);
  });
});

describe("/api/export/don-hang — người không có quyền giá vốn", () => {
  it("200, header đúng 14 cột chung, không số lãi/giá vốn ở bất kỳ ô nào", async () => {
    datNguoiDung({ quyen: CO_XEM_VA_XUAT });
    const res = await xuatDonHang(req());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("spreadsheetml");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Disposition")).toContain(`don-hang-${format(new Date(), "yyyy-MM-dd")}.xlsx`);

    const { header, dong } = await docSheet(res);
    expect(header).toHaveLength(14);
    expect(header.filter((h) => /Giá vốn|Lãi|Biên/.test(h))).toEqual([]);
    expect(maDon(dong)).toEqual([MA_DON_DO, MA_DON_THIEU_GV].sort());

    const moiO = dong.flatMap((d) => Object.values(d));
    expect(moiO).not.toContain(COGS_DOC);
    expect(moiO).not.toContain(LAI_DOC);
    const json = JSON.stringify(dong);
    for (const doc of [GIA_VON_DOC, COGS_DOC, Math.abs(LAI_DOC)]) expect(json).not.toContain(String(doc));
  });

  it("`?loc=thieu_gv&sx=lai_thap` bị bỏ như trang ⇒ vẫn có đơn dò (và đơn kia)", async () => {
    datNguoiDung({ quyen: CO_XEM_VA_XUAT });
    const { dong } = await docSheet(await xuatDonHang(req("?loc=thieu_gv&sx=lai_thap")));
    expect(maDon(dong)).toEqual([MA_DON_DO, MA_DON_THIEU_GV].sort());
  });

  it("`?loc=lo` cũng bị bỏ", async () => {
    datNguoiDung({ quyen: CO_XEM_VA_XUAT });
    const { dong } = await docSheet(await xuatDonHang(req("?loc=lo")));
    expect(maDon(dong)).toContain(MA_DON_DO);
  });

  it("nhật ký XUAT_FILE loại don-hang với soDong đúng", async () => {
    datNguoiDung({ quyen: CO_XEM_VA_XUAT });
    await xuatDonHang(req());
    const ok = await nhatKy("XUAT_FILE");
    expect(ok).toHaveLength(1);
    expect(ok[0]).toMatchObject({ ketQua: "OK", ghiChu: { loaiBanGhi: "don-hang", soDong: 2 } });
  });
});

describe("/api/export/don-hang — chủ shop", () => {
  it("có cột Giá vốn, Lãi đơn = −14.422.234, Giá vốn = 14.662.234 (số, không chuỗi)", async () => {
    datNguoiDung({ role: "OWNER" });
    const { header, dong } = await docSheet(await xuatDonHang(req()));
    expect(header).toEqual(expect.arrayContaining(["Giá vốn", "Lãi đơn", "Biên %", "Thiếu giá vốn"]));
    expect(header).toHaveLength(18);
    const don = dong.find((d) => d["Mã đơn"] === MA_DON_DO);
    expect(don).toMatchObject({ "Giá vốn": COGS_DOC, "Lãi đơn": LAI_DOC });
    expect(don?.["Thiếu giá vốn"] ?? "").toBe(""); // ô rỗng được đọc lại là thiếu khoá
    expect(typeof don?.["Tiền hàng"]).toBe("number");
    const thieu = dong.find((d) => d["Mã đơn"] === MA_DON_THIEU_GV);
    expect(thieu).toMatchObject({ "Thiếu giá vốn": "Có" });
  });

  it("`?loc=thieu_gv` ⇒ KHÔNG có đơn dò, chỉ đơn thiếu giá vốn", async () => {
    datNguoiDung({ role: "OWNER" });
    const { dong } = await docSheet(await xuatDonHang(req("?loc=thieu_gv")));
    expect(maDon(dong)).toEqual([MA_DON_THIEU_GV]);
  });

  it("`?sx=lai_thap` ⇒ đơn lỗ nặng đứng đầu (thứ tự theo lãi)", async () => {
    datNguoiDung({ role: "OWNER" });
    const { dong } = await docSheet(await xuatDonHang(req("?sx=lai_thap")));
    expect(dong[0]["Mã đơn"]).toBe(MA_DON_DO);
  });

  it("bỏ qua `trang` và `don` — xuất đủ tập, không phân trang", async () => {
    datNguoiDung({ role: "OWNER" });
    const { dong } = await docSheet(await xuatDonHang(req("?trang=9&don=khong-co")));
    expect(dong).toHaveLength(2);
  });

  it("tham số lặp lấy giá trị ĐẦU như trang: `?loc=thieu_gv&loc=lo` ⇒ chỉ thieu_gv", async () => {
    datNguoiDung({ role: "OWNER" });
    const { dong } = await docSheet(await xuatDonHang(req("?loc=thieu_gv&loc=lo")));
    expect(maDon(dong)).toEqual([MA_DON_THIEU_GV]);
  });

  it("bộ lọc không khớp đơn nào ⇒ vẫn 200 với đủ header, 0 dòng", async () => {
    datNguoiDung({ role: "OWNER" });
    const { header, dong } = await docSheet(await xuatDonHang(req("?q=khong-ton-tai-xyz")));
    expect(header).toHaveLength(18);
    expect(dong).toHaveLength(0);
  });
});
