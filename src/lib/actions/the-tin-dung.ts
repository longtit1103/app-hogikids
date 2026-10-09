"use server";

import { format } from "date-fns";
import { z } from "zod";

import type { ActionResult } from "@/lib/actions/action-result";
import { LoiHopDong } from "@/lib/actions/khoan-vay-chung";
import { lamMoiTrang } from "@/lib/actions/lam-moi-trang";
import { mapZodError } from "@/lib/actions/map-zod-error";
import { dangPhucHoi, LOI_DANG_PHUC_HOI } from "@/lib/backup/khoa-bao-tri";
import { ghiNhatKy } from "@/lib/nhat-ky/ghi-nhat-ky";
import { docMocM, khoaChiaSeBatNoPhaiTra } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { docNguCanhLoc } from "@/lib/no-phai-tra/doc-ngu-canh-loc";
import { dauNgayVn, docGiaoDichThe, docKyNeoThe } from "@/lib/no-phai-tra/du-no-the";
import { duNo, phaiTra } from "@/lib/no-phai-tra/ky-sao-ke";
import {
  demKyCuaThe,
  khoaThe,
  LoiTheCoMa,
  loiThe,
  lyDoKhongDongThe,
  lyDoKhongXoaThe,
  NEN_TANG_GAN_THE,
  nenTangDangGanThe,
} from "@/lib/no-phai-tra/the-tin-dung-queries";
import { rangBuocTrungKhoa } from "@/lib/prisma-loi-adapter";
import { prisma } from "@/lib/prisma";
import { chupVaoThungRac } from "@/lib/thung-rac/ghi-thung-rac";
import { congAction } from "@/lib/quyen/cong-action";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";
import { OPT_TX_DONG_TIEN } from "@/lib/so-quy/khoa-dong-tien-co-han";

/**
 * Hồ sơ THẺ TÍN DỤNG (spec `design.md` §5.1, §5.4, §5.5) — khối "Nợ phải trả" tab Sổ quỹ.
 *
 * Hồ sơ KHÔNG mang tiền: tạo/sửa/đóng/xoá thẻ và gắn nền tảng chạy được cả TRƯỚC khi bật (giai đoạn A
 * chuẩn bị) — `M = null` thì không dòng nào đổi quỹ hay dư nợ. Neo ban đầu của thẻ thêm SAU khi bật
 * (`KySaoKeThe laNeoMoSo`) là điểm xuất phát `duNo` và LUÔN = 0 (lý do ở `taoThe`).
 *
 * `taoThe` và `ganNenTang` đổi hành vi theo "đã bật chưa" ⇒ câu ĐẦU của transaction là khoá SHARED với
 * bước bật (`khoaChiaSeBatNoPhaiTra`), RỒI mới `docMocM(tx)` — không thì đọc được M = null giữa lúc bước bật
 * đang chạy.
 *
 * Mọi lượt đọc-rồi-ghi trên một thẻ mở bằng `khoaThe` (FOR UPDATE) trong transaction. Mọi action ở đây
 * PHẢI có mặt trong `DUONG_GHI` của `tests/khoa-bao-tri-duong-ghi.test.ts` và gọi `dangPhucHoi()` ngay
 * trong thân hàm export (lưới AST chỉ đọc thân hàm).
 */

const LOI_NGAY_TRONG_THANG = "Ngày trong tháng 1–31";
const ngayTrongThangSchema = z.coerce
  .number()
  .int(LOI_NGAY_TRONG_THANG)
  .min(1, LOI_NGAY_TRONG_THANG)
  .max(31, LOI_NGAY_TRONG_THANG);

/** Ngày bất kỳ (quá khứ hay tương lai) — chỉ chặn ô trống/rác (null ⇒ 1970, Invalid Date ⇒ NaN). */
const ngaySchema = z.coerce
  .date({ error: "Ngày không hợp lệ" })
  .refine((d) => d.getFullYear() >= 2000, "Ngày không hợp lệ");

const hoSoTheSchema = z.object({
  ten: z.string().trim().min(1, "Nhập tên thẻ").max(60, "Tối đa 60 ký tự"),
  nganHang: z.string().trim().max(60, "Tối đa 60 ký tự").default(""),
  ngayChotSaoKe: ngayTrongThangSchema,
  ngayHanTra: ngayTrongThangSchema,
  note: z.string().trim().max(500, "Tối đa 500 ký tự").default(""),
});

