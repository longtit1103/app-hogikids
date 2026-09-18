import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import { calcPnl } from "@/lib/reports/pnl";
import { tinhQuyTuTong } from "@/lib/so-quy/cong-thuc-so-quy";
import { docTongNguon } from "@/lib/so-quy/so-quy-queries";

import { SHOP_KHO } from "../helpers/shop-ids-fixture";
import { seedReference, truncateBusinessTables } from "../helpers/test-db";

/**
 * LƯỚI BẤT BIẾN của lượt duyệt chi phí nhập hàng, chạy trên DB thật (`hogikids_test`).
 *
 * Hai lời hứa mà màn hình nói thẳng với chủ shop TRƯỚC khi họ bấm, nên phải kiểm được bằng máy:
 *  1. Quỹ giảm ĐÚNG tổng vừa ghi (danh mục `purchase` CÓ trừ Sổ quỹ — `so-quy-queries` không lọc
 *     danh mục nào);
 *  2. Lãi/Lỗ KHÔNG đổi một đồng (bất biến #1: "Nhập hàng" KHÔNG BAO GIỜ vào P&L — `pnl.ts` lọc bỏ).
 *
 * Fixture là payload phiếu nhập THẬT rút từ Bronze prod 17/09 (đã gột). D0 = 12/05/2026 ⇒ đúng 4
 * phiếu đề xuất, Σ 223.099.858đ — cùng con số đo thật trên prod.
 */

vi.mock("@/lib/session", () => ({ requireUser: vi.fn(async () => "test-user-id") }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { ghiChiPhiNhapHang } = await import("@/lib/actions/chi-phi-nhap-hang");
const { docDeXuatPhieuNhap } = await import("@/lib/nhap-hang/doc-phieu-nhap-bronze");
const { vanTayDeXuatPhieuNhap } = await import("@/lib/nhap-hang/doi-chieu-phieu-nhap");

const PHIEU_THAT = JSON.parse(
  readFileSync(path.resolve(process.cwd(), "tests/fixtures/pancake/phieu-nhap-sample.json"), "utf8"),
) as { id: string }[];

/** Ngày mở sổ quỹ — dòng `CashMovement` đầu tiên quyết định (xem `ngayMoSo`). */
const D0 = new Date(2026, 4, 12);
/** Kỳ P&L phủ TRỌN 4 ngày phiếu nhập (04–15/09): phiếu lọt vào P&L thì test này phải đỏ. */
const KY = { from: new Date(2026, 8, 1), to: new Date(2026, 8, 30) };
/** Biên trên cố định cho phép đo quỹ — không phụ thuộc ngày chạy test. */
const DEN = new Date(2026, 11, 31);
const TONG_4_PHIEU = 223_099_858;

async function seedBronzePhieuNhap(): Promise<void> {
  await prisma.rawPancakePurchase.deleteMany();
  await prisma.rawPancakePurchase.createMany({
    data: PHIEU_THAT.map((p, i) => ({
      shopId: SHOP_KHO,
      externalId: p.id,
      payloadHash: `hash-${i}`,
      payload: p as object,
    })),
  });
}

/** Một đơn COMPLETED để P&L có số khác 0 — "không đổi" trên nền 0 là phép kiểm rỗng. */
async function seedDon(): Promise<void> {
  await prisma.order.create({
    data: {
      pancakeId: "NH-DON-1",
      code: "NH1",
      channelId: "shopee",
      status: "COMPLETED",
      orderedAt: new Date(2026, 8, 5),
      syncedAt: new Date(2026, 8, 5),
      itemsTotal: 40_000_000,
      discount: 1_000_000,
      platformFeeEst: 5_000_000,
    },
  });
}

async function quy(): Promise<number> {
  return tinhQuyTuTong(await docTongNguon(D0, DEN));
}

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await seedBronzePhieuNhap();
  // Dòng ghi tay đầu tiên = ngày mở sổ. Góp vốn để quỹ dương hẳn, thấy rõ phần bị trừ đi.
  await prisma.cashMovement.create({
    data: { date: D0, kind: "CAPITAL_IN", amount: 500_000_000, description: "Góp vốn mở sổ" },
  });
  await seedDon();
});

