import type { Prisma } from "@/generated/prisma/client";
import { LoiHopDong } from "@/lib/actions/khoan-vay-chung";
import { formatVnd } from "@/lib/format";
import { LoiChuaBat } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { docNguCanhLocTrongRequest } from "@/lib/no-phai-tra/doc-ngu-canh-loc";
import { docDuNoCacThe, type DbDocThe } from "@/lib/no-phai-tra/du-no-the";
import { ngayTrongThang, type PhaiTra } from "@/lib/no-phai-tra/ky-sao-ke";
import type { GanNenTang } from "@/lib/no-phai-tra/the-cua-dong-chi";
import { prisma } from "@/lib/prisma";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";
import {
  HAN_CHO_KHOA_DONG_TIEN_MS,
  khoaDongTienCoHan,
  laLoiDongTienBan,
  THONG_BAO_KHOA_DONG_TIEN_BAN,
} from "@/lib/so-quy/khoa-dong-tien-co-han";

/**
 * Hồ sơ thẻ tín dụng (spec `design.md` §5.1, §5.4, §5.5): khoá dòng, vị từ chặn xoá/đóng, đọc thẻ kèm
 * trạng thái cho khối "Nợ phải trả". Dư nợ KHÔNG có cột — luôn suy từ neo + giao dịch (`du-no-the.ts`).
 */

/**
 * Nền tảng ads được gắn thẻ. SHOPEE_ADS KHÔNG có ở đây: chủ shop trả lời Q2 (08/10) — ví Shopee Ads nạp
 * trước rồi chạy, tiền rời quỹ theo NGUỒN NẠP (`ADS_TOPUP`), không phải theo thẻ gánh ads.
 */
export const NEN_TANG_GAN_THE = ["META", "TIKTOK_ADS"] as const;

/**
 * KHOÁ DÒNG `TheTinDung` (`FOR UPDATE`) — gọi ĐẦU TIÊN trong mọi transaction đọc-rồi-ghi trên một thẻ
 * (sửa, đóng, xoá, gắn nền tảng, chốt sao kê, sau này `CARD_PAY`). Cùng khuôn `khoaKhoanVay`: ở
 * ReadCommitted, hai lượt không khoá cùng thấy "dư nợ 0 ⇒ đóng được" trong khi lượt kia đang ghi.
 * Chờ CÓ HẠN (ngân sách chung của transaction) — quá hạn ⇒ `LoiKhoaDongTienBan`, lùi trọn.
 * Không có dòng ⇒ 0 hàng, không khoá gì: caller tự báo "Không tìm thấy thẻ".
 */
export async function khoaThe(
  tx: Prisma.TransactionClient,
  cardId: string,
  hanChoMs: number = HAN_CHO_KHOA_DONG_TIEN_MS
): Promise<void> {
  await khoaDongTienCoHan(
    tx,
    [() => tx.$queryRaw`SELECT id FROM "TheTinDung" WHERE id = ${cardId} FOR UPDATE`],
    hanChoMs
  );
}

/**
 * Lý do KHÔNG xoá được thẻ (null = xoá được). Thẻ đã dính dữ liệu (dòng tiền / chi phí gắn thẻ, kỳ sao kê
 * THẬT, mốc gắn nền tảng) là một phần lịch sử dư nợ — xoá là các con số đó mất điểm tựa. Chỉ ĐÓNG.
 * `soDongTien` = `CashMovement` + `Expense` gắn `cardId`.
 *
 * Neo mở sổ KHÔNG tự chặn: thẻ thêm sau khi bật luôn có neo (bắt buộc, `soDu = 0`) — chặn theo neo là thẻ
 * tạo nhầm không bao giờ xoá được. Neo `soDu = 0` không mang số nào ⇒ xoá kèm thẻ. CHỈ chặn neo `soDu > 0`
 * (`soNeoCoSo`): neo đó do bước bật sinh, đi kèm `CUTOVER_*` "nợ thẻ X" trong quỹ — xoá thẻ là khoản điều
 * chỉnh quỹ mồ côi (quỹ vẫn cộng mà không còn nợ tương ứng).
 */
export function lyDoKhongXoaThe(p: {
  soDongTien: number;
  soDongGan: number;
  soKyThat: number;
  soNeoCoSo: number;
}): string | null {
  if (p.soDongTien > 0) return "Thẻ đã có giao dịch (trả thẻ / chi phí trừ vào thẻ) — chỉ đóng được, không xoá";
  if (p.soKyThat > 0) return "Thẻ đã có kỳ sao kê — chỉ đóng được, không xoá";
  if (p.soNeoCoSo > 0) {
    return "Thẻ có dư nợ mở sổ khác 0 (khai ở bước bật, đã đưa vào điều chỉnh quỹ) — chỉ đóng được, không xoá";
  }
  if (p.soDongGan > 0) return "Thẻ đã gắn nền tảng quảng cáo — chỉ đóng được, không xoá";
  return null;
}