const neoBanDauSchema = z.object({
  ngayChot: ngaySchema,
  // Zod chỉ chặn rác (âm / lẻ / quá trần 2 tỷ = ngưỡng Prisma Int); luật "phải = 0" cần biết M ⇒ trong tx.
  soDu: z.coerce
    .number()
    .int("Số tiền phải là số nguyên")
    .min(0, "Dư nợ không âm")
    .max(2_000_000_000, "Số tiền quá lớn (tối đa 2 tỷ)"),
});

const taoTheSchema = hoSoTheSchema.extend({ neoBanDau: neoBanDauSchema.nullable().optional() });

const ganNenTangSchema = z.object({
  cardId: z.string().min(1, "Chọn thẻ"),
  nenTang: z.enum(NEN_TANG_GAN_THE, { message: "Chọn nền tảng quảng cáo" }),
  tuNgay: ngaySchema,
});

const ngayVn = (d: Date) => format(d, "dd/MM/yyyy");
const homNayKhoa = () => khoaNgayVn(new Date());
const MOT_NGAY_MS = 86_400_000;

const LOI_NEO_PHAI_BANG_0 =
  "Thẻ thêm sau khi bật theo dõi nợ phải có dư nợ ban đầu = 0: nợ cũ của thẻ chưa gắn đã trừ quỹ qua chi phí " +
  "quảng cáo — nhập số > 0 rồi trả thẻ là trừ quỹ hai lần. Thẻ đang có nợ phải khai ở bước bật.";

/**
 * Tạo thẻ. TRƯỚC khi bật: hồ sơ không neo (neo sinh ở bước xác nhận bật) — gửi kèm neo là từ chối,
 * vì một `KySaoKeThe` trước khi bật là dữ liệu số mà cổng `daBatNoPhaiTra` cấm. SAU khi bật: BẮT BUỘC
 * neo ban đầu `{ngayChot ∈ [M − 1, hôm qua], soDu = 0}` ⇒ `KySaoKeThe laNeoMoSo` cùng transaction.
 *
 * Vì sao `soDu` PHẢI = 0: thẻ chưa có hồ sơ thì chi tiêu trên nó (ads không gắn thẻ, chi tay) đã trừ quỹ
 * ngay lúc phát sinh. Neo > 0 rồi `CARD_PAY` trả khoản đó là trừ quỹ LẦN HAI — mọi thẻ đang có nợ phải
 * khai ở bước bật (đi kèm `CUTOVER_*`). Neo trước M − 1 bị chặn: neo trước M chỉ sinh ở bước bật (§5.8).
 */
export async function taoThe(input: unknown): Promise<ActionResult<{ id: string }>> {
  const c = await congAction("tai-chinh-so-quy:sua");
  if (!c.ok) return c;
  const { nguoiDung } = c;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const parsed = taoTheSchema.safeParse(input);
  if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };
  const { neoBanDau, ...hoSo } = parsed.data;

  try {
    const id = await prisma.$transaction(async (tx) => {
      await khoaChiaSeBatNoPhaiTra(tx);
      const mocM = await docMocM(tx);
      if (mocM === null && neoBanDau) {
        throw new LoiHopDong("Chưa bật theo dõi nợ — số dư neo của thẻ sinh ở bước xác nhận bật", "neoBanDau");
      }
      if (mocM !== null) {
        if (!neoBanDau) {
          throw new LoiHopDong("Đã bật theo dõi nợ — nhập ngày của dư nợ ban đầu (số dư = 0)", "neoBanDau");
        }
        if (neoBanDau.soDu !== 0) throw new LoiTheCoMa("NEO_KHAC_0", LOI_NEO_PHAI_BANG_0, "neoBanDau");
        const kNeo = khoaNgayVn(neoBanDau.ngayChot);
        if (kNeo >= homNayKhoa()) {
          throw new LoiHopDong("Ngày của dư nợ ban đầu phải trước hôm nay", "neoBanDau");
        }
        const truocM = new Date(mocM.getTime() - MOT_NGAY_MS);
        if (kNeo < khoaNgayVn(truocM)) {
          throw new LoiHopDong(
            `Ngày của dư nợ ban đầu không được trước ${ngayVn(truocM)} (ngày trước khi bật theo dõi nợ)`,
            "neoBanDau"
          );
        }
      }
      const the = await tx.theTinDung.create({ data: hoSo });
      if (neoBanDau) {
        await tx.kySaoKeThe.create({
          data: { cardId: the.id, ngayChot: dauNgayVn(neoBanDau.ngayChot), soDu: neoBanDau.soDu, laNeoMoSo: true },
        });
      }
      // `ghiChu` chỉ nhận khoá allowlist (không có `coNeoMoSo`) ⇒ dấu neo đi vào `moTa`.
      await ghiNhatKy(tx, {
        actor: nguoiDung,
        hanhDong: "THE_TAO",
        doiTuong: {
          loai: "TheTinDung",
          id: the.id,
          moTa: neoBanDau ? `${the.ten} · coNeoMoSo: dư nợ ban đầu 0 ngày ${ngayVn(neoBanDau.ngayChot)}` : the.ten,
        },
      });
      return the.id;
    }, OPT_TX_DONG_TIEN);

    lamMoiTrang();
    return { ok: true, data: { id } };
  } catch (e) {
    return { ok: false, ...loiThe(e, "Lỗi khi tạo thẻ") };
  }
}