afterAll(async () => {
  await prisma.rawPancakePurchase.deleteMany();
  await prisma.$disconnect();
});

async function duyetTatCa(): Promise<{ vanTay: string; chon: { uuid: string; soTien: number }[] }> {
  const { deXuat } = await docDeXuatPhieuNhap();
  return {
    vanTay: vanTayDeXuatPhieuNhap(deXuat),
    chon: deXuat.map((d) => ({ uuid: d.uuid, soTien: d.soTien })),
  };
}

describe("ghiChiPhiNhapHang — lưới tiền trên DB thật", () => {
  it("ghi 4 phiếu ⇒ 4 dòng Expense purchase đúng số, QUỸ giảm đúng tổng, LÃI/LỖ không đổi", async () => {
    const quyTruoc = await quy();
    const pnlTruoc = await calcPnl(KY);

    const kq = await ghiChiPhiNhapHang(await duyetTatCa());

    expect(kq.ok).toBe(true);
    if (kq.ok) expect(kq.data).toEqual({ daGhi: 4, boQua: 0, tongTien: TONG_4_PHIEU });

    const dong = await prisma.expense.findMany({ orderBy: { date: "asc" } });
    expect(dong).toHaveLength(4);
    expect(dong.every((d) => d.categoryId === "purchase")).toBe(true);
    expect(dong.every((d) => d.source === "MANUAL")).toBe(true);
    expect(dong.every((d) => d.channelId === null)).toBe(true);
    expect(dong.map((d) => d.amount)).toEqual([28_999_920, 59_559_808, 53_599_970, 80_940_160]);
    expect(dong.map((d) => d.refId?.startsWith("PANCAKE_PURCHASE:"))).toEqual([
      true,
      true,
      true,
      true,
    ]);
    // Mô tả phải tự nói được dòng tiền này từ phiếu nào — sáu tháng sau còn người soi lại.
    expect(dong[0].description).toContain("Phiếu nhập #181");

    // (1) Quỹ giảm ĐÚNG tổng đã ghi — không hơn một đồng, không kém một đồng.
    expect(await quy()).toBe(quyTruoc - TONG_4_PHIEU);

    // (2) Lãi/Lỗ không đổi MỘT ĐỒNG nào: "Nhập hàng" là dòng tiền, không phải chi phí kinh doanh.
    const pnlSau = await calcPnl(KY);
    expect(pnlSau).toEqual(pnlTruoc);
    expect(pnlSau.netProfit).toBe(pnlTruoc.netProfit);
  });

  it("ghi lại lần 2 ⇒ không sinh dòng trùng (refId @unique), báo đúng số bỏ qua", async () => {
    const lan1 = await duyetTatCa();
    expect((await ghiChiPhiNhapHang(lan1)).ok).toBe(true);

    const quySauLan1 = await quy();

    // Gửi LẠI ĐÚNG payload cũ: mô phỏng chủ shop bấm hai lần / tab cũ còn mở. Danh sách đề xuất nay
    // rỗng nên vân tay đã khác ⇒ cổng vân tay chặn trước, chưa chạm tới `refId`.
    const lai = await ghiChiPhiNhapHang(lan1);
    expect(lai.ok).toBe(false);
    if (!lai.ok) expect(lai.code).toBe("DANH_SACH_DA_DOI");

    expect(await prisma.expense.count()).toBe(4);
    expect(await quy()).toBe(quySauLan1);
  });

  it("tab khác vừa ghi phiếu ⇒ vân tay bắt trước; refId @unique là cổng cuối ở tầng DB", async () => {
    const { deXuat } = await docDeXuatPhieuNhap();
    const dau = deXuat[0];
    // Ca đua thật: một tab khác ghi phiếu #181 SAU khi tab này đọc danh sách.
    await prisma.expense.create({
      data: {
        date: dau.ngay,
        categoryId: "purchase",
        amount: dau.soTien,
        description: "Ghi từ tab khác",
        source: "MANUAL",
        refId: dau.refId,
      },
    });

    // Cổng THỨ NHẤT chặn ngay: action đọc LẠI đề xuất, phiếu #181 nay nằm ở `daGhi` nên vân tay
    // khác bản chủ shop đang cầm. Không ghi gì cả — kể cả 3 phiếu còn hợp lệ.
    const kq = await ghiChiPhiNhapHang({
      vanTay: vanTayDeXuatPhieuNhap(deXuat),
      chon: deXuat.map((d) => ({ uuid: d.uuid, soTien: d.soTien })),
    });

    expect(kq.ok).toBe(false);
    if (!kq.ok) expect(kq.code).toBe("DANH_SACH_DA_DOI");
    expect(await prisma.expense.count()).toBe(1);

    // Cổng CUỐI ở tầng DB cho khe mà không lớp app nào với tới (ghi đồng thời trong đúng mili giây
    // giữa lượt đọc lại và lượt INSERT): `Expense.refId @unique` ⇒ P2002.
    await expect(
      prisma.expense.create({
        data: {
          date: dau.ngay,
          categoryId: "purchase",
          amount: dau.soTien,
          description: "Dòng trùng",
          source: "MANUAL",
          refId: dau.refId,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    expect(await prisma.expense.count()).toBe(1);
  });

  it("chọn ít hơn + sửa số tiền (mới trả một phần NCC) ⇒ quỹ giảm đúng số đã sửa", async () => {
    const { deXuat } = await docDeXuatPhieuNhap();
    const quyTruoc = await quy();

    const kq = await ghiChiPhiNhapHang({
      vanTay: vanTayDeXuatPhieuNhap(deXuat),
      chon: [{ uuid: deXuat[0].uuid, soTien: 10_000_000 }],
    });

    expect(kq.ok).toBe(true);
    expect(await prisma.expense.count()).toBe(1);
    expect(await quy()).toBe(quyTruoc - 10_000_000);
    // 3 phiếu còn lại vẫn nằm trong danh sách chờ duyệt.
    expect((await docDeXuatPhieuNhap()).deXuat).toHaveLength(3);
  });
});

/**
 * ĐƯỜNG ĐỌC BRONZE — hình dạng dữ liệu THẬT trên prod mà fixture một-bản-một-phiếu không bao giờ
 * chạm tới: mỗi lượt đồng bộ chụp LẠI cả danh sách nên 17/09 có 1.201 bản raw cho 184 phiếu (bội
 * 6,53 lần), và `status` của một phiếu ĐỔI giữa các bản (phiếu #173/#179 mang `status=1` ở 5 bản
 * đầu rồi mới sang 2 = đã huỷ).
 *
 * Hai luật của câu SQL giữ cho màn duyệt nói đúng, và cả hai đều KHÔNG có triệu chứng ở tầng sổ —
 * `Expense.refId @unique` vẫn chặn dòng trùng, nên cái sai chỉ nằm ở CON SỐ chủ shop nhìn để bấm:
 *  - `DISTINCT ON`: thiếu là một phiếu 80 triệu hiện 3 lần, khối "Ảnh hưởng nếu ghi" phồng 6,5 lần;
 *  - `ORDER BY "fetchedAt" DESC`: đảo chiều là đọc ảnh ĐẦU TIÊN ⇒ phiếu đã huỷ quay lại danh sách.
 */
describe("docDeXuatPhieuNhap — nhiều bản fetch cho cùng một phiếu", () => {
  /** Phiếu đổi `status` 1 → 2 (huỷ) SAU vài lượt fetch — đúng ca đã xảy ra thật trên prod. */
  const HUY_SAU_KHI_FETCH = new Set([
    "ff141732-01c0-46b7-981c-0c31b7f7aa3d", // #173 — 22.699.950đ, trước D0
    "e23d4809-a3fa-44a1-8b1e-5c82da38bdd5", // #179 — 15.000.000đ, trước D0
    "be24b011-bdfa-49d6-b50a-0919dd26d056", // #184 — 80.940.160đ, SAU D0 ⇒ huỷ mà đọc nhầm là ghi tiền khống
  ]);

  /** 3 bản raw cho MỖI phiếu, `fetchedAt` tăng dần; bản cuối mới là bản Pancake đang khai. */
  async function seedBronzeNhieuBan(): Promise<void> {
    await prisma.rawPancakePurchase.deleteMany();
    const data = (PHIEU_THAT as unknown as Record<string, unknown>[]).flatMap((p) =>
      [0, 1, 2].map((ban) => ({
        shopId: SHOP_KHO,
        externalId: p.id as string,
        payloadHash: `hash-${p.id as string}-${ban}`,
        payload: (HUY_SAU_KHI_FETCH.has(p.id as string)
          ? { ...p, status: ban === 2 ? 2 : 1 }
          : p) as object,
        fetchedAt: new Date(2026, 8, 16, 3, ban),
      })),
    );
    await prisma.rawPancakePurchase.createMany({ data });
  }

  /** 3 phiếu còn hiệu lực SAU D0: #181 + #182 + #183. */
  const TONG_3_PHIEU = 142_159_698;
  /** 3 phiếu còn hiệu lực TRƯỚC D0: #175 + #176 + #177 — tiền đã nằm trong số dư mở sổ. */
  const TRUOC_D0 = 124_869_852;

  beforeEach(async () => {
    await seedBronzeNhieuBan();
  });

  it("27 bản raw cho 9 phiếu ⇒ mỗi phiếu vào danh sách ĐÚNG MỘT lần", async () => {
    const kq = await docDeXuatPhieuNhap();

    // Phép đo không rỗng: DB thật đang giữ 27 dòng, đọc trần là 27 phiếu.
    expect(await prisma.rawPancakePurchase.count()).toBe(27);
    expect(kq.soPhieuNhapThat).toBe(9);

    const uuid = kq.deXuat.map((d) => d.uuid);
    expect(new Set(uuid).size).toBe(uuid.length);
    expect(kq.deXuat.map((d) => d.displayId)).toEqual([181, 182, 183]);
    // Con số chủ shop nhìn để bấm: khối "Ảnh hưởng nếu ghi" = Σ đề xuất.
    expect(kq.deXuat.reduce((t, d) => t + d.soTien, 0)).toBe(TONG_3_PHIEU);
  });

  it("phiếu đổi trạng thái 1 → 2 giữa các lượt fetch: đọc bản MỚI NHẤT nên phiếu đã huỷ KHÔNG quay lại", async () => {
    const kq = await docDeXuatPhieuNhap();

    // #184 (80.940.160đ) mang status=1 ở hai bản đầu: đọc nhầm bản cũ là đề xuất ghi một khoản chi
    // cho phiếu Pancake đã huỷ — quỹ tụt đúng ngần ấy mà không có hàng.
    expect(kq.deXuat.map((d) => d.uuid)).not.toContain("be24b011-bdfa-49d6-b50a-0919dd26d056");
    expect(kq.deXuat.map((d) => d.displayId)).toEqual([181, 182, 183]);

    // #173 + #179 nằm trước D0: đọc nhầm bản cũ thì chúng rơi vào ô "bỏ qua trước ngày mở sổ" và
    // hai con số này phồng lên — cùng một lỗi, chỉ khác chỗ lộ ra.
    expect(kq.boQuaTruocD0).toEqual({ soPhieu: 3, tongTien: TRUOC_D0 });
  });
});
