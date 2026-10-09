"use server";

import { format, startOfDay } from "date-fns";
import { z } from "zod";

import type { ActionResult } from "@/lib/actions/action-result";
import { maLoiNhatKy } from "@/lib/actions/khoan-vay-chung";
import { lamMoiTrang } from "@/lib/actions/lam-moi-trang";
import { mapZodError } from "@/lib/actions/map-zod-error";
import { dangPhucHoi, LOI_DANG_PHUC_HOI } from "@/lib/backup/khoa-bao-tri";
import { ghiNhatKy, ghiNhatKyLoi } from "@/lib/nhat-ky/ghi-nhat-ky";
import { daBatNoPhaiTra, LoiChuaBat } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { ngayTienMoiSchema } from "@/lib/no-phai-tra/ngay-tien-moi-schema";
import { docPhieuConNo, khoaCacPhieu, vanTayPhieuConNo } from "@/lib/no-phai-tra/phieu-nhap-no-queries";
import { bamNoiDung, ghiKetQua, giuYeuCau } from "@/lib/no-phai-tra/yeu-cau-ghi";
import { prisma } from "@/lib/prisma";
import { laXungDotGhi } from "@/lib/prisma-loi-adapter";
import { congAction } from "@/lib/quyen/cong-action";
import type { NguoiDung } from "@/lib/quyen/nguoi-dung-phien";
import { laLoiDongTienBan, OPT_TX_DONG_TIEN, THONG_BAO_KHOA_DONG_TIEN_BAN } from "@/lib/so-quy/khoa-dong-tien-co-han";

/**
 * TRẢ TIỀN HÀNG GỘP — một lượt bấm trả nhà cung cấp N phiếu, sinh N dòng `SUPPLIER_PAY` cùng
 * `yeuCauId` (spec §5.3). Sáu bước trong MỘT transaction (ReadCommitted — KHÔNG đổi isolation:
 * `giuYeuCau` chỉ đúng ở READ COMMITTED, Serializable làm lượt gửi lại nhận 40001 thay vì dòng cũ):
 *   (1) `giuYeuCau` — mã đã dùng: cùng nội dung ⇒ trả kết quả cũ + `DA_GHI_ROI` (không kiểm vân tay,
 *       không ghi gì); khác nội dung ⇒ từ chối. Kết quả cũ NULL ⇒ ném (đường ghi quên bước 6).
 *   (2) `khoaCacPhieu` — FOR UPDATE từng phiếu theo id tăng dần.
 *   (3) vân tay tính LẠI trên dữ liệu đọc SAU khoá — khác ⇒ ném `DANH_SACH_DA_DOI`, transaction lùi
 *       trọn kể cả dòng `YeuCauGhi` (mã dùng lại được sau khi tải lại).
 *   (4) `createMany` N dòng `SUPPLIER_PAY`. (5) nhật ký. (6) `ghiKetQua`.
 *
 * Phân bổ "cũ trước" là GỢI Ý của client; server chỉ kiểm tổng + mỗi phần > 0. KHÔNG chặn trả vượt
 * còn nợ: trả thừa là sự thật cần ghi (còn nợ âm "trả thừa", đóng bằng `SUPPLIER_REFUND`). CHẶN phiếu
 * đã huỷ (`PHIEU_DA_HUY`) — đường đưa tiền ra khỏi phiếu huỷ là `SUPPLIER_REFUND`.
 *
 * PHẢI nằm trong `DUONG_GHI` của `tests/khoa-bao-tri-duong-ghi.test.ts`.
 */

const LOAI_YEU_CAU = "TRA_GOP_NCC";

const tien = z.coerce
  .number({ error: "Số tiền không hợp lệ" })
  .int("Số tiền phải là số nguyên")
  .positive("Số tiền phải lớn hơn 0")
  .max(2_000_000_000, "Số tiền quá lớn (tối đa 2 tỷ)");