/** Đếm kỳ sao kê thật / neo mở sổ có số — đầu vào của `lyDoKhongXoaThe`. */
export function demKyCuaThe(kys: readonly { laNeoMoSo: boolean; soDu: number }[]): { soKyThat: number; soNeoCoSo: number } {
  return {
    soKyThat: kys.filter((k) => !k.laNeoMoSo).length,
    soNeoCoSo: kys.filter((k) => k.laNeoMoSo && k.soDu > 0).length,
  };
}

/**
 * Lý do KHÔNG đóng được thẻ (null = đóng được) — spec §5.1: chỉ đóng khi dư nợ ước tính = 0, không nền
 * tảng nào đang gắn, kỳ mới nhất còn phải trả = 0. `duNo` null (chưa có neo — vd trước khi bật) không chặn:
 * chưa theo dõi thì không có nợ nào để bỏ sót. Dư nợ ÂM (trả thừa) cũng chặn: tiền đó ngân hàng còn giữ.
 */
export function lyDoKhongDongThe(p: { duNo: number | null; coNenTangDangGan: boolean; nghiaVuKy: number }): string | null {
  if (p.duNo !== null && p.duNo !== 0) {
    return `Thẻ còn dư nợ ước tính ${formatVnd(p.duNo)} — dư nợ phải về 0 mới đóng được`;
  }
  if (p.nghiaVuKy > 0) return `Kỳ sao kê mới nhất còn phải trả ${formatVnd(p.nghiaVuKy)}`;
  if (p.coNenTangDangGan) return "Thẻ đang gánh quảng cáo — gắn nền tảng sang thẻ khác trước khi đóng";
  return null;
}

/**
 * Nền tảng mà thẻ ĐANG hoặc SẼ gánh tính theo ngày `homNay` (VN): với từng nền tảng, xét mốc gắn hiện
 * hành (tuNgay lớn nhất ≤ hôm nay) cùng mọi mốc tương lai — thẻ nằm trong đó ⇒ vẫn còn ads đổ về thẻ.
 * KHÔNG phụ thuộc M: trước khi bật, mốc gắn vẫn là ý định gánh của hồ sơ.
 */
export function nenTangDangGanThe(gan: readonly GanNenTang[], cardId: string, homNay: Date): string[] {
  const kHomNay = khoaNgayVn(homNay);
  const ketQua: string[] = [];
  for (const nenTang of new Set(gan.map((g) => g.nenTang))) {
    const cua = gan
      .filter((g) => g.nenTang === nenTang)
      .sort((a, b) => a.tuNgay.getTime() - b.tuNgay.getTime());
    let batDau = 0;
    cua.forEach((g, i) => {
      if (khoaNgayVn(g.tuNgay) <= kHomNay) batDau = i;
    });
    if (cua.slice(batDau).some((g) => g.cardId === cardId)) ketQua.push(nenTang);
  }
  return ketQua;
}

/** Từ chối có MÃ máy đọc được (UI/test phân biệt không cần so câu chữ) — vd `GAN_LUI_NGAY`. */
export class LoiTheCoMa extends LoiHopDong {
  constructor(
    public readonly code: string,
    message: string,
    field?: string
  ) {
    super(message, field);
    this.name = "LoiTheCoMa";
  }
}

/**
 * Ánh xạ lỗi chung cho action thẻ (hồ sơ + chốt sao kê). P2002 KHÔNG xử lý ở đây — mỗi action biết
 * unique nào của mình có thể vỡ (gắn trùng mốc / chốt trùng ngày).
 */
export function loiThe(e: unknown, macDinh: string): { error: string; field?: string; code?: string } {
  if (e instanceof LoiTheCoMa) return { error: e.message, field: e.field, code: e.code };
  if (e instanceof LoiHopDong) return { error: e.message, field: e.field };
  if (e instanceof LoiChuaBat) return { error: e.message, code: e.code };
  if (laLoiDongTienBan(e)) return { error: THONG_BAO_KHOA_DONG_TIEN_BAN };
  if ((e as { code?: string })?.code === "P2025") return { error: "Không tìm thấy thẻ" };
  return { error: macDinh };
}

export type MocGanThe = { id: string; nenTang: string; tuNgay: Date; xoaDuoc: boolean };
export type KySaoKeGanNhat = {
  ngayChot: Date;
  soDu: number;
  hanTra: Date | null;
  laNeoMoSo: boolean;
  uocTinhLucChot: number | null;
};

export type TheKemTrangThai = {
  id: string;
  ten: string;
  nganHang: string;
  ngayChotSaoKe: number;
  ngayHanTra: number;
  closedAt: Date | null;
  note: string;
  /** null = chưa có neo ≤ hôm nay. */
  duNo: number | null;
  /** null = chưa có kỳ sao kê có hạn. */
  phaiTra: PhaiTra | null;
  kyGanNhat: KySaoKeGanNhat | null;
  gan: MocGanThe[];
  nenTangDangGan: string[];
  /**
   * Đã bật, thẻ còn mở, và chưa có kỳ nào (neo hay sao kê) với `ngayChot ≥ ngày chốt gần nhất ≤ hôm qua`
   * (`ngayChotGanNhat`). Neo tính là "đã có": neo ở/ sau ngày đó đã là điểm xuất phát dư nợ cho ngày đó.
   */
  chuaChotKyGanNhat: boolean;
  lyDoKhongXoa: string | null;
  lyDoKhongDong: string | null;
};

