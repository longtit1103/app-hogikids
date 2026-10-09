"use server";

import { format, subDays } from "date-fns";
import { z } from "zod";

import type { ActionResult } from "@/lib/actions/action-result";
import { LoiHopDong } from "@/lib/actions/khoan-vay-chung";
import { lamMoiTrang } from "@/lib/actions/lam-moi-trang";
import { mapZodError } from "@/lib/actions/map-zod-error";
import { dangPhucHoi, LOI_DANG_PHUC_HOI } from "@/lib/backup/khoa-bao-tri";
import { formatVnd } from "@/lib/format";
import { ghiNhatKy } from "@/lib/nhat-ky/ghi-nhat-ky";
import { docMocM, khoaChiaSeBatNoPhaiTra } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { dauNgayVn } from "@/lib/no-phai-tra/du-no-the";
import { loiThe, LoiTheCoMa } from "@/lib/no-phai-tra/the-tin-dung-queries";
import { khoaViAds, lyDoKhongXoaViAds, NEN_TANG_VI_TRA_TRUOC } from "@/lib/no-phai-tra/vi-ads-queries";
import { rangBuocTrungKhoa } from "@/lib/prisma-loi-adapter";
import { prisma } from "@/lib/prisma";
import { congChuShopAction } from "@/lib/quyen/cong-action";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";
import { OPT_TX_DONG_TIEN } from "@/lib/so-quy/khoa-dong-tien-co-han";
import { chupVaoThungRac } from "@/lib/thung-rac/ghi-thung-rac";

/**
 * Hồ sơ VÍ ADS TRẢ TRƯỚC (spec `design.md` §5.9) — Shopee Ads nạp tiền trước rồi chạy. Ví là "túi" ngoài
 * quỹ: từ mốc M, chi ads của nền tảng có hồ sơ ví KHÔNG trừ quỹ (ví gánh), tiền rời quỹ lúc nạp
 * (`ADS_TOPUP` ghi ở form ghi tay).
 *
 * TRƯỚC khi bật: hồ sơ chuẩn bị — số dư/ngày neo là số TẠM, bước xác nhận bật ghi đè bằng số dư thật cuối
 * ngày M − 1 (và đưa số dư đó vào phần giải thích được của điều chỉnh quỹ). SAU khi bật: ví tạo mới neo
 * HÔM QUA với số dư PHẢI = 0 (`NEO_KHAC_0`, cùng luật thẻ thêm sau bật), KHÔNG tạo điều chỉnh quỹ.
 *
 * Nguồn nạp "ví bán hàng Shopee" CHƯA hỗ trợ: dòng nạp nằm trong file ví bán hàng mà app chưa nhận diện
 * tự động được loại dòng (số dư ví hiển thị sẽ sai). Shop nạp từ ví bán hàng thì KHÔNG tạo hồ sơ ví — ở
 * bước bật đánh dấu "ví Shopee chưa theo dõi"; chi ads Shopee tiếp tục trừ quỹ theo ngày chạy như nay.
 *
 * Chỉ chủ shop. `taoViAds` đổi hành vi theo "đã bật chưa" ⇒ câu ĐẦU transaction là khoá SHARED với bước bật.
 */

const LOI_VI_BAN_HANG =
  "Chưa nhận diện tự động được dòng nạp từ ví bán hàng — đợt sau; tạm thời đừng tạo hồ sơ ví, ở bước bật " +
  "đánh dấu \"ví Shopee chưa theo dõi\" (chi ads Shopee vẫn trừ quỹ theo ngày chạy như nay)";

const nguonNapSchema = z
  .enum(["BANK", "CARD", "VI_BAN_HANG"], { message: "Chọn nguồn nạp ví" })
  .superRefine((v, ctx) => {
    if (v === "VI_BAN_HANG") ctx.addIssue({ code: "custom", message: LOI_VI_BAN_HANG });
  })
  .transform((v) => v as "BANK" | "CARD");

const soDuSchema = z.coerce
  .number()
  .int("Số tiền phải là số nguyên")
  .min(0, "Số dư ví không âm")
  .max(2_000_000_000, "Số tiền quá lớn (tối đa 2 tỷ)");