/** Schema phụ thuộc M (ngày ∈ [M, hôm nay]) — dựng sau khi qua cổng bật. */
function traGopSchema(mocM: Date) {
  return z
    .object({
      yeuCauId: z.string().uuid("Mã yêu cầu không hợp lệ — tải lại trang"),
      vanTay: z.string().min(1, "Thiếu vân tay danh sách — tải lại trang"),
      ngay: ngayTienMoiSchema(mocM),
      tong: tien,
      phanBo: z
        .array(z.object({ phieuNhapId: z.string().min(1, "Thiếu phiếu"), soTien: tien }))
        .min(1, "Chưa phân bổ cho phiếu nào"),
      // Rỗng sau khi bỏ khoảng trắng = không ghi mô tả (dùng câu mặc định).
      moTa: z
        .string()
        .trim()
        .max(200, "Mô tả tối đa 200 ký tự")
        .optional()
        .transform((v) => (v === undefined || v === "" ? undefined : v)),
    })
    .refine((d) => d.phanBo.reduce((s, p) => s + p.soTien, 0) === d.tong, {
      message: "Tổng phân bổ phải bằng số tiền trả",
      path: ["phanBo"],
    })
    .refine((d) => new Set(d.phanBo.map((p) => p.phieuNhapId)).size === d.phanBo.length, {
      message: "Mỗi phiếu chỉ một dòng phân bổ",
      path: ["phanBo"],
    });
}

type KetQuaTraGop = { daGhi: number; tong: number };

/** Lượt gửi lại cùng mã + cùng nội dung — kết quả lượt đầu, đánh dấu đã ghi rồi. */
type KetQuaDaGhiRoi = { ok: true; data: KetQuaTraGop; code: "DA_GHI_ROI" };

/** Lỗi nghiệp vụ ném trong transaction (rollback trọn, kể cả dòng `YeuCauGhi`). */
class LoiTraGop extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "LoiTraGop";
  }
}

type ThamSo = {
  nguoiDung: NguoiDung;
  yeuCauId: string;
  vanTay: string;
  ngay: Date;
  tong: number;
  phanBo: { phieuNhapId: string; soTien: number }[];
  moTa: string | undefined;
  bam: string;
};

async function chayTraGop(t: ThamSo): Promise<{ moi: KetQuaTraGop } | { cu: KetQuaTraGop }> {
  return prisma.$transaction(async (tx) => {
    // (1) Giữ mã yêu cầu.
    const giu = await giuYeuCau(tx, { id: t.yeuCauId, loai: LOAI_YEU_CAU, bam: t.bam });
    if (giu !== "MOI") {
      if (giu.cu.bamNoiDung !== t.bam) {
        // KHÔNG gợi "trả lại": ca thật hay gặp là lượt đầu ĐÃ ghi (mất phản hồi) rồi người dùng sửa form
        // bấm tiếp — đọc thành "trả lần nữa" là trả trùng.
        throw new LoiTraGop(
          "Mã yêu cầu này đã dùng cho một lượt trả khác đã ghi — kiểm tra danh sách trước khi trả thêm",
          "YEU_CAU_KHAC_NOI_DUNG",
        );
      }
      // Dòng đã commit mà chưa có kết quả = đường ghi quên bước (6). Trả `null` như "đã ghi rồi" là
      // nói dối chủ shop — nổ để thấy.
      if (giu.cu.ketQua === null || giu.cu.ketQua === undefined) {
        throw new LoiTraGop("Yêu cầu chưa hoàn tất — liên hệ quản trị trước khi trả lại", "YEU_CAU_CHUA_HOAN_TAT");
      }
      const cu = giu.cu.ketQua as { data?: KetQuaTraGop };
      if (cu.data === undefined) throw new LoiTraGop("Kết quả yêu cầu cũ hỏng — liên hệ quản trị", "YEU_CAU_CHUA_HOAN_TAT");
      return { cu: cu.data };
    }

    // (2) Khoá các phiếu được phân bổ.
    const ids = t.phanBo.map((p) => p.phieuNhapId);
    await khoaCacPhieu(tx, ids);

    // (3) Vân tay tính lại SAU khoá, trên dữ liệu đọc trong transaction.
    const rows = await docPhieuConNo(tx);
    const coThat = new Set(rows.map((r) => r.id));
    // Phiếu đã huỷ: nghĩa vụ đã về 0 — trả TIỀN MỚI vào đó gần như chắc là bấm nhầm. Tiền NCC trả lại
    // cho phiếu huỷ đi `SUPPLIER_REFUND`. Đọc `daHuy` SAU khoá: huỷ chen giữa cũng bị bắt.
    const daHuy = rows.filter((r) => r.daHuy && ids.includes(r.id));
    if (daHuy.length > 0) {
      throw new LoiTraGop(
        `Phiếu ${daHuy.map((r) => r.maPhieu).join(", ")} đã huỷ — không trả thêm tiền hàng; nhà cung cấp hoàn tiền thì ghi Hoàn tiền`,
        "PHIEU_DA_HUY",
        "phanBo",
      );
    }
    if (ids.some((id) => !coThat.has(id)) || vanTayPhieuConNo(rows) !== t.vanTay) {
      throw new LoiTraGop(
        "Danh sách phiếu nợ vừa thay đổi (có lượt trả/ghi nhận khác) — chưa ghi gì. Tải lại rồi phân bổ lại.",
        "DANH_SACH_DA_DOI",
      );
    }

    // (4) N dòng tiền, cùng mã yêu cầu để truy vết.
    const moTa = t.moTa ?? `Trả tiền hàng đợt ${format(t.ngay, "dd/MM")}`;
    const kq = await tx.cashMovement.createMany({
      data: t.phanBo.map((p) => ({
        date: t.ngay,
        kind: "SUPPLIER_PAY" as const,
        amount: p.soTien,
        phieuNhapId: p.phieuNhapId,
        yeuCauId: t.yeuCauId,
        description: moTa,
      })),
    });

    // (5) Nhật ký — `ghiChu` chỉ nhận khoá allowlist (không có `tong`: nhật ký không ghi số tiền).
    await ghiNhatKy(tx, {
      actor: t.nguoiDung,
      hanhDong: "DONG_TIEN_TAO",
      doiTuong: { loai: "CashMovement", moTa: `Trả tiền hàng gộp ${t.yeuCauId}` },
      ghiChu: { soDong: kq.count },
    });

    // (6) Kết quả, CÙNG transaction với dòng tiền.
    const moi: KetQuaTraGop = { daGhi: kq.count, tong: t.tong };
    await ghiKetQua(tx, t.yeuCauId, { ok: true, data: moi });
    return { moi };
  }, OPT_TX_DONG_TIEN);
}