/**
 * Ngày chốt sao kê GẦN NHẤT đã qua trọn (≤ hôm qua, khoá ngày VN): ngày chốt tháng này nếu ≤ hôm qua, không
 * thì của tháng trước. `ngayTrongThang` kẹp ngày 29–31 về cuối tháng — so "hôm nay > ngày chốt tháng này"
 * thì thẻ chốt ngày 31 không bao giờ được nhắc (ngày chốt kẹp = ngày cuối tháng, hôm nay không thể lớn hơn).
 */
export function ngayChotGanNhat(homNay: Date, ngayChotSaoKe: number): string {
  const kHomQua = khoaNgayVn(new Date(homNay.getTime() - 86_400_000));
  const [nam, thang] = kHomQua.split("-").map(Number);
  const thangNay = ngayTrongThang(nam, thang, ngayChotSaoKe);
  if (thangNay <= kHomQua) return thangNay;
  return thang === 1 ? ngayTrongThang(nam - 1, 12, ngayChotSaoKe) : ngayTrongThang(nam, thang - 1, ngayChotSaoKe);
}

/** Mọi thẻ (mở trước, đóng sau) kèm dư nợ ước tính, kỳ gần nhất, mốc gắn và lý do chặn xoá/đóng. */
export async function docTheKemTrangThai(
  db: DbDocThe = prisma,
  homNay: Date = new Date()
): Promise<TheKemTrangThai[]> {
  // Đường render: dùng bản nhớ theo request để cùng bản chụp với thẻ Quỹ trên cùng trang.
  const ctx = await docNguCanhLocTrongRequest();
  const [the, duNoCacThe, kyMoiThe, demTien, demChi, ganDayDu] = await Promise.all([
    db.theTinDung.findMany({ orderBy: [{ closedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }] }),
    docDuNoCacThe(homNay, db, ctx),
    db.kySaoKeThe.findMany({
      select: { cardId: true, ngayChot: true, soDu: true, hanTra: true, laNeoMoSo: true, uocTinhLucChot: true },
      orderBy: { ngayChot: "desc" },
    }),
    db.cashMovement.groupBy({ by: ["cardId"], where: { cardId: { not: null } }, _count: { _all: true } }),
    db.expense.groupBy({ by: ["cardId"], where: { cardId: { not: null } }, _count: { _all: true } }),
    db.ganNenTangThe.findMany({ select: { id: true, cardId: true, nenTang: true, tuNgay: true }, orderBy: { tuNgay: "asc" } }),
  ]);

  const kHomNay = khoaNgayVn(homNay);
  const duNoTheo = new Map(duNoCacThe.map((d) => [d.cardId, d]));
  const dem = (rows: { cardId: string | null; _count: { _all: number } }[], id: string) =>
    rows.find((r) => r.cardId === id)?._count._all ?? 0;

  return the.map((t) => {
    const kys = kyMoiThe.filter((k) => k.cardId === t.id);
    const gan = ganDayDu.filter((g) => g.cardId === t.id);
    const d = duNoTheo.get(t.id);
    const nenTangDangGan = nenTangDangGanThe(ctx.gan, t.id, homNay);
    const kChotGanNhat = ngayChotGanNhat(homNay, t.ngayChotSaoKe);
    const daCoKyGanNhat = kys.some((k) => khoaNgayVn(k.ngayChot) >= kChotGanNhat);
    const ky0 = kys[0];
    return {
      id: t.id,
      ten: t.ten,
      nganHang: t.nganHang,
      ngayChotSaoKe: t.ngayChotSaoKe,
      ngayHanTra: t.ngayHanTra,
      closedAt: t.closedAt,
      note: t.note,
      duNo: d?.duNo ?? null,
      phaiTra: d?.phaiTra ?? null,
      kyGanNhat: ky0
        ? { ngayChot: ky0.ngayChot, soDu: ky0.soDu, hanTra: ky0.hanTra, laNeoMoSo: ky0.laNeoMoSo, uocTinhLucChot: ky0.uocTinhLucChot }
        : null,
      gan: gan.map((g) => ({ id: g.id, nenTang: g.nenTang, tuNgay: g.tuNgay, xoaDuoc: khoaNgayVn(g.tuNgay) > kHomNay })),
      nenTangDangGan,
      chuaChotKyGanNhat: ctx.mocM !== null && t.closedAt === null && !daCoKyGanNhat,
      lyDoKhongXoa: lyDoKhongXoaThe({
        soDongTien: dem(demTien, t.id) + dem(demChi, t.id),
        soDongGan: gan.length,
        ...demKyCuaThe(kys),
      }),
      lyDoKhongDong:
        t.closedAt !== null
          ? "Thẻ đã đóng"
          : lyDoKhongDongThe({
              duNo: d?.duNo ?? null,
              coNenTangDangGan: nenTangDangGan.length > 0,
              nghiaVuKy: d?.phaiTra?.nghiaVuKy ?? 0,
            }),
    };
  });
}