/** Sửa tên / ngân hàng / ngày chốt / ngày hạn / ghi chú. Neo và kỳ sao kê KHÔNG sửa ở đây. */
export async function suaThe(id: string, input: unknown): Promise<ActionResult> {
  const c = await congAction("tai-chinh-so-quy:sua");
  if (!c.ok) return c;
  const { nguoiDung } = c;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const parsed = hoSoTheSchema.safeParse(input);
  if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };

  try {
    await prisma.$transaction(async (tx) => {
      await khoaThe(tx, id);
      await tx.theTinDung.update({ where: { id }, data: parsed.data });
      await ghiNhatKy(tx, { actor: nguoiDung, hanhDong: "THE_SUA", doiTuong: { loai: "TheTinDung", id } });
    }, OPT_TX_DONG_TIEN);

    lamMoiTrang();
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, ...loiThe(e, "Lỗi khi sửa thẻ") };
  }
}

/** Đóng thẻ — chỉ khi dư nợ ước tính = 0, kỳ mới nhất trả hết, không nền tảng nào đang/sẽ gánh. */
export async function dongThe(id: string): Promise<ActionResult> {
  const c = await congAction("tai-chinh-so-quy:sua");
  if (!c.ok) return c;
  const { nguoiDung } = c;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  try {
    await prisma.$transaction(async (tx) => {
      // Khoá TRƯỚC khi tính dư nợ: một lượt trả thẻ / chốt sao kê song song phải chờ, không thì "dư nợ 0"
      // đọc được là số cũ.
      await khoaThe(tx, id);
      const the = await tx.theTinDung.findUnique({ where: { id }, select: { closedAt: true } });
      if (!the) throw new LoiHopDong("Không tìm thấy thẻ");
      if (the.closedAt !== null) throw new LoiHopDong("Thẻ đã đóng");

      const bayGio = new Date();
      const ctx = await docNguCanhLoc(tx); // đọc TƯƠI trong tx (action ghi, không dùng bản nhớ)
      const [kys, gd] = await Promise.all([docKyNeoThe(id, tx), docGiaoDichThe(id, bayGio, tx, ctx)]);
      const lyDo = lyDoKhongDongThe({
        duNo: duNo(kys, gd, bayGio),
        coNenTangDangGan: nenTangDangGanThe(ctx.gan, id, bayGio).length > 0,
        nghiaVuKy: phaiTra(kys, gd, bayGio)?.nghiaVuKy ?? 0,
      });
      if (lyDo !== null) throw new LoiHopDong(lyDo);

      await tx.theTinDung.update({ where: { id }, data: { closedAt: bayGio } });
      await ghiNhatKy(tx, { actor: nguoiDung, hanhDong: "THE_DONG", doiTuong: { loai: "TheTinDung", id } });
    }, OPT_TX_DONG_TIEN);

    lamMoiTrang();
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, ...loiThe(e, "Lỗi khi đóng thẻ") };
  }
}