/** Xung đột ghi (deadlock / 40001 lúc COMMIT) ⇒ thử lại ĐÚNG 1 lần (khuôn `chayTatToanCoRetry`). */
async function chayTraGopCoRetry(t: ThamSo): Promise<{ moi: KetQuaTraGop } | { cu: KetQuaTraGop }> {
  try {
    return await chayTraGop(t);
  } catch (e) {
    if (laXungDotGhi(e)) return await chayTraGop(t);
    throw e;
  }
}

/**
 * Trả tiền hàng gộp cho nhiều phiếu trong MỘT lượt. Input: `{ yeuCauId (uuid client sinh khi mở
 * modal), vanTay (của danh sách phiếu đang hiện), ngay ∈ [M, hôm nay], tong, phanBo[], moTa? }`.
 */
export async function traTienHangGop(input: unknown): Promise<ActionResult<KetQuaTraGop> | KetQuaDaGhiRoi> {
  const c = await congAction("tai-chinh-so-quy:sua");
  if (!c.ok) return c;
  const { nguoiDung } = c;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  let mocM: Date;
  try {
    mocM = await daBatNoPhaiTra();
  } catch (e) {
    if (e instanceof LoiChuaBat) return { ok: false, error: e.message, code: e.code };
    throw e;
  }

  const parsed = traGopSchema(mocM).safeParse(input);
  if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };
  const d = parsed.data;
  const ngay = startOfDay(d.ngay);

  // Vân tay nội dung = Ý ĐỊNH tiền (ngày, tổng, phân bổ, mô tả) — KHÔNG gồm vân tay danh sách: gửi lại
  // cùng mã sau khi tải lại trang (vân tay danh sách đã khác) vẫn là cùng một lượt trả ⇒ DA_GHI_ROI.
  const bam = bamNoiDung({
    loai: LOAI_YEU_CAU,
    ngay: format(ngay, "yyyy-MM-dd"),
    tong: d.tong,
    phanBo: d.phanBo,
    moTa: d.moTa ?? null,
  });

  try {
    const ket = await chayTraGopCoRetry({ ...d, ngay, nguoiDung, bam });
    if ("cu" in ket) return { ok: true, data: ket.cu, code: "DA_GHI_ROI" };
    lamMoiTrang();
    return { ok: true, data: ket.moi };
  } catch (e) {
    await ghiNhatKyLoi({
      actor: nguoiDung,
      hanhDong: "DONG_TIEN_TAO",
      doiTuong: { loai: "CashMovement", moTa: `Trả tiền hàng gộp ${d.yeuCauId}` },
      ghiChu: { lyDo: maLoiNhatKy(e) },
    });
    if (e instanceof LoiTraGop) return { ok: false, error: e.message, code: e.code, field: e.field };
    if (laLoiDongTienBan(e)) return { ok: false, error: THONG_BAO_KHOA_DONG_TIEN_BAN };
    console.error("Không ghi được đợt trả tiền hàng:", e);
    return { ok: false, error: "Không ghi được đợt trả tiền hàng — lỗi hệ thống, thử lại sau." };
  }
}
