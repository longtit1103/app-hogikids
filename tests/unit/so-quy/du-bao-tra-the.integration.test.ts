import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Dự báo quỹ — khoản `TRA_THE` (spec §5.5) trên DB thật, số từ spec §6 / bảng phase-04 (ca 6, 13, 14):
 * mỗi thẻ tối đa HAI khoản (phần kỳ trước còn treo + phần kỳ mới) tại `max(hạn, ngày mai)`, nhãn theo hạn
 * THẬT, `soTien` âm; không có `CARD_PAY` tương lai ⇒ không `DA_GHI` trùng. Chưa bật ⇒ không khoản nào.
 * M = 01/11/2026; sổ mở bằng một dòng góp vốn 100tr ngày 01/10.
 */
import { KEY_NO_PHAI_TRA_TU_NGAY } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { prisma } from "@/lib/prisma";
import { khoanTraThe } from "@/lib/so-quy/du-bao-quy";
import { docDuBaoQuy } from "@/lib/so-quy/du-bao-quy-queries";

import { seedReference, truncateBusinessTables } from "../../helpers/test-db";

const vn = (ngay: string, gio = "00:00:00") => new Date(`${ngay}T${gio}+07:00`);
const tr = (n: number) => Math.round(n * 1_000_000);

async function datM(ngay: string | null) {
  await prisma.setting.deleteMany({ where: { key: KEY_NO_PHAI_TRA_TU_NGAY } });
  if (ngay) await prisma.setting.create({ data: { key: KEY_NO_PHAI_TRA_TU_NGAY, value: ngay } });
}

/** Thẻ A + các kỳ [ngayChot, soDu triệu, hanTra] + các lần trả thẻ [ngày, triệu]. */
async function theA(kys: [string, number, string][], tra: [string, number][] = []): Promise<string> {
  const id = (await prisma.theTinDung.create({ data: { ten: "Thẻ A", ngayChotSaoKe: 25, ngayHanTra: 10 } })).id;
  await prisma.kySaoKeThe.create({ data: { cardId: id, ngayChot: vn("2026-10-31"), soDu: tr(9), laNeoMoSo: true } });
  for (const [ngayChot, soDu, hanTra] of kys) {
    await prisma.kySaoKeThe.create({ data: { cardId: id, ngayChot: vn(ngayChot), soDu: tr(soDu), hanTra: vn(hanTra) } });
  }
  for (const [ngay, so] of tra) {
    await prisma.cashMovement.create({ data: { date: vn(ngay), kind: "CARD_PAY", amount: tr(so), description: "", cardId: id } });
  }
  return id;
}

async function khoanTraTheTai(homNay: string) {
  vi.setSystemTime(vn(homNay, "10:00:00"));
  const db = await docDuBaoQuy();
  if (db.trangThai !== "CO_SO") throw new Error(`mong CO_SO, nhận ${db.trangThai}`);
  return {
    traThe: db.khoanDuKien.filter((k) => k.loai === "TRA_THE").map(({ ngay, soTien, moTa }) => ({ ngay, soTien, moTa })),
    daGhi: db.khoanDuKien.filter((k) => k.loai === "DA_GHI"),
  };
}

beforeAll(async () => {
  await seedReference();
}, 60_000);

beforeEach(async () => {
  await truncateBusinessTables();
  await datM("2026-11-01");
  await prisma.cashMovement.create({
    data: { date: vn("2026-10-01"), kind: "CAPITAL_IN", amount: tr(100), description: "Mở sổ" },
  });
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(async () => {
  vi.useRealTimers();
  await datM(null);
});

afterAll(async () => {
  await truncateBusinessTables();
  await prisma.$disconnect();
});

describe("dự báo — khoản trả thẻ theo sao kê", () => {
  it("ca 6 (26/12): phần kỳ cũ 3,4 quá hạn từ 10/12 ⇒ ngày mai 27/12; phần mới 0,4 hạn 10/01; không DA_GHI", async () => {
    await theA(
      [
        ["2026-11-25", 4.4, "2026-12-10"],
        ["2026-12-25", 3.8, "2027-01-10"],
      ],
      [
        ["2026-11-25", 2],
        ["2026-11-26", 1],
      ],
    );
    const { traThe, daGhi } = await khoanTraTheTai("2026-12-26");
    expect(traThe).toEqual([
      { ngay: "2026-12-27", soTien: -tr(3.4), moTa: "Thẻ A — quá hạn từ 10/12" },
      { ngay: "2027-01-10", soTien: -tr(0.4), moTa: "Thẻ A — hạn 10/01" },
    ]);
    expect(daGhi).toEqual([]);
  });

  it("ca 13: MỘT kỳ còn 3,4 hạn 10/12 — 10/12 ⇒ 'đến hạn hôm nay' (ngày mai 11/12); 11/12 ⇒ 'quá hạn từ 10/12' (12/12)", async () => {
    await theA([["2026-11-25", 4.4, "2026-12-10"]], [["2026-11-26", 1]]);
    expect((await khoanTraTheTai("2026-12-10")).traThe).toEqual([
      { ngay: "2026-12-11", soTien: -tr(3.4), moTa: "Thẻ A — đến hạn hôm nay" },
    ]);
    expect((await khoanTraTheTai("2026-12-11")).traThe).toEqual([
      { ngay: "2026-12-12", soTien: -tr(3.4), moTa: "Thẻ A — quá hạn từ 10/12" },
    ]);
  });

  it("ca 14: chốt SỚM 05/12 (t = 06/12) ⇒ hai khoản 10/12 (2) và 20/12 (3), không nhãn quá hạn", async () => {
    await theA([
      ["2026-11-25", 2, "2026-12-10"],
      ["2026-12-05", 5, "2026-12-20"],
    ]);
    expect((await khoanTraTheTai("2026-12-06")).traThe).toEqual([
      { ngay: "2026-12-10", soTien: -tr(2), moTa: "Thẻ A — hạn 10/12" },
      { ngay: "2026-12-20", soTien: -tr(3), moTa: "Thẻ A — hạn 20/12" },
    ]);
  });

  it("chưa bật ⇒ không khoản trả thẻ nào; thẻ đã đóng ⇒ bỏ", async () => {
    const id = await theA([["2026-11-25", 4.4, "2026-12-10"]]);
    await datM(null);
    expect((await khoanTraTheTai("2026-12-01")).traThe).toEqual([]);
    await datM("2026-11-01");
    await prisma.theTinDung.update({ where: { id }, data: { closedAt: vn("2026-11-30") } });
    expect((await khoanTraTheTai("2026-12-01")).traThe).toEqual([]);
  });
});

describe("khoanTraThe (thuần)", () => {
  const phan = (soTien: number, han: string, quaHan = false, denHanHomNay = false) => ({
    soTien,
    hanTra: vn(han),
    quaHan,
    denHanHomNay,
  });

  it("hạn ngoài cửa sổ dự báo ⇒ bỏ; phần 0 ⇒ bỏ", () => {
    const k = khoanTraThe(
      [{ ten: "Thẻ B", phaiTra: { nghiaVuKy: 5, phanTruoc: phan(0, "2026-12-10"), phanMoi: phan(5, "2027-03-01") } }],
      "2026-12-01",
      "2026-12-31",
    );
    expect(k).toEqual([]);
  });
});
