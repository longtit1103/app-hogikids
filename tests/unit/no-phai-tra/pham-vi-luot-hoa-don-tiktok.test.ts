import { describe, expect, it } from "vitest";

import type { Prisma } from "@/generated/prisma/client";
import {
  docThanDauLuot,
  MODE_DAU_BAT_DAU,
  MODE_DAU_KET_THUC,
  phamViCoThePhuNgayVn,
  phamViPhuNgayVn,
  timLuotPhuNgay,
  xetLuotCoDau,
  type DongCuaLuot,
  type PhamViHoaDon,
} from "@/lib/no-phai-tra/dau-luot-hoa-don-tiktok";

/**
 * Phạm vi thời gian n8n đã gửi TikTok (`filtering{start_time, end_time}`) trên dấu lượt hoá đơn — khuôn route nhận,
 * phép "phủ trọn ngày sao kê D" (bảo thủ theo cả cách hiểu giờ VN lẫn UTC của nguồn) và luật chọn lượt bằng chứng.
 */

const pv = (startTime: string, endTime: string): PhamViHoaDon => ({ startTime, endTime, muiGio: "UTC+07:00" });
const D = "2026-10-20";

describe("phamViPhuNgayVn — phủ trọn [D 00:00, D+1 00:00) giờ VN theo MỌI cách hiểu múi nguồn", () => {
  it("cửa sổ đêm thường (10 ngày tới 00:00 hôm nay) phủ D", () => {
    expect(phamViPhuNgayVn(pv("2026-10-12 00:00:00", "2026-10-22 00:00:00"), D)).toBe(true);
  });

  it("biên cuối: kết thúc đúng 00:00 D+1 ⇒ phủ; kết thúc D 23:59:59 / 23:59:00 ⇒ KHÔNG (mốc cuối coi là loại trừ)", () => {
    expect(phamViPhuNgayVn(pv("2026-10-10 00:00:00", "2026-10-21 00:00:00"), D)).toBe(true);
    expect(phamViPhuNgayVn(pv("2026-10-10 00:00:00", "2026-10-20 23:59:59"), D)).toBe(false);
    expect(phamViPhuNgayVn(pv("2026-10-10 00:00:00", "2026-10-20 23:59:00"), D)).toBe(false);
  });

  it("biên đầu theo cách hiểu UTC: bắt đầu 'D 00:00' (= 07:00 VN nếu nguồn hiểu UTC) ⇒ KHÔNG; 'D−1 17:00' ⇒ phủ", () => {
    // Nếu chỉ hiểu giờ VN thì "D 00:00" đã phủ — cổng bảo thủ vẫn chặn vì cách hiểu UTC hụt 7 tiếng đầu ngày D.
    expect(phamViPhuNgayVn(pv("2026-10-20 00:00:00", "2026-10-22 00:00:00"), D)).toBe(false);
    expect(phamViPhuNgayVn(pv("2026-10-19 17:00:01", "2026-10-22 00:00:00"), D)).toBe(false);
    expect(phamViPhuNgayVn(pv("2026-10-19 17:00:00", "2026-10-22 00:00:00"), D)).toBe(true);
    expect(phamViPhuNgayVn(pv("2026-10-19 00:00:00", "2026-10-22 00:00:00"), D)).toBe(true);
  });

  it("biên cuối theo cách hiểu UTC không trói thêm (D+1 00:00 VN = D 17:00 UTC < D+1 00:00)", () => {
    // end "D 17:00" chỉ phủ D nếu nguồn hiểu UTC — cách hiểu giờ VN hụt ⇒ KHÔNG.
    expect(phamViPhuNgayVn(pv("2026-10-10 00:00:00", "2026-10-20 17:00:00"), D)).toBe(false);
  });

  it("cửa sổ đã trôi qua D (lượt đêm chạy muộn) ⇒ KHÔNG", () => {
    expect(phamViPhuNgayVn(pv("2026-10-21 00:00:00", "2026-10-31 00:00:00"), D)).toBe(false);
  });
});

describe("phamViCoThePhuNgayVn — vị từ LỎNG: phủ D theo ÍT NHẤT một cách hiểu múi", () => {
  it("start 'D 00:00' phủ D nếu nguồn hiểu giờ VN ⇒ lỏng có, chặt không", () => {
    const p = pv("2026-10-20 00:00:00", "2026-10-30 00:00:00");
    expect(phamViCoThePhuNgayVn(p, D)).toBe(true);
    expect(phamViPhuNgayVn(p, D)).toBe(false);
  });

  it("end 'D 17:00' phủ D nếu nguồn hiểu UTC ⇒ lỏng có; end 'D 16:59:59' / start 'D 00:00:01' ⇒ không theo cách hiểu nào", () => {
    expect(phamViCoThePhuNgayVn(pv("2026-10-10 00:00:00", "2026-10-20 17:00:00"), D)).toBe(true);
    expect(phamViCoThePhuNgayVn(pv("2026-10-10 00:00:00", "2026-10-20 16:59:59"), D)).toBe(false);
    expect(phamViCoThePhuNgayVn(pv("2026-10-20 00:00:01", "2026-10-30 00:00:00"), D)).toBe(false);
  });

  it("phủ chặt ⇒ phủ lỏng", () => {
    expect(phamViCoThePhuNgayVn(pv("2026-10-12 00:00:00", "2026-10-22 00:00:00"), D)).toBe(true);
  });
});

