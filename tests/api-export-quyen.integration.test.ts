import { format } from "date-fns";
import * as XLSX from "xlsx";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Người gọi GIẢ cho cổng route — mỗi ca tự đặt quyền bằng `datNguoiDung`.
vi.mock("@/lib/quyen/nguoi-dung-phien", async (importActual) => {
  const that = await importActual<typeof import("@/lib/quyen/nguoi-dung-phien")>();
  const { nguoiDungGia } = await import("./helpers/nguoi-dung-gia");
  return { ...that, docNguoiDungPhien: vi.fn(async () => nguoiDungGia()) };
});

import { GET as xuatBaoCao } from "@/app/api/export/bao-cao/route";
import { GET as xuatGiaVon } from "@/app/api/export/gia-von/route";
import { GET as xuatSoQuy } from "@/app/api/export/so-quy/route";
import { GET as xuatTonKho } from "@/app/api/export/ton-kho/route";
import { prisma } from "@/lib/prisma";
import type { Quyen } from "@/lib/quyen/danh-muc-quyen";
import { docNguoiDungPhien } from "@/lib/quyen/nguoi-dung-phien";
import { VAI_TRO_MAU } from "@/lib/quyen/vai-tro-mau";

import { nguoiDungGia } from "./helpers/nguoi-dung-gia";
import { seedReference, truncateBusinessTables } from "./helpers/test-db";

/**
 * XUẤT FILE 100 % QUA ROUTE SERVER (spec phân quyền §4.3, §8.3 tầng 3): mỗi route mở bằng cổng module,
 * rồi đòi ĐỦ `xuat-du-lieu` (+ quyền trường); thiếu giá vốn ⇒ file không cột giá vốn (hoặc 403 khi file
 * vô nghĩa không có nó). Gọi thẳng handler `GET` — không server, không cookie.
 *
 * Giá vốn "độc" 7331117 chỉ nằm ở `Variant.costPrice` — file che không được chứa chuỗi đó ở đâu cả.
 */

const ACTOR = "test-xuat-file";
const GIA_VON_DOC = 7331117;
const NGAY = format(new Date(), "yyyy-MM-dd");
const KY = format(new Date(), "yyyy-MM");

function datNguoiDung(p: { role?: "OWNER" | "STAFF"; quyen?: readonly Quyen[] } | null) {
  vi.mocked(docNguoiDungPhien).mockResolvedValue(
    p === null
      ? null
      : nguoiDungGia({ id: ACTOR, email: "xuat@hogikids.test", role: p.role ?? "STAFF", quyen: new Set(p.quyen ?? []) }),
  );
}

const KHO = VAI_TRO_MAU.kho.quyen;
const req = (duongDan: string) => new Request(`http://localhost${duongDan}`);

function docXlsx(buf: ArrayBuffer): { tenSheet: string[]; dong: (s: string) => Record<string, unknown>[] } {
  const wb = XLSX.read(Buffer.from(buf));
  return { tenSheet: wb.SheetNames, dong: (s) => XLSX.utils.sheet_to_json(wb.Sheets[s]) };
}

async function nhatKy(hanhDong: string) {
  return prisma.auditLog.findMany({ where: { actorId: ACTOR, hanhDong }, orderBy: { thoiDiem: "asc" } });
}

beforeAll(async () => {
  await seedReference();
  await truncateBusinessTables();
  const now = new Date();
  const product = await prisma.product.create({
    data: { pancakeId: "XF-P1", name: "Áo dò giá vốn", imageUrl: null, syncedAt: now },
  });
  const variant = await prisma.variant.create({
    data: {
      pancakeId: "XF-V1",
      productId: product.id,
      sku: "SKU-DO-GIA-VON",
      label: "90/Đỏ",
      sellPrice: 250_000,
      stock: 3,
      costPrice: GIA_VON_DOC,
      syncedAt: now,
    },
  });
  const order = await prisma.order.create({
    data: {
      pancakeId: "XF-ORD-1",
      code: "XF1",
      channelId: "shopee",
      status: "COMPLETED",
      orderedAt: now,
      itemsTotal: 500_000,
      platformFeeEst: 50_000,
      syncedAt: now,
    },
  });
  await prisma.orderItem.create({
    data: { orderId: order.id, variantId: variant.id, sku: "SKU-DO-GIA-VON", productName: "Áo dò giá vốn", quantity: 2, unitPrice: 250_000 },
  });
  // Mở sổ quỹ trong tháng hiện tại (D0 = ngày của dòng tiền đầu tiên).
  await prisma.cashMovement.create({ data: { date: now, kind: "CAPITAL_IN", amount: 1_000_000, description: "Mở sổ" } });
}, 60_000);

