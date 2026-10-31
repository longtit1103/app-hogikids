"use server";

import { format } from "date-fns";
import { z } from "zod";

import type { ActionResult } from "@/lib/actions/action-result";
import { LoiHopDong } from "@/lib/actions/khoan-vay-chung";
import { lamMoiTrang } from "@/lib/actions/lam-moi-trang";
import { mapZodError } from "@/lib/actions/map-zod-error";
import { vaoCuaGhi } from "@/lib/backup/cong-ghi-toan-cuc";
import { formatVnd } from "@/lib/format";
import { ghiNhatKy } from "@/lib/nhat-ky/ghi-nhat-ky";
import { daBatNoPhaiTra } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { docNguCanhLoc } from "@/lib/no-phai-tra/doc-ngu-canh-loc";
import {
  docFileSaoKe,
  doiChieuSaoKeVoiApp,
  dongSaoKeDeGhi,
  lyDoHoaDonTiktokChuaDu,
  tachSaoKe,
  theGanhTiktokNgay,
} from "@/lib/no-phai-tra/doi-chieu-sao-ke-voi-app";
import { dauNgayVn } from "@/lib/no-phai-tra/du-no-the";
import { ghiKySaoKe, khoaVaDocTheMo } from "@/lib/no-phai-tra/ghi-ky-sao-ke";
import { ngayTienMoiSchema } from "@/lib/no-phai-tra/ngay-tien-moi-schema";
import type { NguCanhLoc } from "@/lib/no-phai-tra/the-cua-dong-chi";
import { LoiTheCoMa, loiThe } from "@/lib/no-phai-tra/the-tin-dung-queries";
import { uocTinhDuNoTai } from "@/lib/no-phai-tra/uoc-tinh-du-no-tai";
import { bamNoiDung, ghiKetQua, giuYeuCau } from "@/lib/no-phai-tra/yeu-cau-ghi";
import { rangBuocTrungKhoa } from "@/lib/prisma-loi-adapter";
import { prisma } from "@/lib/prisma";
import { congChuShopAction } from "@/lib/quyen/cong-action";
import { kiemSoCuoiThe } from "@/lib/sao-ke-the/cong-chot-sao-ke";
import { lyDoGiaoDichSaiNgay, lyDoTraTheMoHo, type KetQuaDoiChieu } from "@/lib/sao-ke-the/doi-chieu-sao-ke-the";
import type { DongSaoKe, SaoKeThe } from "@/lib/sao-ke-the/techcombank-sao-ke-parser";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";
import { OPT_TX_DONG_TIEN } from "@/lib/so-quy/khoa-dong-tien-co-han";

/**
 * NHẬP SAO KÊ THẺ (PDF Techcombank) — chỉ chủ shop, cùng diện `chotSaoKe`.
 *
 * Bước 1 `xemTruocSaoKeThe`: đọc file → tách dòng → ghép với giao dịch thẻ của app → số đề xuất = dư nợ sao kê +
 * bill ghi sổ trễ + chi thẻ chưa lên sao kê − trả thẻ chưa lên sao kê − hoàn TikTok chưa lên sao kê, kèm dòng lạ / lần
 * trả thẻ chưa ghi. Không ghi gì.
 * CHẶN chốt (cả hai bước, server tự kiểm) khi: hoá đơn TikTok ngày sao kê có thể chưa về app (trước D+2 hoặc chưa có
 * lượt kéo từ D+2), giao dịch app ghi ngày sau ngày sao kê mà sao kê đã có (sẽ tính hai lần), tên thẻ mang 4 số khác.
 * Bước 2 `chotSaoKeTuPdf`: client gửi LẠI file + số chốt + số đề xuất đã thấy. File không lưu ở server, nên server
 * đọc + tách lại, rồi đối chiếu lại TRONG transaction sau khoá thẻ; số đề xuất tính lại khác số client thấy ⇒
 * `SO_DA_DOI` (không tin client). Ngày chốt + HẠN TRẢ lấy từ sao kê in trên file (hạn client gửi khác hạn in ⇒ vẫn dùng
 * hạn in, trả kèm cảnh báo + ghi nhật ký). Ghi một kỳ sao kê qua lõi chung `ghi-ky-sao-ke.ts` (cùng luật ngày `[M, hôm qua]`,
 * `hanTra > ngayChot`, 00:00 VN) + tổng trả thẻ chưa lên sao kê (nghĩa vụ kỳ = số sao kê − phần đó) + dòng sao kê +
 * nhật ký + kết quả yêu cầu ghi — MỘT transaction, idempotent theo
 * `yeuCauId` + vân tay nội dung. Một file chỉ nhập một lần cho một thẻ (unique có điều kiện trên `saoKeHash`).
 *
 * KHÔNG ghi Sổ chi phí, KHÔNG thêm dòng tiền: dòng lạ (phí, mua khác, hoàn phí) chỉ LIỆT KÊ. Quỹ + P&L không đổi.
 */

