"use server";

import { format } from "date-fns";
import { z } from "zod";

import type { ActionResult } from "@/lib/actions/action-result";
import { LoiHopDong } from "@/lib/actions/khoan-vay-chung";
import { lamMoiTrang } from "@/lib/actions/lam-moi-trang";
import { mapZodError } from "@/lib/actions/map-zod-error";
import { dangPhucHoi, LOI_DANG_PHUC_HOI } from "@/lib/backup/khoa-bao-tri";
import { ghiNhatKy } from "@/lib/nhat-ky/ghi-nhat-ky";
import { docMocM, KEY_NO_PHAI_TRA_TU_NGAY, khoaDocQuyenBatNoPhaiTra } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { docChenhLechTaiMTuDb, type KetQuaDocChenhLech } from "@/lib/no-phai-tra/doc-chenh-lech-tai-m";
import {
  ghiKhoiTaoNoPhaiTra,
  LOAI_YEU_CAU_BAT,
  moTaNhatKyBat,
  type KetQuaKhoiTao,
} from "@/lib/no-phai-tra/ghi-khoi-tao-no-phai-tra";
import { loiThe } from "@/lib/no-phai-tra/the-tin-dung-queries";
import { bamNoiDung, ghiKetQua, giuYeuCau } from "@/lib/no-phai-tra/yeu-cau-ghi";
import { rangBuocTrungKhoa } from "@/lib/prisma-loi-adapter";
import { prisma } from "@/lib/prisma";
import { congChuShopAction } from "@/lib/quyen/cong-action";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";
import { OPT_TX_DONG_TIEN } from "@/lib/so-quy/khoa-dong-tien-co-han";

/**
 * BƯỚC XÁC NHẬN BẬT theo dõi nợ phải trả (spec `design.md` §5.4) — chỉ chủ shop, MỘT lần duy nhất.
 *
 * `docChenhLechTaiM`: CHỈ ĐỌC — quỹ app cuối M − 1 so với tiền thật chủ shop gõ, tách phần giải thích được
 * (nợ thẻ, phiếu Y, ví ads trả trước) và phần chưa giải thích. Không ghi, không nhật ký.
 *
 * `xacNhanBatNoPhaiTra`: yêu cầu ghi có mã loại `XAC_NHAN_BAT` trong MỘT transaction: khoá EXCLUSIVE bước
 * bật (câu đầu) → giữ mã (gửi lại cùng mã + cùng nội dung ⇒ kết quả cũ `DA_GHI_ROI`, không ghi gì) →
 * `ghiKhoiTaoNoPhaiTra` (đọc lại M ⇒ `DA_BAT_ROI`, kiểm điều kiện, neo thẻ/ví, `CUTOVER_*`, Setting M) →
 * nhật ký `NO_PHAI_TRA_BAT` → ghi kết quả. Danh sách điều chỉnh do màn hình gửi (đã qua bước 2) — server
 * KHÔNG tính lại: số điều chỉnh là quyết định của chủ shop, cố định từ đây.
 */

const TRAN_TIEN = 2_000_000_000;

const ngayIsoSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Ngày không hợp lệ")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00+07:00`);
    return !Number.isNaN(d.getTime()) && khoaNgayVn(d) === s && d.getFullYear() >= 2000;
  }, "Ngày không hợp lệ")
  .transform((s) => new Date(`${s}T00:00:00+07:00`));

const tienKhongAm = (thongBao: string) =>
  z.coerce.number().int("Số tiền phải là số nguyên").min(0, thongBao).max(TRAN_TIEN, "Số tiền quá lớn (tối đa 2 tỷ)");

const saoKeSchema = z.object({
  ngayChot: ngayIsoSchema,
  soDu: tienKhongAm("Số sao kê không âm"),
  hanTra: ngayIsoSchema,
  daTraTruocMoSo: tienKhongAm("Số đã trả không âm"),
});

const xacNhanSchema = z.object({
  yeuCauId: z.string().uuid("Mã yêu cầu không hợp lệ — tải lại trang rồi thử lại"),
  mocM: ngayIsoSchema,
  the: z
    .array(
      z.object({
        cardId: z.string().min(1),
        saoKeCuoi: saoKeSchema.nullable(),
        duNoCuoiMTru1: tienKhongAm("Dư nợ thẻ không âm"),
      })
    )
    .max(50),
  viAds: z.array(z.object({ viAdsId: z.string().min(1), soDuNeo: tienKhongAm("Số dư ví không âm") })).max(10),
  // Shopee Ads nạp từ ví bán hàng / chưa muốn theo dõi ví ⇒ thiếu hồ sơ ví không chặn bật (spec §5.4, §5.9).
  xacNhanViShopeeChuaTheoDoi: z.boolean().default(false),
  dieuChinh: z
    .array(
      z.object({
        chieu: z.enum(["IN", "OUT"]),
        soTien: tienKhongAm("Số điều chỉnh không âm (chọn chiều vào/ra)"),
        // `trim()` của JS bắt cả TAB/NBSP — CHECK `btrim` trong DB thì không.
        moTa: z.string().trim().max(200, "Mô tả tối đa 200 ký tự"),
      })
    )
    .max(50)
    .superRefine((ds, ctx) => {
      ds.forEach((d, i) => {
        if (d.soTien > 0 && d.moTa === "") {
          ctx.addIssue({ code: "custom", path: [i, "moTa"], message: "Mỗi dòng điều chỉnh phải có mô tả" });
        }
      });
    }),
});