/**
 * Xoá thẻ — chỉ hồ sơ TRẮNG: không dòng tiền, không chi phí gắn thẻ, không kỳ sao kê thật, không mốc gắn,
 * không neo `soDu > 0` (neo do bước bật sinh, đi kèm `CUTOVER_*`). Neo mở sổ `soDu = 0` (thẻ thêm sau khi
 * bật) xoá CÙNG transaction, trước dòng thẻ (FK Restrict). Thùng rác chưa có loại bản ghi thẻ
 * (`chup-anh-ban-ghi.ts`) ⇒ xoá cứng: hồ sơ trắng không mang số nào — khôi phục bằng cách tạo lại.
 */
export async function xoaThe(id: string): Promise<ActionResult> {
  const c = await congAction("tai-chinh-so-quy:sua");
  if (!c.ok) return c;
  const { nguoiDung } = c;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  try {
    await prisma.$transaction(async (tx) => {
      await khoaThe(tx, id);
      // Bản ĐỦ cột (đọc sau khoá) — chính bản này vào thùng rác, khôi phục dựng lại đúng nó.
      const the = await tx.theTinDung.findUnique({ where: { id } });
      if (!the) throw new LoiHopDong("Không tìm thấy thẻ");
      const [soTien, soChi, soDongGan, kys] = await Promise.all([
        tx.cashMovement.count({ where: { cardId: id } }),
        tx.expense.count({ where: { cardId: id } }),
        tx.ganNenTangThe.count({ where: { cardId: id } }),
        tx.kySaoKeThe.findMany({ where: { cardId: id }, select: { laNeoMoSo: true, soDu: true, ngayChot: true } }),
      ]);
      const lyDo = lyDoKhongXoaThe({ soDongTien: soTien + soChi, soDongGan, ...demKyCuaThe(kys) });
      if (lyDo !== null) throw new LoiHopDong(lyDo);

      // Còn lại (nếu có) chỉ là neo mở sổ soDu 0 — chụp KÈM thẻ vào thùng rác (spec §5.7: khôi phục dựng
      // lại cả neo), rồi xoá neo trước dòng thẻ vì FK `KySaoKeThe.cardId` là Restrict.
      const neo = kys.find((k) => k.laNeoMoSo);
      const kySaoKe = await tx.kySaoKeThe.findMany({ where: { cardId: id }, orderBy: { ngayChot: "asc" } });
      await chupVaoThungRac(tx, { bang: "TheTinDung", banGhi: the, kySaoKe });
      if (neo) await tx.kySaoKeThe.deleteMany({ where: { cardId: id, laNeoMoSo: true } });
      await tx.theTinDung.delete({ where: { id } });
      await ghiNhatKy(tx, {
        actor: nguoiDung,
        hanhDong: "THE_XOA",
        doiTuong: {
          loai: "TheTinDung",
          id,
          moTa: neo ? `${the.ten} · coNeoMoSo: xoá kèm neo dư nợ 0 ngày ${ngayVn(neo.ngayChot)}` : the.ten,
        },
      });
    }, OPT_TX_DONG_TIEN);

    lamMoiTrang();
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, ...loiThe(e, "Lỗi khi xoá thẻ") };
  }
}

/**
 * Gắn nền tảng ads → thẻ từ `tuNgay` (đổi thẻ = THÊM mốc, không sửa mốc cũ). Hiệu lực thật từ
 * `max(M, tuNgay)` (`theCuaNenTang`). `tuNgay` chuẩn hoá 00:00 VN trước khi ghi — unique `(nenTang, tuNgay)`
 * khoá theo timestamp, cùng ngày khác giờ là lách unique.
 *
 * TRƯỚC khi bật: `tuNgay` tuỳ ý (hồ sơ chuẩn bị). SAU khi bật: `tuNgay ≥ hôm nay` (`GAN_LUI_NGAY`) — mốc lùi
 * về quá khứ đổi quỹ/dư nợ các ngày đã qua (cả tháng đã chốt số dư), và có ca ads rơi khỏi cả quỹ lẫn nợ
 * (rời thẻ cũ theo mốc, bị neo của thẻ mới loại).
 */