const LOAI_YEU_CAU = "CHOT_SAO_KE_PDF";
const INDEX_MOT_SAO_KE_PDF = "KySaoKeThe_mot_sao_ke_pdf_moi_the";

/** Bản xem trước gửi về modal — KHÔNG gửi toàn bộ dòng sao kê (vài trăm dòng), chỉ phần cần quyết định. */
export type XemTruocSaoKe = {
  saoKe: Omit<SaoKeThe, "dong"> & { soDong: number };
  ketQua: Omit<KetQuaDoiChieu, "khop" | "khopHoan"> & { soKhop: number; soKhopHoan: number };
  /** Dư nợ app tự tính cuối ngày sao kê (neo cũ + giao dịch); null = thẻ chưa có neo ≤ ngày đó. */
  uocTinhApp: number | null;
  /** sha256 file — modal gửi lại để server biết đúng file đã xem. */
  hash: string;
  ngayChotTruoc: string | null;
  /** Lần trả nợ trên sao kê chưa có "Trả thẻ" trong app ⇒ nhắc ghi ở Nhập quỹ. */
  thanhToanChuaGhi: DongSaoKe[];
  /** null = chốt được; khác null = chỉ xem (lý do). */
  lyDoKhongChot: string | null;
  canhBao: string[];
};

export type KetQuaChotSaoKePdf = {
  id: string;
  cardId: string;
  /** `yyyy-MM-dd` VN = ngày sao kê. */
  ngayChot: string;
  soDu: number;
  soDeXuat: number;
  uocTinh: number | null;
  /** Hạn trả client gửi khác hạn in trên sao kê ⇒ app đã dùng hạn in; câu nói rõ hai ngày. */
  canhBaoHanTra?: string;
};

export type KetQuaActionChotSaoKePdf =
  | { ok: true; data: KetQuaChotSaoKePdf; code?: "DA_GHI_ROI" }
  | { ok: false; error: string; field?: string; code?: string };

const chuoi = (fd: FormData, k: string): string => {
  const v = fd.get(k);
  return typeof v === "string" ? v : "";
};

/** Kỳ sao kê chỉ giữ dư nợ ≥ 0 (CHECK `KySaoKeThe_so_du_khong_am`) — sao kê dư có (trả thừa) chưa hỗ trợ. */
const LOI_DU_CO = "Sao kê đang dư có (trả thừa) — app chưa hỗ trợ, chỉ xem";

/** Lý do chặn vì hoá đơn TikTok ngày sao kê có thể chưa về app — chỉ khi thẻ gánh TikTok Ads ngày đó. */
async function lyDoHoaDonChuaVe(
  db: Parameters<typeof lyDoHoaDonTiktokChuaDu>[0],
  ctx: NguCanhLoc,
  cardId: string,
  ngaySaoKe: string
): Promise<string | null> {
  if (!theGanhTiktokNgay(ctx, cardId, ngaySaoKe)) return null;
  return lyDoHoaDonTiktokChuaDu(db, ngaySaoKe, khoaNgayVn(new Date()));
}

/** Câu nhắc ghi "Trả thẻ" cho lần trả có trên sao kê mà app chưa có. */
function cauTraTheChuaGhi(d: DongSaoKe, ngaySaoKe: string): string {
  const ngay = (k: string) => `${k.slice(8, 10)}/${k.slice(5, 7)}`;
  return (
    `Trả thẻ ${formatVnd(d.ghiCo)} ngày ${ngay(d.ngayGiaoDich)} chưa ghi trong app — ghi "Trả thẻ" ở Nhập quỹ với ĐÚNG ngày ` +
    `ngân hàng (≤ ${ngay(ngaySaoKe)}): số đề xuất đã trừ lần trả này, ghi ngày ≤ ngày sao kê thì app không trừ lần hai; ` +
    `ghi ngày sau ngày sao kê sẽ trừ hai lần.`
  );
}