export type KetQuaActionBat =
  | { ok: true; data: KetQuaKhoiTao; code?: "DA_GHI_ROI" }
  | { ok: false; error: string; field?: string; code?: string };

export async function xacNhanBatNoPhaiTra(input: unknown): Promise<KetQuaActionBat> {
  const c = await congChuShopAction();
  if (!c.ok) return c;
  const { nguoiDung } = c;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const parsed = xacNhanSchema.safeParse(input);
  if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };
  const d = parsed.data;
  // Vân tay trên dữ liệu ĐÃ chuẩn hoá (khoá ngày VN, mô tả đã trim, bỏ dòng 0).
  const bam = bamNoiDung({
    mocM: khoaNgayVn(d.mocM),
    the: d.the.map((t) => ({
      cardId: t.cardId,
      duNo: t.duNoCuoiMTru1,
      saoKe:
        t.saoKeCuoi === null
          ? null
          : { ...t.saoKeCuoi, ngayChot: khoaNgayVn(t.saoKeCuoi.ngayChot), hanTra: khoaNgayVn(t.saoKeCuoi.hanTra) },
    })),
    viAds: d.viAds,
    xacNhanViShopeeChuaTheoDoi: d.xacNhanViShopeeChuaTheoDoi,
    dieuChinh: d.dieuChinh.filter((x) => x.soTien > 0),
  });

  try {
    const kq = await prisma.$transaction(async (tx) => {
      await khoaDocQuyenBatNoPhaiTra(tx);
      const giu = await giuYeuCau(tx, { id: d.yeuCauId, loai: LOAI_YEU_CAU_BAT, bam });
      if (giu !== "MOI") {
        if (giu.cu.bamNoiDung !== bam) throw new LoiHopDong("Mã yêu cầu đã dùng cho nội dung khác");
        if (giu.cu.ketQua === null) throw new Error(`YeuCauGhi ${d.yeuCauId}: yêu cầu chưa hoàn tất`);
        return { daGhiRoi: true as const, data: (giu.cu.ketQua as { data: KetQuaKhoiTao }).data };
      }

      const data = await ghiKhoiTaoNoPhaiTra(tx, {
        mocM: d.mocM,
        yeuCauId: d.yeuCauId,
        the: d.the,
        viAds: d.viAds,
        dieuChinh: d.dieuChinh,
        xacNhanViShopeeChuaTheoDoi: d.xacNhanViShopeeChuaTheoDoi,
      });
      await ghiNhatKy(tx, {
        actor: nguoiDung,
        hanhDong: "NO_PHAI_TRA_BAT",
        doiTuong: { loai: "Setting", id: KEY_NO_PHAI_TRA_TU_NGAY, moTa: moTaNhatKyBat(data) },
        ghiChu: { ky: data.mocM, soDong: data.dieuChinh.length },
      });
      await ghiKetQua(tx, d.yeuCauId, { ok: true, data });
      return { daGhiRoi: false as const, data };
    }, OPT_TX_DONG_TIEN);

    if (kq.daGhiRoi) return { ok: true, data: kq.data, code: "DA_GHI_ROI" };
    lamMoiTrang();
    return { ok: true, data: kq.data };
  } catch (e) {
    // Unique có thể vỡ: `(cardId, ngayChot)` của kỳ sao kê — thẻ đã có dòng ở đúng ngày đó.
    if (rangBuocTrungKhoa(e) !== undefined) {
      return { ok: false, error: "Thẻ đã có kỳ/neo ở ngày khai — tải lại trang rồi kiểm lại", field: "the" };
    }
    const r = loiThe(e, "Lỗi khi bật theo dõi nợ phải trả");
    if (r.error === "Lỗi khi bật theo dõi nợ phải trả") console.error("[bat-no-phai-tra]", e);
    return { ok: false, ...r };
  }
}

const docChenhLechSchema = z.object({
  mocM: ngayIsoSchema,
  // Ô ngân hàng CHO ÂM (thấu chi) — cùng luật form chốt số dư; tiền mặt không âm.
  soDuBank: z.coerce
    .number()
    .int("Số tiền phải là số nguyên")
    .min(-TRAN_TIEN, "Số tiền quá lớn")
    .max(TRAN_TIEN, "Số tiền quá lớn (tối đa 2 tỷ)"),
  tienMat: tienKhongAm("Tiền mặt không âm"),
  the: z.array(z.object({ cardId: z.string().min(1), duNo: tienKhongAm("Dư nợ thẻ không âm") })).max(50),
  viAds: z.array(z.object({ viAdsId: z.string().min(1), soDu: tienKhongAm("Số dư ví không âm") })).max(10),
});

export async function docChenhLechTaiM(input: unknown): Promise<ActionResult<KetQuaDocChenhLech>> {
  const c = await congChuShopAction();
  if (!c.ok) return c;
  const parsed = docChenhLechSchema.safeParse(input);
  if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };
  try {
    if ((await docMocM()) !== null) {
      return { ok: false, error: "Đã bật theo dõi nợ phải trả rồi — tải lại trang", code: "DA_BAT_ROI" };
    }
    return { ok: true, data: await docChenhLechTaiMTuDb(parsed.data) };
  } catch (e) {
    console.error("[bat-no-phai-tra] Không tính được chênh lệch tại ngày bật:", e);
    return { ok: false, error: `Không tính được chênh lệch tại ${format(parsed.data.mocM, "dd/MM/yyyy")} — thử lại sau.` };
  }
}