const taoViSchema = z.object({
  nenTang: z.enum(NEN_TANG_VI_TRA_TRUOC, { message: "Chọn nền tảng quảng cáo trả trước" }),
  nguonNap: nguonNapSchema,
  soDuNeo: soDuSchema.optional(),
  ngayNeo: z.coerce
    .date({ error: "Ngày không hợp lệ" })
    .refine((d) => d.getFullYear() >= 2000, "Ngày không hợp lệ")
    .optional(),
  note: z.string().trim().max(500, "Tối đa 500 ký tự").default(""),
});

const suaViSchema = z.object({
  nguonNap: nguonNapSchema,
  note: z.string().trim().max(500, "Tối đa 500 ký tự").default(""),
});

const ngayVn = (d: Date) => format(d, "dd/MM/yyyy");

/**
 * Vì sao ví tạo SAU bật phải neo 0: tiền đang nằm trong ví đã rời ngân hàng (hoặc thành nợ thẻ) trước hôm nay
 * mà sổ chưa trừ — sổ chỉ trừ chi ads lúc chạy, và từ ngày sau neo chi ads Shopee KHÔNG trừ quỹ nữa (ví gánh).
 * Khai số dư X > 0 mà không điều chỉnh quỹ ⇒ quỹ cao hơn ngân hàng đúng X, mãi mãi. Chỉ bước bật mới đưa số
 * dư ví vào điều chỉnh mở sổ (dòng ÂM ở phần giải thích được, §5.9).
 */
const LOI_NEO_VI_PHAI_BANG_0 =
  "Ví tạo sau khi bật theo dõi nợ phải có số dư ban đầu = 0: tiền đang có trong ví đã rời ngân hàng mà quỹ chưa " +
  "trừ — nhập số khác 0 thì quỹ sẽ cao hơn ngân hàng đúng bằng số dư đó. Ví đang có số dư phải khai ở bước bật; " +
  "nếu đã bật rồi, chỉ tạo hồ sơ khi ví đã dùng hết tiền.";

export async function taoViAds(input: unknown): Promise<ActionResult<{ id: string }>> {
  const c = await congChuShopAction();
  if (!c.ok) return c;
  const { nguoiDung } = c;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const parsed = taoViSchema.safeParse(input);
  if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };
  const { nenTang, nguonNap, note } = parsed.data;
  const homQua = dauNgayVn(subDays(new Date(), 1));

  try {
    const id = await prisma.$transaction(async (tx) => {
      await khoaChiaSeBatNoPhaiTra(tx);
      const mocM = await docMocM(tx);
      let soDuNeo: number;
      let ngayNeo: Date;
      if (mocM === null) {
        // Hồ sơ chuẩn bị: số tạm, bước bật ghi đè = số dư thật cuối M − 1.
        soDuNeo = parsed.data.soDuNeo ?? 0;
        ngayNeo = parsed.data.ngayNeo ? dauNgayVn(parsed.data.ngayNeo) : homQua;
        if (khoaNgayVn(ngayNeo) > khoaNgayVn(homQua)) {
          throw new LoiHopDong("Ngày của số dư ví phải trước hôm nay (số dư cuối ngày)", "ngayNeo");
        }
      } else {
        // Sau khi bật: neo HÔM QUA, số dư PHẢI = 0 (không gửi ⇒ 0). Không điều chỉnh quỹ — xem
        // `LOI_NEO_VI_PHAI_BANG_0`. Ngày gửi lên bị bỏ qua: neo luôn là hôm qua.
        if ((parsed.data.soDuNeo ?? 0) !== 0) throw new LoiTheCoMa("NEO_KHAC_0", LOI_NEO_VI_PHAI_BANG_0, "soDuNeo");
        soDuNeo = 0;
        ngayNeo = homQua;
      }
      const vi = await tx.viAdsTraTruoc.create({ data: { nenTang, nguonNap, soDuNeo, ngayNeo, note } });
      await ghiNhatKy(tx, {
        actor: nguoiDung,
        hanhDong: "VI_ADS_TAO",
        doiTuong: {
          loai: "ViAdsTraTruoc",
          id: vi.id,
          moTa: `${nenTang} · nguồn ${nguonNap} · số dư ${formatVnd(soDuNeo)} cuối ${ngayVn(ngayNeo)}${mocM === null ? " (tạm, bước bật ghi đè)" : ""}`,
        },
      });
      return vi.id;
    }, OPT_TX_DONG_TIEN);

    lamMoiTrang();
    return { ok: true, data: { id } };
  } catch (e) {
    if (rangBuocTrungKhoa(e) !== undefined) {
      return { ok: false, error: `${nenTang} đã có hồ sơ ví — mỗi nền tảng một ví`, field: "nenTang" };
    }
    return { ok: false, ...loiVi(e, "Lỗi khi tạo hồ sơ ví") };
  }
}

