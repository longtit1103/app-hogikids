import { randomUUID } from "node:crypto";

import { addDays, format } from "date-fns";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { Prisma } from "@/generated/prisma/client";
import { docPhieuConNo, khoaCacPhieu, vanTayPhieuConNo } from "@/lib/no-phai-tra/phieu-nhap-no-queries";
import { prisma } from "@/lib/prisma";
import { docNguoiDungPhien } from "@/lib/quyen/nguoi-dung-phien";

import { nguoiDungGia } from "../../helpers/nguoi-dung-gia";
import { datMocM, donFixtureNoPhaiTra, taoPhieuNo, vn } from "../../helpers/phieu-nhap-no-fixture";
import { seedReference, truncateBusinessTables } from "../../helpers/test-db";

/**
 * `traTienHangGop` trên DB thật (`hogikids_test`) — spec §5.3 sáu bước, phase-03 Bước 3 ca (a)–(h).
 * Số theo spec §6 (triệu): #1 tổng 20; #2 tổng 100 đã trả trước 10 ⇒ còn 90. Trả gộp 50 = #1 23
 * (thừa 3) + #2 27 ⇒ #1 −3 · #2 63. M = 01/10/2026 (trong quá khứ so với ngày chạy).
 */

vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => {
  const { nguoiDungGia: gia } = await import("../../helpers/nguoi-dung-gia");
  return {
    ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
    docNguoiDungPhien: vi.fn(async () => gia()),
  };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { traTienHangGop } = await import("@/lib/actions/tra-tien-hang");

const TR = 1_000_000;
const M = "2026-10-01";
const NGAY = "2026-10-05";

let p1 = "";
let p2 = "";

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  vi.mocked(docNguoiDungPhien).mockImplementation(async () => nguoiDungGia());
  await truncateBusinessTables();
  await donFixtureNoPhaiTra();
  await datMocM(M);
  p1 = await taoPhieuNo({ uuid: "u-1", maPhieu: "#1", ngayPhieu: vn("2026-09-10T00:00:00"), tongTien: 20 * TR });
  p2 = await taoPhieuNo({ uuid: "u-2", maPhieu: "#2", ngayPhieu: vn("2026-09-20T00:00:00"), tongTien: 100 * TR, daTraTruoc: 10 * TR });
});

afterAll(async () => {
  await truncateBusinessTables();
  await donFixtureNoPhaiTra();
  await prisma.$disconnect();
});

const vanTayHienTai = async () => vanTayPhieuConNo(await docPhieuConNo());
const demDong = () => prisma.cashMovement.count({ where: { kind: "SUPPLIER_PAY" } });

async function yeuCau50(ghiDe: Record<string, unknown> = {}) {
  return {
    yeuCauId: randomUUID(),
    vanTay: await vanTayHienTai(),
    ngay: NGAY,
    tong: 50 * TR,
    phanBo: [
      { phieuNhapId: p1, soTien: 23 * TR },
      { phieuNhapId: p2, soTien: 27 * TR },
    ],
    ...ghiDe,
  };
}

async function conNo(): Promise<Record<string, number>> {
  return Object.fromEntries((await docPhieuConNo()).map((r) => [r.id, r.conNo]));
}