describe("docThanDauLuot — khuôn phamVi", () => {
  const base = { luotId: "1", bcId: "7129545797879726081", giaiDoan: "bat-dau" };
  const tot = pv("2026-10-21 00:00:00", "2026-10-31 00:00:00");

  it("có phamVi đúng khuôn ⇒ nhận; vắng phamVi (dấu bản cũ) ⇒ vẫn nhận", () => {
    expect(docThanDauLuot({ ...base, phamVi: tot })).toMatchObject({ ok: true, dau: { phamVi: tot } });
    expect(docThanDauLuot(base)).toMatchObject({ ok: true });
  });

  it.each<[string, unknown]>([
    ["múi khác", { ...tot, muiGio: "UTC+00:00" }],
    ["thiếu muiGio", { startTime: tot.startTime, endTime: tot.endTime }],
    ["khoá lạ", { ...tot, them: 1 }],
    ["giờ không có thật", { ...tot, startTime: "2026-02-30 00:00:00" }],
    ["sai khuôn ISO", { ...tot, startTime: "2026-10-21T00:00:00" }],
    ["epoch", { ...tot, startTime: 1792000000 }],
    ["bắt đầu = kết thúc", { ...tot, startTime: tot.endTime }],
    ["bắt đầu sau kết thúc", { ...tot, startTime: "2026-11-01 00:00:00" }],
    ["null", null],
  ])("phamVi %s ⇒ 400 (fail-closed: không ghi dấu)", (_ca, phamVi) => {
    expect(docThanDauLuot({ ...base, phamVi })).toMatchObject({ ok: false });
  });
});

const KT_DU = {
  tongTrangNguon: 0,
  tongHoaDonNguon: 0,
  soTrangDaGet: 1,
  soTrangLand: 0,
  soTrangRong: 1,
  soTrangLoi: 0,
  soHoaDon: 0,
  hoanTat: true,
  ketQua: "xong",
  loi: [],
};
const KT_LOI = { ...KT_DU, tongTrangNguon: null, tongHoaDonNguon: null, soTrangDaGet: 0, soTrangRong: 0, hoanTat: false, ketQua: "loi", loi: ["ETIMEDOUT"] };

/** Lượt 0 hoá đơn (ĐỦ khi `ketThuc` = KT_DU) với phạm vi `p` (null = dấu bản cũ không mang phạm vi). */
function luot(p: PhamViHoaDon | null, ketThuc: Record<string, unknown> | null = KT_DU, pKetThuc = p): DongCuaLuot[] {
  const st = (x: PhamViHoaDon | null, them: Record<string, unknown> = {}) =>
    ({ ...(x ? { phamVi: x } : {}), ...them }) as Prisma.JsonValue;
  const dong: DongCuaLuot[] = [{ status: "OK", mode: MODE_DAU_BAT_DAU, stats: st(p) }];
  if (ketThuc) {
    dong.push({ status: ketThuc.ketQua === "loi" ? "ERROR" : "OK", mode: MODE_DAU_KET_THUC, stats: st(pKetThuc, ketThuc) });
  }
  return dong;
}

const PHU_D = pv("2026-10-12 00:00:00", "2026-10-22 00:00:00");
const PHU_D_KEO_BU = pv("2026-09-01 00:00:00", "2026-10-31 00:00:00");
const KHONG_PHU_D = pv("2026-10-21 00:00:00", "2026-10-31 00:00:00");

describe("xetLuotCoDau — phạm vi hai dấu phải trùng", () => {
  it("trùng (hoặc cùng vắng) ⇒ đủ; lệch / chỉ một dấu có ⇒ không khớp", () => {
    expect(xetLuotCoDau(luot(PHU_D))).toEqual({ loai: "du" });
    expect(xetLuotCoDau(luot(null))).toEqual({ loai: "du" });
    expect(xetLuotCoDau(luot(PHU_D, KT_DU, KHONG_PHU_D))).toMatchObject({ loai: "khong-khop" });
    expect(xetLuotCoDau(luot(PHU_D, KT_DU, null))).toMatchObject({ loai: "khong-khop" });
  });
});