/** Sửa nguồn nạp mặc định + ghi chú. Số dư/ngày neo KHÔNG sửa ở đây (neo do bước bật ghi). */
export async function suaViAds(id: string, input: unknown): Promise<ActionResult> {
  const c = await congChuShopAction();
  if (!c.ok) return c;
  const { nguoiDung } = c;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const parsed = suaViSchema.safeParse(input);
  if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };

  try {
    await prisma.$transaction(async (tx) => {
      await khoaViAds(tx, id);
      const vi = await tx.viAdsTraTruoc.findUnique({ where: { id }, select: { nenTang: true } });
      if (!vi) throw new LoiHopDong("Không tìm thấy hồ sơ ví");
      await tx.viAdsTraTruoc.update({ where: { id }, data: parsed.data });
      await ghiNhatKy(tx, {
        actor: nguoiDung,
        hanhDong: "VI_ADS_SUA",
        doiTuong: { loai: "ViAdsTraTruoc", id, moTa: `${vi.nenTang} · nguồn ${parsed.data.nguonNap}` },
      });
    }, OPT_TX_DONG_TIEN);

    lamMoiTrang();
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, ...loiVi(e, "Lỗi khi sửa hồ sơ ví") };
  }
}

/** Xoá hồ sơ ví (vào thùng rác) — chỉ khi ví chưa tác động lên quỹ (`lyDoKhongXoaViAds`). */
export async function xoaViAds(id: string): Promise<ActionResult> {
  const c = await congChuShopAction();
  if (!c.ok) return c;
  const { nguoiDung } = c;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  try {
    await prisma.$transaction(async (tx) => {
      await khoaChiaSeBatNoPhaiTra(tx);
      await khoaViAds(tx, id);
      const vi = await tx.viAdsTraTruoc.findUnique({ where: { id } });
      if (!vi) throw new LoiHopDong("Không tìm thấy hồ sơ ví");
      const mocM = await docMocM(tx);
      const sauNeo = new Date(dauNgayVn(vi.ngayNeo).getTime() + 86_400_000);
      const [soLanNap, soChiSauNeo] = await Promise.all([
        tx.cashMovement.count({ where: { viAdsId: id } }),
        mocM === null
          ? Promise.resolve(0)
          : tx.expense.count({ where: { adsSource: vi.nenTang, cardId: null, date: { gte: sauNeo } } }),
      ]);
      const lyDo = lyDoKhongXoaViAds({
        soLanNap,
        daBat: mocM !== null,
        thamGiaBuocBat: mocM !== null && khoaNgayVn(vi.ngayNeo) < khoaNgayVn(mocM),
        soChiSauNeo,
      });
      if (lyDo !== null) throw new LoiTheCoMa("KHONG_XOA_DUOC_VI", lyDo);

      await chupVaoThungRac(tx, { bang: "ViAdsTraTruoc", banGhi: vi });
      await tx.viAdsTraTruoc.delete({ where: { id } });
      await ghiNhatKy(tx, {
        actor: nguoiDung,
        hanhDong: "VI_ADS_XOA",
        doiTuong: { loai: "ViAdsTraTruoc", id, moTa: vi.nenTang },
      });
    }, OPT_TX_DONG_TIEN);

    lamMoiTrang();
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, ...loiVi(e, "Lỗi khi xoá hồ sơ ví") };
  }
}

function loiVi(e: unknown, macDinh: string) {
  const r = loiThe(e, macDinh);
  if (r.error === macDinh) console.error(`[vi-ads] ${macDinh}:`, e);
  // `loiThe` gọi P2025 là "Không tìm thấy thẻ" — ở đây là ví.
  return r.error === "Không tìm thấy thẻ" ? { ...r, error: "Không tìm thấy hồ sơ ví" } : r;
}