export async function ganNenTang(input: unknown): Promise<ActionResult<{ id: string }>> {
  const c = await congAction("tai-chinh-so-quy:sua");
  if (!c.ok) return c;
  const { nguoiDung } = c;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const parsed = ganNenTangSchema.safeParse(input);
  if (!parsed.success) return { ok: false, ...mapZodError(parsed.error) };
  const { cardId, nenTang } = parsed.data;
  const tuNgay = dauNgayVn(parsed.data.tuNgay);

  try {
    const id = await prisma.$transaction(async (tx) => {
      await khoaChiaSeBatNoPhaiTra(tx);
      await khoaThe(tx, cardId);
      const the = await tx.theTinDung.findUnique({ where: { id: cardId }, select: { ten: true, closedAt: true } });
      if (!the) throw new LoiHopDong("Không tìm thấy thẻ", "cardId");
      if (the.closedAt !== null) throw new LoiHopDong("Thẻ đã đóng — không gắn thêm nền tảng", "cardId");
      if ((await docMocM(tx)) !== null && khoaNgayVn(tuNgay) < homNayKhoa()) {
        throw new LoiTheCoMa(
          "GAN_LUI_NGAY",
          "Đã bật theo dõi nợ: mốc gắn thẻ không được lùi về quá khứ (chọn từ hôm nay trở đi)",
          "tuNgay"
        );
      }
      const g = await tx.ganNenTangThe.create({ data: { cardId, nenTang, tuNgay } });
      await ghiNhatKy(tx, {
        actor: nguoiDung,
        hanhDong: "THE_GAN_NEN_TANG",
        doiTuong: { loai: "GanNenTangThe", id: g.id, moTa: `${nenTang} → ${the.ten} từ ${ngayVn(tuNgay)}` },
      });
      return g.id;
    }, OPT_TX_DONG_TIEN);

    lamMoiTrang();
    return { ok: true, data: { id } };
  } catch (e) {
    if (rangBuocTrungKhoa(e) !== undefined) {
      return { ok: false, error: `${nenTang} đã có mốc gắn ngày ${ngayVn(tuNgay)}`, field: "tuNgay" };
    }
    return { ok: false, ...loiThe(e, "Lỗi khi gắn nền tảng") };
  }
}

/**
 * Xoá MỘT mốc gắn — chỉ khi chưa có hiệu lực (`tuNgay` > hôm nay, khoá ngày VN). Mốc đã hiệu lực là lịch
 * sử gánh ads: xoá là dư nợ các ngày đã qua đổi thẻ. Muốn đổi thẻ thì thêm mốc mới.
 */
export async function xoaGanNenTang(id: string): Promise<ActionResult> {
  const c = await congAction("tai-chinh-so-quy:sua");
  if (!c.ok) return c;
  const { nguoiDung } = c;
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  try {
    await prisma.$transaction(async (tx) => {
      const truoc = await tx.ganNenTangThe.findUnique({ where: { id }, select: { cardId: true } });
      if (!truoc) throw new LoiHopDong("Không tìm thấy mốc gắn");
      await khoaThe(tx, truoc.cardId);
      // Đọc lại SAU khoá — đọc trước khoá chỉ để biết khoá thẻ nào.
      const g = await tx.ganNenTangThe.findUnique({ where: { id } });
      if (!g) throw new LoiHopDong("Không tìm thấy mốc gắn");
      if (khoaNgayVn(g.tuNgay) <= homNayKhoa()) {
        throw new LoiHopDong("Mốc gắn đã có hiệu lực — không xoá được; đổi thẻ bằng cách thêm mốc mới");
      }
      await tx.ganNenTangThe.delete({ where: { id } });
      await ghiNhatKy(tx, {
        actor: nguoiDung,
        hanhDong: "THE_XOA_GAN_NEN_TANG",
        doiTuong: { loai: "GanNenTangThe", id, moTa: `${g.nenTang} từ ${ngayVn(g.tuNgay)}` },
      });
    }, OPT_TX_DONG_TIEN);

    lamMoiTrang();
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, ...loiThe(e, "Lỗi khi xoá mốc gắn") };
  }
}