/** `yyyy-MM-dd` ⇒ `dd/MM/yyyy`. */
const ngayDayDu = (k: string): string => `${k.slice(8, 10)}/${k.slice(5, 7)}/${k.slice(0, 4)}`;

/** Hạn client gửi (rỗng = không gửi) khác hạn in trên sao kê ⇒ câu cảnh báo; trùng / không gửi ⇒ null. */
function cauHanTraKhacSaoKe(hanClient: string, hanSaoKe: string): string | null {
  if (hanClient === "" || hanClient === hanSaoKe) return null;
  return `Hạn trả nhập ${ngayDayDu(hanClient)} khác hạn in trên sao kê ${ngayDayDu(hanSaoKe)} — đã dùng hạn trên sao kê`;
}

/** Lý do sao kê KHÔNG chốt được (null = chốt được) — cùng luật ngày của chốt gõ tay. */
function lyDoSaoKeKhongChot(saoKe: SaoKeThe, mocM: Date): string | null {
  if (saoKe.duNoCuoiKy < 0) return LOI_DU_CO;
  const { ngaySaoKe } = saoKe;
  if (ngaySaoKe < khoaNgayVn(mocM)) return `Sao kê trước ngày bật theo dõi nợ (${format(mocM, "dd/MM/yyyy")}) — chỉ xem`;
  if (ngaySaoKe >= khoaNgayVn(new Date())) return "Ngày sao kê phải trước hôm nay — chỉ xem";
  const loiHan = loiHanTraPdf(saoKe);
  if (loiHan !== null) return `${loiHan} — chỉ xem`;
  return null;
}

/** Hạn trả IN trên PDF không sau ngày sao kê ⇒ file đọc sai / lạ (hạn lấy từ file, chủ shop không sửa được). */
function loiHanTraPdf(saoKe: SaoKeThe): string | null {
  if (saoKe.hanTra > saoKe.ngaySaoKe) return null;
  return `Sao kê in hạn trả ${ngayDayDu(saoKe.hanTra)} không sau ngày sao kê ${ngayDayDu(saoKe.ngaySaoKe)} — file có thể đọc sai`;
}

export async function xemTruocSaoKeThe(formData: FormData): Promise<ActionResult<XemTruocSaoKe>> {
  const c = await congChuShopAction();
  if (!c.ok) return c;

  let mocM: Date;
  try {
    mocM = await daBatNoPhaiTra();
  } catch (e) {
    return { ok: false, ...loiThe(e, "Lỗi khi đọc mốc bật theo dõi nợ") };
  }
  const cardId = chuoi(formData, "cardId");
  if (cardId === "") return { ok: false, error: "Chọn thẻ", field: "cardId" };
  const doc = await docFileSaoKe(formData);
  if (!doc.ok) return doc;
  const tach = await tachSaoKe(doc.file.buf);
  if (!tach.ok) return tach;
  const { saoKe } = tach;
  const { hash } = doc.file;

  try {
    const the = await prisma.theTinDung.findUnique({ where: { id: cardId }, select: { ten: true, note: true, closedAt: true } });
    if (!the) return { ok: false, error: "Không tìm thấy thẻ", field: "cardId" };
    const ctx = await docNguCanhLoc();
    const [dc, uocTinhApp, daNhap, chuaVe] = await Promise.all([
      doiChieuSaoKeVoiApp(prisma, cardId, saoKe, ctx),
      uocTinhDuNoTai(cardId, saoKe.ngaySaoKe),
      prisma.kySaoKeThe.findFirst({ where: { cardId, saoKeHash: hash }, select: { createdAt: true } }),
      lyDoHoaDonChuaVe(prisma, ctx, cardId, saoKe.ngaySaoKe),
    ]);

    const canhBao: string[] = [];
    const soThe = kiemSoCuoiThe(the.ten, the.note, saoKe.soCuoiThe);
    if (soThe.canhBao !== null) canhBao.push(soThe.canhBao);
    if (dc.viTraDaBo.soLan > 0) {
      canhBao.push(`Đã bỏ ${dc.viTraDaBo.soLan} hoá đơn TikTok ví TikTok Shop trả (${formatVnd(dc.viTraDaBo.tong)}) — không lên sao kê ngân hàng.`);
    }
    for (const d of dc.thanhToanChuaGhi) canhBao.push(cauTraTheChuaGhi(d, saoKe.ngaySaoKe));

    const lyDoKhongChot =
      (the.closedAt !== null ? "Thẻ đã đóng — chỉ xem" : null) ??
      (daNhap ? `Sao kê này đã nhập ngày ${format(daNhap.createdAt, "dd/MM/yyyy")} — chỉ xem` : null) ??
      lyDoSaoKeKhongChot(saoKe, mocM) ??
      (dc.coKyNgaySaoKe ? "Thẻ đã có kỳ sao kê ngày này — chỉ xem" : null) ??
      soThe.chan ??
      chuaVe ??
      lyDoTraTheMoHo(dc.ketQua) ??
      lyDoGiaoDichSaiNgay(dc.ketQua);

    const { dong, ...tomTat } = saoKe;
    const { khop, khopHoan, ...ketQua } = dc.ketQua;
    return {
      ok: true,
      data: {
        saoKe: { ...tomTat, soDong: dong.length },
        ketQua: { ...ketQua, soKhop: khop.length, soKhopHoan: khopHoan.length },
        uocTinhApp,
        hash,
        ngayChotTruoc: dc.ngayChotTruoc,
        thanhToanChuaGhi: dc.thanhToanChuaGhi,
        lyDoKhongChot,
        canhBao,
      },
    };
  } catch (e) {
    console.error("Lỗi xem trước sao kê thẻ:", e);
    return { ok: false, ...loiThe(e, "Lỗi khi đối chiếu sao kê — thử lại") };
  }
}