beforeEach(async () => {
  await prisma.auditLog.deleteMany({ where: { actorId: ACTOR } });
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { actorId: ACTOR } });
  await truncateBusinessTables();
  await prisma.$disconnect();
});

describe("/api/export/ton-kho", () => {
  it("chưa đăng nhập ⇒ 401", async () => {
    datNguoiDung(null);
    expect((await xuatTonKho(req("/api/export/ton-kho"))).status).toBe(401);
  });

  it("(i) mẫu Kho (không xuat-du-lieu) ⇒ 403 + nhật ký TU_CHOI_QUYEN", async () => {
    datNguoiDung({ quyen: KHO });
    const res = await xuatTonKho(req("/api/export/ton-kho"));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "KHONG_CO_QUYEN" });
    const loi = await nhatKy("TU_CHOI_QUYEN");
    expect(loi).toHaveLength(1);
    expect(loi[0].ghiChu).toEqual({ quyenThieu: "xuat-du-lieu" });
  });

  it("thiếu quyền module (chỉ xuat-du-lieu) ⇒ 403 ngay ở cổng", async () => {
    datNguoiDung({ quyen: ["xuat-du-lieu"] });
    expect((await xuatTonKho(req("/api/export/ton-kho"))).status).toBe(403);
  });

  it("(ii) Kho + xuat-du-lieu ⇒ 200, CSV KHÔNG cột giá vốn, không giá vốn độc; nhật ký XUAT_FILE", async () => {
    datNguoiDung({ quyen: [...KHO, "xuat-du-lieu"] });
    const res = await xuatTonKho(req("/api/export/ton-kho"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const csv = (await res.text()).replace(/^﻿/, "");
    const [header, dong1] = csv.split("\n");
    expect(header).toBe("sku,ten_san_pham,bien_the,ton,nguong");
    expect(dong1).toContain("SKU-DO-GIA-VON");
    expect(csv).not.toContain(String(GIA_VON_DOC));
    const ok = await nhatKy("XUAT_FILE");
    expect(ok).toHaveLength(1);
    expect(ok[0]).toMatchObject({ ketQua: "OK", ghiChu: { loaiBanGhi: "ton-kho", soDong: 1 } });
  });

  it("(iii) OWNER ⇒ CSV có gia_von, gia_tri_von", async () => {
    datNguoiDung({ role: "OWNER" });
    const csv = await (await xuatTonKho(req("/api/export/ton-kho"))).text();
    expect(csv.replace(/^﻿/, "").split("\n")[0]).toBe("sku,ten_san_pham,bien_the,ton,nguong,gia_von,gia_tri_von");
    expect(csv).toContain(String(GIA_VON_DOC));
  });
});

describe("/api/export/gia-von", () => {
  it("(iv) san-pham:xem + xuat-du-lieu nhưng thiếu giá vốn ⇒ 403 (file vô nghĩa khi che)", async () => {
    datNguoiDung({ quyen: ["san-pham:xem", "xuat-du-lieu"] });
    expect((await xuatGiaVon()).status).toBe(403);
    expect(await nhatKy("XUAT_FILE")).toHaveLength(0);
  });

  it("giá vốn nhưng thiếu xuat-du-lieu ⇒ 403", async () => {
    datNguoiDung({ quyen: ["san-pham:xem", "gia-von-loi-nhuan:xem"] });
    expect((await xuatGiaVon()).status).toBe(403);
  });

  it("đủ 3 quyền ⇒ 200 xlsx có cột Giá vốn", async () => {
    datNguoiDung({ quyen: ["san-pham:xem", "gia-von-loi-nhuan:xem", "xuat-du-lieu"] });
    const res = await xuatGiaVon();
    expect(res.status).toBe(200);
    const { dong } = docXlsx(await res.arrayBuffer());
    expect(dong("Gia von")[0]).toMatchObject({ SKU: "SKU-DO-GIA-VON", "Giá vốn": GIA_VON_DOC });
  });
});