describe("traTienHangGop", () => {
  it("(a) Σ phân bổ ≠ tổng ⇒ zod ô phanBo, không ghi gì (cả YeuCauGhi)", async () => {
    const res = await traTienHangGop(await yeuCau50({ tong: 51 * TR }));
    expect(res).toMatchObject({ ok: false, field: "phanBo", error: "Tổng phân bổ phải bằng số tiền trả" });
    expect(await demDong()).toBe(0);
    expect(await prisma.yeuCauGhi.count()).toBe(0);
  });

  it("phần phân bổ 0 / phiếu trùng ⇒ từ chối", async () => {
    const r0 = await traTienHangGop(
      await yeuCau50({ tong: 23 * TR, phanBo: [{ phieuNhapId: p1, soTien: 23 * TR }, { phieuNhapId: p2, soTien: 0 }] }),
    );
    expect(r0).toMatchObject({ ok: false, field: "phanBo" });
    const trung = await traTienHangGop(
      await yeuCau50({ phanBo: [{ phieuNhapId: p1, soTien: 25 * TR }, { phieuNhapId: p1, soTien: 25 * TR }] }),
    );
    expect(trung).toMatchObject({ ok: false, error: "Mỗi phiếu chỉ một dòng phân bổ" });
    expect(await demDong()).toBe(0);
  });

  it("(b) 50 = 23 + 27 ⇒ 2 dòng cùng yeuCauId, mô tả mặc định, #1 −3 (trả thừa không bị chặn) · #2 63", async () => {
    const yc = await yeuCau50();
    const res = await traTienHangGop(yc);
    expect(res).toEqual({ ok: true, data: { daGhi: 2, tong: 50 * TR } });

    const dong = await prisma.cashMovement.findMany({ where: { kind: "SUPPLIER_PAY" }, orderBy: { amount: "asc" } });
    expect(dong.map((d) => [d.phieuNhapId, d.amount, d.yeuCauId])).toEqual([
      [p1, 23 * TR, yc.yeuCauId],
      [p2, 27 * TR, yc.yeuCauId],
    ]);
    expect(dong.every((d) => d.description === "Trả tiền hàng đợt 05/10")).toBe(true);
    expect(format(dong[0].date, "yyyy-MM-dd HH:mm")).toBe("2026-10-05 00:00");
    expect(await conNo()).toEqual({ [p1]: -3 * TR, [p2]: 63 * TR });

    const yeuCau = await prisma.yeuCauGhi.findUniqueOrThrow({ where: { id: yc.yeuCauId } });
    expect(yeuCau).toMatchObject({ loai: "TRA_GOP_NCC", ketQua: { ok: true, data: { daGhi: 2, tong: 50 * TR } } });
    expect(await prisma.auditLog.count({ where: { hanhDong: "DONG_TIEN_TAO", ketQua: "OK" } })).toBeGreaterThanOrEqual(1);
  });

  it("mô tả: khoảng trắng ⇒ câu mặc định; có chữ ⇒ cắt khoảng trắng hai đầu", async () => {
    expect((await traTienHangGop(await yeuCau50({ moTa: "   " }))).ok).toBe(true);
    expect((await traTienHangGop(await yeuCau50({ moTa: "  Chuyển khoản NCC A  " }))).ok).toBe(true);
    const moTa = (await prisma.cashMovement.findMany({ where: { kind: "SUPPLIER_PAY" }, select: { description: true } })).map(
      (d) => d.description,
    );
    expect(moTa.sort()).toEqual(["Chuyển khoản NCC A", "Chuyển khoản NCC A", "Trả tiền hàng đợt 05/10", "Trả tiền hàng đợt 05/10"]);
  });

  it("(c) gửi lại cùng mã + cùng nội dung ⇒ DA_GHI_ROI, kết quả cũ, không thêm dòng", async () => {
    const yc = await yeuCau50();
    expect((await traTienHangGop(yc)).ok).toBe(true);
    const lan2 = await traTienHangGop(yc);
    expect(lan2).toEqual({ ok: true, data: { daGhi: 2, tong: 50 * TR }, code: "DA_GHI_ROI" });
    expect(await demDong()).toBe(2);
  });

  it("(c') gửi lại cùng mã sau khi tải lại (vân tay danh sách đã khác) ⇒ vẫn DA_GHI_ROI", async () => {
    const yc = await yeuCau50();
    expect((await traTienHangGop(yc)).ok).toBe(true);
    const lan2 = await traTienHangGop({ ...yc, vanTay: await vanTayHienTai() });
    expect(lan2).toMatchObject({ ok: true, code: "DA_GHI_ROI" });
    expect(await demDong()).toBe(2);
  });

  it("(d) cùng mã, khác nội dung ⇒ từ chối, không thêm dòng", async () => {
    const yc = await yeuCau50();
    expect((await traTienHangGop(yc)).ok).toBe(true);
    const khac = await traTienHangGop({
      ...yc,
      tong: 51 * TR,
      phanBo: [
        { phieuNhapId: p1, soTien: 24 * TR },
        { phieuNhapId: p2, soTien: 27 * TR },
      ],
    });
    expect(khac).toMatchObject({
      ok: false,
      code: "YEU_CAU_KHAC_NOI_DUNG",
      error: "Mã yêu cầu này đã dùng cho một lượt trả khác đã ghi — kiểm tra danh sách trước khi trả thêm",
    });
    expect(await demDong()).toBe(2);
  });

  it("phân bổ có phiếu đã huỷ ⇒ PHIEU_DA_HUY, không ghi gì (kể cả YeuCauGhi)", async () => {
    const p3 = await taoPhieuNo({ uuid: "u-3", maPhieu: "#3", tongTien: 20 * TR, daHuy: true });
    const res = await traTienHangGop(
      await yeuCau50({
        tong: 10 * TR,
        phanBo: [
          { phieuNhapId: p1, soTien: 5 * TR },
          { phieuNhapId: p3, soTien: 5 * TR },
        ],
      }),
    );
    expect(res).toMatchObject({ ok: false, code: "PHIEU_DA_HUY", field: "phanBo" });
    expect(res.ok ? "" : res.error).toContain("#3");
    expect(await demDong()).toBe(0);
    expect(await prisma.yeuCauGhi.count()).toBe(0);
  });

  it("cùng mã, cùng tổng, CHỈ đổi phân bổ (23/27 → 27/23) ⇒ YEU_CAU_KHAC_NOI_DUNG — phân bổ nằm trong vân tay nội dung", async () => {
    const yc = await yeuCau50();
    expect((await traTienHangGop(yc)).ok).toBe(true);
    const khac = await traTienHangGop({
      ...yc,
      phanBo: [
        { phieuNhapId: p1, soTien: 27 * TR },
        { phieuNhapId: p2, soTien: 23 * TR },
      ],
    });
    expect(khac).toMatchObject({ ok: false, code: "YEU_CAU_KHAC_NOI_DUNG" });
    expect(await demDong()).toBe(2);
    expect(await conNo()).toEqual({ [p1]: -3 * TR, [p2]: 63 * TR });
  });

  it("(e) xoá 1 dòng tiền rồi gửi lại ⇒ vẫn DA_GHI_ROI (YeuCauGhi bền), không ghi bù", async () => {
    const yc = await yeuCau50();
    expect((await traTienHangGop(yc)).ok).toBe(true);
    const mot = await prisma.cashMovement.findFirstOrThrow({ where: { kind: "SUPPLIER_PAY", phieuNhapId: p1 } });
    await prisma.cashMovement.delete({ where: { id: mot.id } });

    expect(await traTienHangGop(yc)).toMatchObject({ ok: true, code: "DA_GHI_ROI" });
    expect(await demDong()).toBe(1);
  });

  it("(f) hai lượt khác mã, CÙNG vân tay, cùng phiếu, lượt 2 gửi SAU khi lượt 1 commit ⇒ lượt 2 DANH_SACH_DA_DOI; vân tay mới ⇒ thành công", async () => {
    const vt = await vanTayHienTai();
    const a = await yeuCau50({ vanTay: vt });
    const b = await yeuCau50({ vanTay: vt });
    expect(await traTienHangGop(a)).toEqual({ ok: true, data: { daGhi: 2, tong: 50 * TR } });
    expect(await traTienHangGop(b)).toMatchObject({ ok: false, code: "DANH_SACH_DA_DOI" });
    expect(await demDong()).toBe(2);
    // Lượt thua lùi trọn — kể cả dòng YeuCauGhi của nó.
    expect(await prisma.yeuCauGhi.count()).toBe(1);

    // Lượt sau lấy vân tay MỚI (sau lần trả đầu) rồi gửi ⇒ thành công, tổng 4 dòng.
    const lai = await traTienHangGop({ ...b, vanTay: await vanTayHienTai() });
    expect(lai).toEqual({ ok: true, data: { daGhi: 2, tong: 50 * TR } });
    expect(await demDong()).toBe(4);
  });

  /**
   * Khoá TẤT ĐỊNH: tx khác giữ khoá #1 (giả một đợt trả ở tab khác), ngủ 0,8s, ghi `SUPPLIER_PAY` 5 rồi
   * commit. Trả gộp với vân tay CŨ phải chờ khoá, tính vân tay SAU commit ⇒ thấy #1 đã đổi ⇒ từ chối.
   * Thiếu `khoaCacPhieu` ⇒ đọc trước commit (READ COMMITTED) ⇒ vân tay khớp ⇒ ghi trên số còn nợ đã cũ.
   */
  it("tx khác giữ khoá phiếu 0,8s rồi trả 5 ⇒ trả gộp chờ ≥ 0,7s, vân tay tính sau commit ⇒ DANH_SACH_DA_DOI", async () => {
    const yc = await yeuCau50();
    let daGiu!: () => void;
    const giuXong = new Promise<void>((r) => (daGiu = r));
    const giu = prisma.$transaction(
      async (tx) => {
        await khoaCacPhieu(tx, [p1]);
        daGiu();
        await new Promise((r) => setTimeout(r, 800));
        await tx.cashMovement.create({
          data: { date: vn("2026-10-05T00:00:00"), kind: "SUPPLIER_PAY", amount: 5 * TR, phieuNhapId: p1, description: "tab khác" },
        });
      },
      { timeout: 20_000 },
    );
    await giuXong;
    const batDau = Date.now();
    const res = await traTienHangGop(yc);
    const choMs = Date.now() - batDau;
    await giu;

    expect(choMs).toBeGreaterThanOrEqual(700);
    expect(res).toMatchObject({ ok: false, code: "DANH_SACH_DA_DOI" });
    expect(await demDong()).toBe(1);
    expect(await prisma.yeuCauGhi.findUnique({ where: { id: yc.yeuCauId } })).toBeNull();
  });

  it("(g) vân tay cũ (phiếu vừa được trả ở tab khác) ⇒ DANH_SACH_DA_DOI, YeuCauGhi KHÔNG tồn tại sau đó", async () => {
    const cu = await yeuCau50();
    // Tab khác trả #1 trước.
    expect(
      (
        await traTienHangGop({
          yeuCauId: randomUUID(),
          vanTay: cu.vanTay,
          ngay: NGAY,
          tong: 5 * TR,
          phanBo: [{ phieuNhapId: p1, soTien: 5 * TR }],
        })
      ).ok,
    ).toBe(true);

    expect(await traTienHangGop(cu)).toMatchObject({ ok: false, code: "DANH_SACH_DA_DOI" });
    expect(await prisma.yeuCauGhi.findUnique({ where: { id: cu.yeuCauId } })).toBeNull();
    expect(await demDong()).toBe(1);
  });

  it("(h) ngày trước M ⇒ từ chối ô ngay; ngày mai ⇒ từ chối ô ngay", async () => {
    const truocM = await traTienHangGop(await yeuCau50({ ngay: "2026-09-30" }));
    expect(truocM).toMatchObject({ ok: false, field: "ngay", error: "Trước ngày bật theo dõi nợ (01/10/2026)" });
    const ngayMai = await traTienHangGop(await yeuCau50({ ngay: format(addDays(new Date(), 1), "yyyy-MM-dd") }));
    expect(ngayMai).toMatchObject({ ok: false, field: "ngay", error: "Không cho ngày tương lai" });
    expect(await demDong()).toBe(0);
  });

  it("phiếu không có trong sổ ⇒ DANH_SACH_DA_DOI, không ghi gì", async () => {
    const res = await traTienHangGop(
      await yeuCau50({ tong: 5 * TR, phanBo: [{ phieuNhapId: "cl-khong-co-phieu", soTien: 5 * TR }] }),
    );
    expect(res).toMatchObject({ ok: false, code: "DANH_SACH_DA_DOI" });
    expect(await demDong()).toBe(0);
    expect(await prisma.yeuCauGhi.count()).toBe(0);
  });

  it("YeuCauGhi cũ cùng nội dung mà ketQua NULL ⇒ ném 'yêu cầu chưa hoàn tất', không ghi", async () => {
    const yc = await yeuCau50();
    expect((await traTienHangGop(yc)).ok).toBe(true);
    await prisma.yeuCauGhi.update({ where: { id: yc.yeuCauId }, data: { ketQua: Prisma.DbNull } });

    const res = await traTienHangGop(yc);
    expect(res).toMatchObject({ ok: false, code: "YEU_CAU_CHUA_HOAN_TAT" });
    expect(await demDong()).toBe(2);
  });

  it("chưa bật (M null) ⇒ CHUA_BAT_NO_PHAI_TRA, không ghi gì", async () => {
    await datMocM(null);
    const res = await traTienHangGop(await yeuCau50());
    expect(res).toMatchObject({ ok: false, code: "CHUA_BAT_NO_PHAI_TRA" });
    expect(await demDong()).toBe(0);
    expect(await prisma.yeuCauGhi.count()).toBe(0);
  });

  it("nhân sự không có tai-chinh-so-quy:sua ⇒ KHONG_CO_QUYEN", async () => {
    vi.mocked(docNguoiDungPhien).mockImplementation(async () =>
      nguoiDungGia({ role: "STAFF", quyen: new Set(["tai-chinh-dong-tien:sua"]) }),
    );
    expect(await traTienHangGop(await yeuCau50())).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
    expect(await demDong()).toBe(0);
  });
});