const chotSchema = z.object({
  yeuCauId: z.string().uuid("Mã yêu cầu không hợp lệ — tải lại trang rồi thử lại"),
  cardId: z.string().min(1, "Chọn thẻ"),
  hash: z.string().regex(/^[0-9a-f]{64}$/, "Xem trước lại file sao kê"),
  // Chuỗi số nguyên — KHÔNG `z.coerce` (ô trống thành 0 là chốt nhầm dư nợ 0).
  soDu: z
    .string()
    .regex(/^\d{1,10}$/, "Nhập số chốt (số nguyên không âm)")
    .transform(Number)
    .refine((n) => n <= 2_000_000_000, "Số tiền quá lớn (tối đa 2 tỷ)"),
  soDeXuat: z.string().regex(/^-?\d{1,10}$/, "Số đề xuất không hợp lệ — xem trước lại").transform(Number),
  // Chỉ để SO với hạn in trên sao kê (ngày ghi lấy từ file); rỗng = không so.
  hanTra: z.string().regex(/^(?:\d{4}-\d{2}-\d{2})?$/, "Ngày không hợp lệ"),
  note: z.string().trim().max(500, "Tối đa 500 ký tự").default(""),
}).superRefine((v, c) => {
  // Số chốt khác số app đề xuất ⇒ phải nói vì sao (nhật ký có số, cần cả lý do để soi lại sau).
  if (v.soDu !== v.soDeXuat && v.note === "") {
    c.addIssue({ code: "custom", path: ["note"], message: "Số chốt khác số đề xuất — ghi chú lý do sửa" });
  }
});