describe("timLuotPhuNgay — bằng chứng = lượt ĐỦ có phạm vi phủ D, và là lượt MỚI NHẤT trong số lượt (có thể) phủ D", () => {
  it("các lượt phủ D đều hỏng, lượt mới thành công nhưng phạm vi đã trôi qua D ⇒ phu-hong (lượt phủ D sau cùng)", () => {
    const kq = timLuotPhuNgay([luot(PHU_D, KT_LOI), luot(PHU_D, KT_LOI), luot(KHONG_PHU_D)], D);
    expect(kq).toMatchObject({ loai: "phu-hong", chiSo: 1 });
  });

  it("lượt kéo bù đủ phủ D sau đó ⇒ bằng chứng là lượt kéo bù", () => {
    const kq = timLuotPhuNgay([luot(PHU_D, KT_LOI), luot(KHONG_PHU_D), luot(PHU_D_KEO_BU), luot(KHONG_PHU_D)], D);
    expect(kq).toEqual({ loai: "co", chiSo: 2 });
  });

  it("lượt phủ D cũ ĐỦ không che lượt phủ D mới hơn bị hỏng", () => {
    expect(timLuotPhuNgay([luot(PHU_D), luot(PHU_D, KT_LOI), luot(KHONG_PHU_D)], D)).toMatchObject({ loai: "phu-hong", chiSo: 1 });
    // Lượt chết giữa chừng (có dấu bắt đầu mang phạm vi, không dấu kết thúc) vẫn là lượt phủ D.
    expect(timLuotPhuNgay([luot(PHU_D), luot(PHU_D, null)], D)).toMatchObject({ loai: "phu-hong", chiSo: 1 });
  });

  it("lượt không rõ phạm vi (dấu bản cũ) mới hơn ⇒ coi như có thể phủ D, không là bằng chứng ⇒ phu-hong", () => {
    expect(timLuotPhuNgay([luot(PHU_D), luot(null)], D)).toMatchObject({ loai: "phu-hong", chiSo: 1 });
    // Dấu bản cũ đủ CŨ hơn bằng chứng ⇒ không ảnh hưởng.
    expect(timLuotPhuNgay([luot(null), luot(PHU_D)], D)).toEqual({ loai: "co", chiSo: 1 });
  });

  it("lượt HỎNG chỉ phủ D lỏng (start 'D 00:00') sau lượt đủ phủ chặt ⇒ phu-hong ở lượt hỏng (lượt cũ không che)", () => {
    const CHI_PHU_LONG = pv("2026-10-20 00:00:00", "2026-10-30 00:00:00");
    expect(timLuotPhuNgay([luot(PHU_D), luot(CHI_PHU_LONG, KT_LOI), luot(KHONG_PHU_D)], D)).toMatchObject({
      loai: "phu-hong",
      chiSo: 1,
      loaiLuot: "bao-loi",
    });
  });

  it("lượt ĐỦ chỉ phủ D lỏng không phải bằng chứng nhưng cũng không hỏng ⇒ xét tiếp, lượt đủ phủ chặt cũ hơn là bằng chứng", () => {
    const CHI_PHU_LONG = pv("2026-10-20 00:00:00", "2026-10-30 00:00:00");
    expect(timLuotPhuNgay([luot(PHU_D), luot(CHI_PHU_LONG)], D)).toEqual({ loai: "co", chiSo: 0 });
    expect(timLuotPhuNgay([luot(CHI_PHU_LONG)], D)).toEqual({ loai: "khong-phu" });
  });

  it("lượt phủ D hỏng vì thiếu quyền finance ⇒ loaiLuot khong-quyen-finance; đủ mà không rõ phạm vi ⇒ khong-ro-pham-vi", () => {
    const KT_KHONG_QUYEN = { ...KT_LOI, ketQua: "khong-quyen-finance", loi: ["No access to finance of this bc"] };
    expect(timLuotPhuNgay([luot(PHU_D, KT_KHONG_QUYEN), luot(KHONG_PHU_D)], D)).toMatchObject({
      loai: "phu-hong",
      loaiLuot: "khong-quyen-finance",
    });
    expect(timLuotPhuNgay([luot(null)], D)).toMatchObject({ loai: "phu-hong", loaiLuot: "khong-ro-pham-vi" });
  });

  it("không lượt nào phủ D ⇒ khong-phu; danh sách rỗng ⇒ khong-phu", () => {
    expect(timLuotPhuNgay([luot(KHONG_PHU_D), luot(KHONG_PHU_D)], D)).toEqual({ loai: "khong-phu" });
    expect(timLuotPhuNgay([], D)).toEqual({ loai: "khong-phu" });
  });
});