describe("/api/export/bao-cao", () => {
  const coBaoCao: Quyen[] = ["bao-cao:xem", "xuat-du-lieu"];

  // Lãi/Lỗ thuộc module Lãi/Lỗ (tab `/tai-chinh`), KHÔNG thuộc Báo cáo: `tab=pnl` đòi loi-lo ∧ giá vốn ∧
  // xuất, không đòi `bao-cao:xem`; `san-pham`/`xu-huong` vẫn đòi `bao-cao:xem` ∧ xuất.
  const coLoiLo: Quyen[] = ["tai-chinh-loi-lo:xem", "gia-von-loi-nhuan:xem", "xuat-du-lieu"];

  it("(v) chỉ bao-cao:xem + giá vốn + xuất ⇒ pnl 403 (thiếu tai-chinh-loi-lo:xem), san-pham 200", async () => {
    datNguoiDung({ quyen: [...coBaoCao, "gia-von-loi-nhuan:xem"] });
    const res = await xuatBaoCao(req(`/api/export/bao-cao?tab=pnl&ky=${KY}`));
    expect(res.status).toBe(403);
    const loi = await nhatKy("TU_CHOI_QUYEN");
    expect(loi).toHaveLength(1);
    expect(loi[0].ghiChu).toEqual({ quyenThieu: "tai-chinh-loi-lo:xem" });
    expect((await xuatBaoCao(req(`/api/export/bao-cao?tab=san-pham&tu=${NGAY}&den=${NGAY}`))).status).toBe(200);
  });

  it("chỉ tai-chinh-loi-lo:xem + giá vốn + xuất (không bao-cao:xem) ⇒ pnl 200; san-pham/xu-huong 403", async () => {
    datNguoiDung({ quyen: coLoiLo });
    const res = await xuatBaoCao(req(`/api/export/bao-cao?tab=pnl&ky=${KY}`));
    expect(res.status).toBe(200);
    expect(docXlsx(await res.arrayBuffer()).tenSheet).toEqual(["P&L"]);
    expect(await nhatKy("XUAT_FILE")).toHaveLength(1);
    expect((await xuatBaoCao(req(`/api/export/bao-cao?tab=san-pham&tu=${NGAY}&den=${NGAY}`))).status).toBe(403);
    expect((await xuatBaoCao(req("/api/export/bao-cao?tab=xu-huong"))).status).toBe(403);
    const loi = await nhatKy("TU_CHOI_QUYEN");
    expect(loi.map((d) => d.ghiChu)).toEqual([{ quyenThieu: "bao-cao:xem" }, { quyenThieu: "bao-cao:xem" }]);
  });

  it("tab=pnl thiếu giá vốn ⇒ 403; thiếu xuat-du-lieu ⇒ 403", async () => {
    datNguoiDung({ quyen: [...coBaoCao, "tai-chinh-loi-lo:xem"] });
    expect((await xuatBaoCao(req(`/api/export/bao-cao?tab=pnl&ky=${KY}`))).status).toBe(403);
    datNguoiDung({ quyen: ["tai-chinh-loi-lo:xem", "gia-von-loi-nhuan:xem"] });
    expect((await xuatBaoCao(req(`/api/export/bao-cao?tab=pnl&ky=${KY}`))).status).toBe(403);
  });

  it("không bao-cao:xem lẫn tai-chinh-loi-lo:xem ⇒ 403 ngay ở cổng, trước khi đọc tab", async () => {
    datNguoiDung({ quyen: ["gia-von-loi-nhuan:xem", "xuat-du-lieu"] });
    expect((await xuatBaoCao(req("/api/export/bao-cao?tab=khac"))).status).toBe(403);
  });

  it("OWNER tab=pnl ⇒ 200 sheet P&L; ky sai khuôn ⇒ 400; tab lạ ⇒ 400", async () => {
    datNguoiDung({ role: "OWNER" });
    const res = await xuatBaoCao(req(`/api/export/bao-cao?tab=pnl&ky=${KY}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain(`hogikids-pnl-${KY}.xlsx`);
    expect(docXlsx(await res.arrayBuffer()).tenSheet).toEqual(["P&L"]);
    expect((await xuatBaoCao(req("/api/export/bao-cao?tab=pnl&ky=2026-13"))).status).toBe(400);
    expect((await xuatBaoCao(req("/api/export/bao-cao?tab=khac"))).status).toBe(400);
  });

  it("tab=san-pham thiếu giá vốn ⇒ 200, không cột COGS/LN gộp/Biên, không giá vốn độc", async () => {
    datNguoiDung({ quyen: coBaoCao });
    const res = await xuatBaoCao(req(`/api/export/bao-cao?tab=san-pham&tu=${NGAY}&den=${NGAY}`));
    expect(res.status).toBe(200);
    const { tenSheet, dong } = docXlsx(await res.arrayBuffer());
    expect(tenSheet).toEqual(["Sản phẩm", "SKU"]);
    const sp = dong("Sản phẩm");
    expect(sp).toHaveLength(1);
    expect(Object.keys(sp[0]).sort()).toEqual(["Doanh thu", "SL bán", "Sản phẩm", "Tồn"].sort());
    expect(JSON.stringify([sp, dong("SKU")])).not.toMatch(/COGS|LN gộp|Biên/);
  });

  it("tab=san-pham OWNER ⇒ có cột COGS (đối chứng)", async () => {
    datNguoiDung({ role: "OWNER" });
    const res = await xuatBaoCao(req(`/api/export/bao-cao?tab=san-pham&tu=${NGAY}&den=${NGAY}`));
    const sp = docXlsx(await res.arrayBuffer()).dong("Sản phẩm");
    expect(sp[0]).toMatchObject({ COGS: 2 * GIA_VON_DOC });
  });

  it("tab=xu-huong thiếu giá vốn ⇒ 200, không cột LN ròng/Biên/Thu nhập tài chính", async () => {
    datNguoiDung({ quyen: coBaoCao });
    const res = await xuatBaoCao(req("/api/export/bao-cao?tab=xu-huong"));
    expect(res.status).toBe(200);
    const dong = docXlsx(await res.arrayBuffer()).dong("Xu hướng");
    expect(dong).toHaveLength(12);
    expect(Object.keys(dong[dong.length - 1])).not.toEqual(expect.arrayContaining(["LN ròng"]));
    expect(JSON.stringify(dong)).not.toMatch(/LN ròng|Biên|Thu nhập tài chính/);
  });
});

describe("/api/export/so-quy", () => {
  it("thiếu xuat-du-lieu ⇒ 403; thiếu module ⇒ 403", async () => {
    datNguoiDung({ quyen: ["tai-chinh-so-quy:xem"] });
    expect((await xuatSoQuy(req(`/api/export/so-quy?ky=${KY}`))).status).toBe(403);
    datNguoiDung({ quyen: ["xuat-du-lieu", "tai-chinh-dong-tien:xem"] });
    expect((await xuatSoQuy(req(`/api/export/so-quy?ky=${KY}`))).status).toBe(403);
  });

  it("(vi) tai-chinh-so-quy:xem + xuat-du-lieu ⇒ 200 có sheet Sổ quỹ; kỳ trước mở sổ ⇒ 404; ky sai ⇒ 400", async () => {
    datNguoiDung({ quyen: ["tai-chinh-so-quy:xem", "xuat-du-lieu"] });
    const res = await xuatSoQuy(req(`/api/export/so-quy?ky=${KY}`));
    expect(res.status).toBe(200);
    const { tenSheet, dong } = docXlsx(await res.arrayBuffer());
    expect(tenSheet).toEqual(["Sổ quỹ"]);
    expect(dong("Sổ quỹ").length).toBeGreaterThan(0);
    expect(await nhatKy("XUAT_FILE")).toHaveLength(1);

    expect((await xuatSoQuy(req("/api/export/so-quy?ky=2001-01"))).status).toBe(404);
    expect((await xuatSoQuy(req("/api/export/so-quy?ky=abc"))).status).toBe(400);
  });
});