export async function chotSaoKeTuPdf(formData: FormData): Promise<KetQuaActionChotSaoKePdf> {
  const c = await congChuShopAction();
  if (!c.ok) return c;
  const { nguoiDung } = c;
  const cua = vaoCuaGhi();
  if (!cua.ok) return cua.loi;
  try {

    let mocM: Date;
    try {
      mocM = await daBatNoPhaiTra();
    } catch (e) {
      return { ok: false, ...loiThe(e, "Lỗi khi đọc mốc bật theo dõi nợ") };
    }

    const parsed = chotSchema.safeParse({
      yeuCauId: chuoi(formData, "yeuCauId"),
      cardId: chuoi(formData, "cardId"),
      hash: chuoi(formData, "hash"),
      soDu: chuoi(formData, "soDu"),
      soDeXuat: chuoi(formData, "soDeXuat"),
      hanTra: chuoi(formData, "hanTra"),
      note: chuoi(formData, "note"),
    });
    if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };
    const { yeuCauId, cardId, hash, soDu, soDeXuat, note } = parsed.data;

    const doc = await docFileSaoKe(formData);
    if (!doc.ok) return doc;
    if (doc.file.hash !== hash) return { ok: false, error: "File khác file đã xem trước — chọn lại file", code: "FILE_DA_DOI" };
    const tach = await tachSaoKe(doc.file.buf);
    if (!tach.ok) return tach;
    const { saoKe } = tach;
    if (saoKe.duNoCuoiKy < 0) return { ok: false, error: LOI_DU_CO };

    // Ngày chốt + hạn trả = ngày IN trên file (không lấy từ client). Cùng luật chốt gõ tay: ∈ [M, hôm qua], hạn > chốt.
    const ngayChot = dauNgayVn(new Date(`${saoKe.ngaySaoKe}T00:00:00+07:00`));
    const hanTra = dauNgayVn(new Date(`${saoKe.hanTra}T00:00:00+07:00`));
    const canhBaoHanTra = cauHanTraKhacSaoKe(parsed.data.hanTra, saoKe.hanTra);
    const ngay = ngayTienMoiSchema(mocM).safeParse(ngayChot);
    if (!ngay.success) return { ok: false, ...mapZodError(ngay.error), field: "ngayChot" };
    const khoaChot = khoaNgayVn(ngayChot);
    if (khoaChot >= khoaNgayVn(new Date())) return { ok: false, error: "Ngày sao kê phải trước hôm nay", field: "ngayChot" };
    // Hạn lấy từ FILE ⇒ lỗi không trỏ vào ô nào (chủ shop không sửa được), nói rõ là do sao kê in.
    const loiHan = loiHanTraPdf(saoKe);
    if (loiHan !== null || Number.isNaN(hanTra.getTime())) {
      return { ok: false, error: loiHan ?? "Không đọc được hạn trả trên sao kê", code: "HAN_TRA_PDF" };
    }
    const bam = bamNoiDung({ cardId, hash, ngayChot: khoaChot, soDu, soDeXuat, hanTra: khoaNgayVn(hanTra), note });

    try {
      const kq = await prisma.$transaction(async (tx) => {
        const giu = await giuYeuCau(tx, { id: yeuCauId, loai: LOAI_YEU_CAU, bam });
        if (giu !== "MOI") {
          if (giu.cu.bamNoiDung !== bam) throw new LoiHopDong("Mã yêu cầu đã dùng cho nội dung khác");
          if (giu.cu.ketQua === null) throw new Error(`YeuCauGhi ${yeuCauId}: yêu cầu chưa hoàn tất`);
          return { daGhiRoi: true as const, data: (giu.cu.ketQua as { data: KetQuaChotSaoKePdf }).data };
        }

        const the = await khoaVaDocTheMo(tx, cardId);
        const daNhap = await tx.kySaoKeThe.findFirst({ where: { cardId, saoKeHash: hash }, select: { createdAt: true } });
        if (daNhap) {
          throw new LoiTheCoMa("SAO_KE_DA_NHAP", `Sao kê này đã nhập ngày ${format(daNhap.createdAt, "dd/MM/yyyy")}`);
        }
        const ghiChuThe = await tx.theTinDung.findUnique({ where: { id: cardId }, select: { note: true } });
        const chanThe = kiemSoCuoiThe(the.ten, ghiChuThe?.note ?? "", saoKe.soCuoiThe).chan;
        if (chanThe !== null) throw new LoiTheCoMa("SAI_THE", chanThe, "cardId");

        // Đối chiếu LẠI sau khoá thẻ trên dữ liệu tươi — số đề xuất là của server, không phải của client.
        const ctx = await docNguCanhLoc(tx);
        const chuaVe = await lyDoHoaDonChuaVe(tx, ctx, cardId, saoKe.ngaySaoKe);
        if (chuaVe !== null) throw new LoiTheCoMa("HOA_DON_CHUA_VE", chuaVe, "ngayChot");
        const dc = await doiChieuSaoKeVoiApp(tx, cardId, saoKe, ctx);
        const moHo = lyDoTraTheMoHo(dc.ketQua);
        if (moHo !== null) throw new LoiTheCoMa("TRA_THE_MO_HO", moHo);
        const saiNgay = lyDoGiaoDichSaiNgay(dc.ketQua);
        if (saiNgay !== null) throw new LoiTheCoMa("GIAO_DICH_SAI_NGAY", saiNgay);
        if (dc.ketQua.soDeXuat !== soDeXuat) {
          throw new LoiTheCoMa(
            "SO_DA_DOI",
            `Số đề xuất đã đổi thành ${formatVnd(dc.ketQua.soDeXuat)} (dữ liệu app vừa cập nhật) — xem trước lại`
          );
        }

        const { kyId, uocTinh } = await ghiKySaoKe(tx, {
          cardId,
          ngayChot,
          hanTra,
          soDu,
          note,
          ctx,
          saoKe: {
            soDu: saoKe.duNoCuoiKy,
            tongBillGhiSoTre: dc.ketQua.tongBillGhiSoTre,
            traChuaLen: dc.ketQua.tongTraChuaLenSaoKe,
            hash,
            dong: dongSaoKeDeGhi(saoKe, dc.ketQua),
          },
        });
        const data: KetQuaChotSaoKePdf = {
          id: kyId,
          cardId,
          ngayChot: khoaChot,
          soDu,
          soDeXuat,
          uocTinh,
          ...(canhBaoHanTra === null ? {} : { canhBaoHanTra }),
        };

        // `ghiChu` chỉ nhận khoá allowlist (không có ô tiền) ⇒ các con số đi vào `moTa`.
        await ghiNhatKy(tx, {
          actor: nguoiDung,
          hanhDong: "CHOT_SAO_KE_PDF",
          doiTuong: {
            loai: "KySaoKeThe",
            id: kyId,
            moTa:
              `${the.ten} ${format(ngayChot, "dd/MM/yyyy")}: chốt ${formatVnd(soDu)} · sao kê ${formatVnd(saoKe.duNoCuoiKy)}` +
              ` + ${dc.ketQua.billGhiSoTre.length} bill ghi sổ trễ ${formatVnd(dc.ketQua.tongBillGhiSoTre)}` +
              (dc.ketQua.chiTayChuaLenSaoKe.length > 0
                ? ` + ${dc.ketQua.chiTayChuaLenSaoKe.length} chi thẻ chưa lên sao kê ${formatVnd(dc.ketQua.tongChiTayChuaLenSaoKe)}`
                : "") +
              (dc.ketQua.traChuaLenSaoKe.length > 0
                ? ` − ${dc.ketQua.traChuaLenSaoKe.length} trả thẻ chưa lên sao kê ${formatVnd(dc.ketQua.tongTraChuaLenSaoKe)}`
                : "") +
              (dc.ketQua.hoanGhiSoTre.length > 0
                ? ` − ${dc.ketQua.hoanGhiSoTre.length} hoàn TikTok chưa lên sao kê ${formatVnd(dc.ketQua.tongHoanGhiSoTre)}`
                : "") +
              ` = đề xuất ${formatVnd(soDeXuat)}` +
              (uocTinh === null ? "" : ` · ước tính ${formatVnd(uocTinh)}`) +
              (canhBaoHanTra === null ? "" : ` · ${canhBaoHanTra}`),
          },
          ghiChu: { ky: khoaChot, soDong: saoKe.dong.length },
        });
        await ghiKetQua(tx, yeuCauId, { ok: true, data });
        return { daGhiRoi: false as const, data };
      }, OPT_TX_DONG_TIEN);

      if (kq.daGhiRoi) return { ok: true, data: kq.data, code: "DA_GHI_ROI" };
      lamMoiTrang();
      return { ok: true, data: kq.data };
    } catch (e) {
      // Hai unique có thể vỡ: một file một lần (`saoKeHash`) — lượt chốt đồng thời cùng file; `(cardId, ngayChot)` —
      // thẻ đã có kỳ/neo ngày sao kê. Bước giữ mã dùng ON CONFLICT nên không vỡ unique.
      const trung = rangBuocTrungKhoa(e);
      if (trung !== undefined) {
        if (trung.index === INDEX_MOT_SAO_KE_PDF || trung.fields?.includes("saoKeHash")) {
          return { ok: false, error: "Sao kê này đã nhập cho thẻ này", code: "SAO_KE_DA_NHAP" };
        }
        return { ok: false, error: `Thẻ đã có kỳ/neo ở ngày này (${format(ngayChot, "dd/MM/yyyy")})`, field: "ngayChot" };
      }
      return { ok: false, ...loiThe(e, "Lỗi khi chốt sao kê") };
    }
  } finally {
    cua.ra();
  }
}
