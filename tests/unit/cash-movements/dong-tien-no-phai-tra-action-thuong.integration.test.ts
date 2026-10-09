import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Action ghi tay THƯỜNG (`cash-movements.ts`) với 4 loại nợ phải trả (`CARD_PAY`, `SUPPLIER_PAY`,
 * `SUPPLIER_REFUND`, `ADS_TOPUP`) trên DB thật (`hogikids_test`). Mốc M = 01/11/2026, "hôm nay" ghim
 * 26/11/2026 bằng fake timer CHỈ cho `Date`.
 *
 * Bốn cổng phải giữ (spec §5.3, §5.4, §5.7, §5.8): chưa bật ⇒ `CHUA_BAT_NO_PHAI_TRA`; ngày < M ⇒ từ chối;
 * thẻ đóng / trả vào phiếu huỷ ⇒ từ chối (hoàn tiền phiếu huỷ thì được); khoá hồ sơ cha CẢ cũ lẫn mới
 * khi sửa. `CUTOVER_*` không bao giờ qua đường thường.
 */
vi.mock("@/lib/quyen/nguoi-dung-phien", async (goc) => ({
  ...(await goc<typeof import("@/lib/quyen/nguoi-dung-phien")>()),
  docNguoiDungPhien: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import type { Prisma } from "@/generated/prisma/client";
import {
  createCashMovement,
  deleteCashMovement,
  suaDieuChinhChuyenDoi,
  updateCashMovement,
} from "@/lib/actions/cash-movements";
import { capNhatDaTraTruoc } from "@/lib/actions/phieu-nhap-no";
import { KEY_NO_PHAI_TRA_TU_NGAY } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { docPhieuTheoId } from "@/lib/no-phai-tra/phieu-nhap-no-queries";
import { khoaThe } from "@/lib/no-phai-tra/the-tin-dung-queries";
import { prisma } from "@/lib/prisma";
import { docNguoiDungPhien } from "@/lib/quyen/nguoi-dung-phien";

import { nguoiDungGia } from "../../helpers/nguoi-dung-gia";
import { seedReference, truncateBusinessTables } from "../../helpers/test-db";

const vn = (ngay: string, gio = "00:00:00") => new Date(`${ngay}T${gio}+07:00`);
const tr = (n: number) => Math.round(n * 1_000_000);

async function batM(ngay = "2026-11-01") {
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
  await prisma.setting.create({ data: { key: KEY_NO_PHAI_TRA_TU_NGAY, value: ngay } });
}

async function taoThe(ten = "Thẻ A"): Promise<string> {
  const id = (await prisma.theTinDung.create({ data: { ten, ngayChotSaoKe: 25, ngayHanTra: 10 } })).id;
  await prisma.kySaoKeThe.create({ data: { cardId: id, ngayChot: vn("2026-10-31"), soDu: 0, laNeoMoSo: true } });
  return id;
}

async function taoPhieu(daHuy = false): Promise<string> {
  return (
    await prisma.phieuNhapNo.create({
      data: {
        refId: `PANCAKE_PO:${Math.random()}`,
        shopId: "714995134",
        maPhieu: "PN-1",
        ngayPhieu: vn("2026-11-02"),
        tongTien: tr(20),
        daHuy,
      },
    })
  ).id;
}

const traThe = (cardId: string, date = "2026-11-20", amount = tr(3)) => ({
  date: vn(date),
  kind: "CARD_PAY",
  amount,
  description: "Trả sao kê",
  cardId,
});

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
  vi.mocked(docNguoiDungPhien).mockResolvedValue(nguoiDungGia());
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(vn("2026-11-26", "10:00:00"));
});

afterEach(async () => {
  vi.useRealTimers();
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

describe("tạo dòng nợ phải trả qua action thường", () => {
  it("CARD_PAY trước khi bật ⇒ CHUA_BAT_NO_PHAI_TRA, không dòng nào", async () => {
    const cardId = await taoThe();
    const res = await createCashMovement(traThe(cardId));
    expect(res).toMatchObject({ ok: false, code: "CHUA_BAT_NO_PHAI_TRA" });
    expect(await prisma.cashMovement.count()).toBe(0);
  });

  it("sau bật: ngày < M ⇒ từ chối ô ngày; ngày ∈ [M, hôm nay] ⇒ ghi, giữ cardId", async () => {
    await batM();
    const cardId = await taoThe();
    expect(await createCashMovement(traThe(cardId, "2026-10-31"))).toMatchObject({
      ok: false,
      field: "date",
      error: "Trước ngày bật theo dõi nợ (01/11/2026)",
    });
    expect(await createCashMovement(traThe(cardId, "2026-11-01"))).toEqual({ ok: true, data: undefined });
    const dong = await prisma.cashMovement.findFirstOrThrow();
    expect(dong).toMatchObject({ kind: "CARD_PAY", cardId, phieuNhapId: null, viAdsId: null, amount: tr(3) });
  });

  it("CARD_PAY thiếu thẻ ⇒ zod 'Chọn thẻ'; kèm phieuNhapId lạc ⇒ bị cắt về null", async () => {
    await batM();
    const cardId = await taoThe();
    const phieuNhapId = await taoPhieu();
    expect(await createCashMovement({ ...traThe(cardId), cardId: null })).toEqual({
      ok: false,
      field: "cardId",
      error: "Chọn thẻ",
    });
    expect(await createCashMovement({ ...traThe(cardId), phieuNhapId })).toEqual({ ok: true, data: undefined });
    expect((await prisma.cashMovement.findFirstOrThrow()).phieuNhapId).toBeNull();
  });

  it("thẻ đã đóng ⇒ THE_DA_DONG", async () => {
    await batM();
    const cardId = await taoThe();
    await prisma.theTinDung.update({ where: { id: cardId }, data: { closedAt: vn("2026-11-20") } });
    expect(await createCashMovement(traThe(cardId))).toMatchObject({ ok: false, code: "THE_DA_DONG", field: "cardId" });
    expect(await prisma.cashMovement.count()).toBe(0);
  });

  it("SUPPLIER_PAY vào phiếu đã huỷ ⇒ PHIEU_DA_HUY; SUPPLIER_REFUND vào phiếu huỷ ⇒ ghi được", async () => {
    await batM();
    const phieuNhapId = await taoPhieu(true);
    // Đã trả trước M 5tr ⇒ trần hoàn = 5tr (hoàn không vượt số đã trả — xem khối trần hoàn tiền).
    await prisma.phieuNhapNo.update({ where: { id: phieuNhapId }, data: { daTraTruoc: tr(5) } });
    const dong = (kind: string) => ({ date: vn("2026-11-20"), kind, amount: tr(5), description: "", phieuNhapId });
    expect(await createCashMovement(dong("SUPPLIER_PAY"))).toMatchObject({ ok: false, code: "PHIEU_DA_HUY" });
    expect(await createCashMovement(dong("SUPPLIER_REFUND"))).toEqual({ ok: true, data: undefined });
    expect(await prisma.cashMovement.findMany({ select: { kind: true } })).toEqual([{ kind: "SUPPLIER_REFUND" }]);
  });

  it("ADS_TOPUP bắt buộc ví; nạp bằng thẻ giữ cả hai khoá; ngày ≤ ngày neo ví ⇒ từ chối", async () => {
    await batM();
    const cardId = await taoThe();
    const viAdsId = (
      await prisma.viAdsTraTruoc.create({ data: { nenTang: "SHOPEE_ADS", soDuNeo: 0, ngayNeo: vn("2026-11-05", "23:59:59") } })
    ).id;
    const nap = (date: string, extra: object = {}) => ({
      date: vn(date),
      kind: "ADS_TOPUP",
      amount: tr(10),
      description: "",
      ...extra,
    });
    expect(await createCashMovement(nap("2026-11-10"))).toMatchObject({ ok: false, field: "viAdsId" });
    expect(await createCashMovement(nap("2026-11-05", { viAdsId }))).toMatchObject({ ok: false, code: "TRUOC_NGAY_NEO_VI" });
    expect(await createCashMovement(nap("2026-11-10", { viAdsId, cardId }))).toEqual({ ok: true, data: undefined });
    expect(await prisma.cashMovement.findFirstOrThrow()).toMatchObject({ kind: "ADS_TOPUP", viAdsId, cardId });
  });

  it("CUTOVER_* không bao giờ qua action thường (zod ô kind)", async () => {
    await batM();
    for (const kind of ["CUTOVER_ADJ_IN", "CUTOVER_ADJ_OUT"]) {
      expect(
        await createCashMovement({ date: vn("2026-11-01"), kind, amount: tr(1), description: "Điều chỉnh" }),
      ).toEqual({ ok: false, field: "kind", error: "Chọn loại khoản" });
    }
  });

  it("thiếu quyền Sổ quỹ ⇒ từ chối dù có quyền dòng tiền", async () => {
    await batM();
    const cardId = await taoThe();
    vi.mocked(docNguoiDungPhien).mockResolvedValue(
      nguoiDungGia({ role: "STAFF", quyen: new Set(["tai-chinh-dong-tien:sua"]) as never }),
    );
    expect(await createCashMovement(traThe(cardId))).toMatchObject({ ok: false, code: "KHONG_CO_QUYEN" });
  });
});

describe("sửa / xoá dòng nợ phải trả", () => {
  it("đổi nhóm loại CAPITAL_IN ⇄ CARD_PAY ⇒ DOI_NHOM_LOAI", async () => {
    await batM();
    const cardId = await taoThe();
    const thuong = await prisma.cashMovement.create({
      data: { date: vn("2026-11-20"), kind: "CAPITAL_IN", amount: tr(1), description: "" },
    });
    expect(await updateCashMovement(thuong.id, traThe(cardId))).toMatchObject({ ok: false, code: "DOI_NHOM_LOAI" });
    const no = await prisma.cashMovement.create({
      data: { date: vn("2026-11-20"), kind: "CARD_PAY", amount: tr(1), description: "", cardId },
    });
    expect(
      await updateCashMovement(no.id, { date: vn("2026-11-20"), kind: "CAPITAL_IN", amount: tr(1), description: "" }),
    ).toMatchObject({ ok: false, code: "DOI_NHOM_LOAI" });
  });

  it("sửa CARD_PAY đổi số + sang thẻ B; sửa lùi ngày < M ⇒ từ chối", async () => {
    await batM();
    const a = await taoThe("Thẻ A");
    const b = await taoThe("Thẻ B");
    await createCashMovement(traThe(a));
    const dong = await prisma.cashMovement.findFirstOrThrow();
    expect(await updateCashMovement(dong.id, traThe(b, "2026-11-21", tr(4)))).toEqual({ ok: true, data: undefined });
    expect(await prisma.cashMovement.findUniqueOrThrow({ where: { id: dong.id } })).toMatchObject({
      cardId: b,
      amount: tr(4),
    });
    expect(await updateCashMovement(dong.id, traThe(b, "2026-10-30"))).toMatchObject({ ok: false, field: "date" });
  });

  it("sửa CARD_PAY khoá CẢ thẻ cũ: lượt đóng thẻ A đang giữ khoá ⇒ lượt chuyển A→B chờ rồi thấy A đã đóng", async () => {
    await batM();
    const a = await taoThe("Thẻ A");
    const b = await taoThe("Thẻ B");
    await createCashMovement(traThe(a));
    const dong = await prisma.cashMovement.findFirstOrThrow();

    let tha!: () => void;
    const cho = new Promise<void>((res) => (tha = res));
    let daGiu!: () => void;
    const giuXong = new Promise<void>((res) => (daGiu = res));
    const giu = prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        await khoaThe(tx, a);
        await tx.theTinDung.update({ where: { id: a }, data: { closedAt: vn("2026-11-26") } });
        daGiu();
        await cho;
      },
      { timeout: 20_000 },
    );
    await giuXong;
    const t0 = performance.now();
    const p = updateCashMovement(dong.id, traThe(b)).then((r) => ({ r, ms: performance.now() - t0 }));
    await new Promise((res) => setTimeout(res, 800));
    tha();
    await giu;
    const { r, ms } = await p;
    expect(ms).toBeGreaterThan(600);
    expect(r).toMatchObject({ ok: false, code: "THE_DA_DONG" });
    expect((await prisma.cashMovement.findUniqueOrThrow({ where: { id: dong.id } })).cardId).toBe(a);
  });

  it("xoá CARD_PAY ⇒ chụp thùng rác kèm cardId; thẻ đóng ⇒ không xoá được", async () => {
    await batM();
    const cardId = await taoThe();
    await createCashMovement(traThe(cardId));
    const dong = await prisma.cashMovement.findFirstOrThrow();
    await prisma.theTinDung.update({ where: { id: cardId }, data: { closedAt: vn("2026-11-25") } });
    expect(await deleteCashMovement(dong.id)).toMatchObject({ ok: false, code: "THE_DA_DONG" });
    await prisma.theTinDung.update({ where: { id: cardId }, data: { closedAt: null } });
    expect(await deleteCashMovement(dong.id)).toEqual({ ok: true, data: undefined });
    const anh = (await prisma.banGhiDaXoa.findFirstOrThrow()).anh as { chinh: { cardId: string; kind: string } };
    expect(anh.chinh).toMatchObject({ cardId, kind: "CARD_PAY" });
  });

  it("sửa số/mô tả SUPPLIER_PAY đã có của phiếu vừa huỷ ⇒ được (sửa lịch sử); chuyển trả sang phiếu huỷ khác ⇒ không", async () => {
    await batM();
    const p1 = await taoPhieu();
    const p2 = await taoPhieu(true);
    await createCashMovement({ date: vn("2026-11-20"), kind: "SUPPLIER_PAY", amount: tr(5), description: "", phieuNhapId: p1 });
    const dong = await prisma.cashMovement.findFirstOrThrow();
    await prisma.phieuNhapNo.update({ where: { id: p1 }, data: { daHuy: true } });
    const sua = (phieuNhapId: string) => ({
      date: vn("2026-11-20"),
      kind: "SUPPLIER_PAY",
      amount: tr(4),
      description: "sửa",
      phieuNhapId,
    });
    expect(await updateCashMovement(dong.id, sua(p1))).toEqual({ ok: true, data: undefined });
    expect(await updateCashMovement(dong.id, sua(p2))).toMatchObject({ ok: false, code: "PHIEU_DA_HUY" });
  });
});

describe("trần hoàn tiền NCC + sửa khoản trả của phiếu đã huỷ", () => {
  const dongPhieu = (kind: string, amount: number, phieuNhapId: string, date = "2026-11-20") => ({
    date: vn(date),
    kind,
    amount,
    description: "",
    phieuNhapId,
  });

  it("trả 5, huỷ, hoàn 8 ⇒ HOAN_VUOT_DA_TRA (không ghi); hoàn 5 ⇒ ghi, phiếu huỷ về còn nợ 0", async () => {
    await batM();
    const p = await taoPhieu();
    expect(await createCashMovement(dongPhieu("SUPPLIER_PAY", tr(5), p))).toEqual({ ok: true, data: undefined });
    await prisma.phieuNhapNo.update({ where: { id: p }, data: { daHuy: true } });
    expect(await createCashMovement(dongPhieu("SUPPLIER_REFUND", tr(8), p))).toMatchObject({
      ok: false,
      field: "amount",
      code: "HOAN_VUOT_DA_TRA",
    });
    expect(await prisma.cashMovement.count({ where: { kind: "SUPPLIER_REFUND" } })).toBe(0);
    expect(await createCashMovement(dongPhieu("SUPPLIER_REFUND", tr(5), p))).toEqual({ ok: true, data: undefined });
    expect(await docPhieuTheoId(p)).toMatchObject({ daHuy: true, conNo: 0 });
  });

  it("sửa hoàn 5 → 6 vượt trần ⇒ từ chối; xoá dòng trả 5 khi đã hoàn 5 ⇒ từ chối (ca đối xứng)", async () => {
    await batM();
    const p = await taoPhieu();
    await createCashMovement(dongPhieu("SUPPLIER_PAY", tr(5), p));
    await createCashMovement(dongPhieu("SUPPLIER_REFUND", tr(5), p));
    const tra = await prisma.cashMovement.findFirstOrThrow({ where: { kind: "SUPPLIER_PAY" } });
    const hoan = await prisma.cashMovement.findFirstOrThrow({ where: { kind: "SUPPLIER_REFUND" } });
    expect(await updateCashMovement(hoan.id, dongPhieu("SUPPLIER_REFUND", tr(6), p))).toMatchObject({
      ok: false,
      code: "HOAN_VUOT_DA_TRA",
    });
    expect(await deleteCashMovement(tra.id)).toMatchObject({ ok: false, code: "HOAN_VUOT_DA_TRA" });
    expect(await prisma.cashMovement.count()).toBe(2);
    expect((await prisma.cashMovement.findUniqueOrThrow({ where: { id: hoan.id } })).amount).toBe(tr(5));
  });

  it("hoàn tính cả đã trả trước M: daTraTruoc 5 ⇒ hoàn 5 được; bớt đã trả trước về 0 ⇒ từ chối", async () => {
    await batM();
    const p = await taoPhieu();
    await prisma.phieuNhapNo.update({ where: { id: p }, data: { daTraTruoc: tr(5) } });
    expect(await createCashMovement(dongPhieu("SUPPLIER_REFUND", tr(5), p))).toEqual({ ok: true, data: undefined });
    expect(await capNhatDaTraTruoc({ phieuNhapId: p, daTraTruoc: 0 })).toMatchObject({
      ok: false,
      code: "HOAN_VUOT_DA_TRA",
    });
    expect((await prisma.phieuNhapNo.findUniqueOrThrow({ where: { id: p } })).daTraTruoc).toBe(tr(5));
  });

  it("SUPPLIER_PAY của phiếu đã huỷ: giảm số / đổi ngày + mô tả ⇒ được; TĂNG số ⇒ PHIEU_DA_HUY", async () => {
    await batM();
    const p = await taoPhieu();
    await createCashMovement(dongPhieu("SUPPLIER_PAY", tr(5), p));
    const dong = await prisma.cashMovement.findFirstOrThrow();
    await prisma.phieuNhapNo.update({ where: { id: p }, data: { daHuy: true } });
    expect(await updateCashMovement(dong.id, dongPhieu("SUPPLIER_PAY", tr(6), p))).toMatchObject({
      ok: false,
      code: "PHIEU_DA_HUY",
    });
    expect(
      await updateCashMovement(dong.id, { ...dongPhieu("SUPPLIER_PAY", tr(5), p, "2026-11-21"), description: "gõ lại" }),
    ).toEqual({ ok: true, data: undefined });
    expect(await updateCashMovement(dong.id, dongPhieu("SUPPLIER_PAY", tr(3), p))).toEqual({ ok: true, data: undefined });
    expect(await prisma.cashMovement.findUniqueOrThrow({ where: { id: dong.id } })).toMatchObject({ amount: tr(3) });
  });
});

describe("điều chỉnh mở sổ nợ (CUTOVER_*)", () => {
  async function taoCutover() {
    return prisma.cashMovement.create({
      data: { date: vn("2026-11-01"), kind: "CUTOVER_ADJ_IN", amount: tr(3), description: "Điều chỉnh mở sổ" },
    });
  }

  it("action thường không sửa được (kể cả đổi ngày); suaDieuChinhChuyenDoi chỉ đổi số + mô tả", async () => {
    await batM();
    const row = await taoCutover();
    expect(
      await updateCashMovement(row.id, { date: vn("2026-11-02"), kind: "OTHER_IN", amount: tr(3), description: "x" }),
    ).toMatchObject({ code: "KIND_CHUA_HO_TRO" });
    expect(await suaDieuChinhChuyenDoi(row.id, { amount: tr(2), description: "  Chênh bank 2tr  " })).toEqual({
      ok: true,
      data: undefined,
    });
    expect(await prisma.cashMovement.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      kind: "CUTOVER_ADJ_IN",
      amount: tr(2),
      description: "Chênh bank 2tr",
      date: vn("2026-11-01"),
    });
  });

  it("mô tả toàn khoảng trắng (TAB/NBSP) ⇒ zod; nhân sự ⇒ từ chối; id dòng thường ⇒ không tìm thấy", async () => {
    await batM();
    const row = await taoCutover();
    expect(await suaDieuChinhChuyenDoi(row.id, { amount: tr(2), description: "\t " })).toMatchObject({
      ok: false,
      field: "description",
    });
    const thuong = await prisma.cashMovement.create({
      data: { date: vn("2026-11-20"), kind: "CAPITAL_IN", amount: tr(1), description: "" },
    });
    expect(await suaDieuChinhChuyenDoi(thuong.id, { amount: tr(2), description: "x" })).toMatchObject({
      ok: false,
      error: "Không tìm thấy dòng điều chỉnh mở sổ nợ",
    });
    expect((await prisma.cashMovement.findUniqueOrThrow({ where: { id: thuong.id } })).amount).toBe(tr(1));
    vi.mocked(docNguoiDungPhien).mockResolvedValue(
      nguoiDungGia({ role: "STAFF", quyen: new Set(["tai-chinh-so-quy:sua", "tai-chinh-dong-tien:sua"]) as never }),
    );
    expect(await suaDieuChinhChuyenDoi(row.id, { amount: tr(9), description: "x" })).toMatchObject({ ok: false });
    expect((await prisma.cashMovement.findUniqueOrThrow({ where: { id: row.id } })).amount).toBe(tr(3));
  });
});
