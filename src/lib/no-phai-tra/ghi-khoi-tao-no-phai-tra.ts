import { format, subDays } from "date-fns";

import type { Prisma } from "@/generated/prisma/client";
import { formatVnd } from "@/lib/format";
import {
  docMocM,
  KEY_NO_PHAI_TRA_TU_NGAY,
  khoaDocQuyenBatNoPhaiTra,
} from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { kiemDieuKienBat } from "@/lib/no-phai-tra/dieu-kien-bat-no-phai-tra";
import { dauNgayVn } from "@/lib/no-phai-tra/du-no-the";
import { khoaThe, LoiTheCoMa } from "@/lib/no-phai-tra/the-tin-dung-queries";
import { khoaViAds } from "@/lib/no-phai-tra/vi-ads-queries";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";

/**
 * GHI DỮ LIỆU KHỞI TẠO nợ phải trả + BẬT công tắc (spec §5.4 giai đoạn xác nhận) — đường DUY NHẤT ghi
 * `Setting.noPhaiTraTuNgay`, `KySaoKeThe` trước M và `CUTOVER_ADJ_*`. NỘI BỘ: chỉ action xác nhận bật
 * (`src/lib/actions/bat-no-phai-tra.ts`) được import — lưới `tests/chi-action-bat-duoc-import-khoi-tao.test.ts`.
 *
 * Chạy TRONG transaction của action (truyền `tx`), theo thứ tự:
 *   (0) khoá EXCLUSIVE bước bật (reentrant nếu action đã giữ) → đọc LẠI M trong tx: có ⇒ `DA_BAT_ROI`
 *       (hai tab cùng bấm ⇒ đúng một lượt ghi điều chỉnh) → CHỐT THỨ HAI: đã có `CUTOVER_ADJ_*` hoặc yêu cầu
 *       `XAC_NHAN_BAT` đã ghi kết quả ok ⇒ cũng `DA_BAT_ROI` (ai đó gỡ Setting bằng tay — gỡ Setting KHÔNG
 *       phải cách tắt, bật lại là ghi bộ điều chỉnh thứ hai) → kiểm lại điều kiện tiên quyết sau khoá
 *       (`THIEU_HO_SO_VI` được bỏ qua khi chủ shop xác nhận ví Shopee chưa theo dõi);
 *   (1) mỗi thẻ đang mở (BẮT BUỘC đủ bộ — thẻ thiếu neo thì sau bật không có điểm xuất phát dư nợ):
 *       (i) sao kê gần nhất trước M (tuỳ chọn, có hạn trả + phần đã trả trước M), (ii) neo dư nợ cuối
 *       ngày M − 1 (`laNeoMoSo`). Sao kê chốt ĐÚNG ngày M − 1 thì một dòng làm cả hai (cùng ngày = cùng
 *       khoá unique; dư nợ cuối ngày chốt chính là số sao kê) — hai số phải bằng nhau;
 *   (1b) mỗi hồ sơ ví ads trả trước (đủ bộ): neo := số dư thật cuối M − 1;
 *   (2) điều chỉnh quỹ: mỗi dòng > 0 ⇒ MỘT `CUTOVER_ADJ_IN/OUT` đúng ngày M, mô tả bắt buộc; 0 ⇒ bỏ;
 *   (3) `Setting.noPhaiTraTuNgay = M` — CÂU GHI CUỐI. Mọi bước trước NÉM khi sai (không `return` sớm:
 *       `return` trong `$transaction` là COMMIT phần đã ghi).
 */

/** Loại `YeuCauGhi` của bước bật — chốt thứ hai đọc loại này. */
export const LOAI_YEU_CAU_BAT = "XAC_NHAN_BAT";

export type SaoKeTruocM = { ngayChot: Date; soDu: number; hanTra: Date; daTraTruocMoSo: number };

export type DuLieuKhoiTao = {
  mocM: Date;
  yeuCauId: string;
  the: readonly { cardId: string; saoKeCuoi: SaoKeTruocM | null; duNoCuoiMTru1: number }[];
  viAds: readonly { viAdsId: string; soDuNeo: number }[];
  dieuChinh: readonly { chieu: "IN" | "OUT"; soTien: number; moTa: string }[];
  /**
   * Chủ shop xác nhận: Shopee Ads nạp từ ví bán hàng hoặc chưa muốn theo dõi ví ⇒ thiếu hồ sơ ví không chặn
   * bật; chi ads Shopee tiếp tục trừ quỹ theo ngày chạy (không có hồ sơ ví thì bộ lọc không loại).
   */
  xacNhanViShopeeChuaTheoDoi?: boolean;
};

export type KetQuaKhoiTao = {
  mocM: string;
  soThe: number;
  soVi: number;
  dieuChinh: { id: string; chieu: "IN" | "OUT"; soTien: number }[];
  /** Tác động CÓ DẤU của điều chỉnh lên quỹ. */
  tacDong: number;
  /** true khi bật nhờ xác nhận "ví Shopee chưa theo dõi" (lúc bật THẬT thiếu hồ sơ ví) — lưu vết nhật ký. */
  viShopeeChuaTheoDoi: boolean;
};

const nhan = (d: Date) => format(d, "dd/MM/yyyy");

function lechTapHop(can: readonly string[], co: readonly string[]): { thieu: string[]; thua: string[] } {
  const a = new Set(can);
  const b = new Set(co);
  return { thieu: can.filter((x) => !b.has(x)), thua: co.filter((x) => !a.has(x)) };
}

export async function ghiKhoiTaoNoPhaiTra(tx: Prisma.TransactionClient, d: DuLieuKhoiTao): Promise<KetQuaKhoiTao> {
  // (0)
  await khoaDocQuyenBatNoPhaiTra(tx);
  if ((await docMocM(tx)) !== null) {
    throw new LoiTheCoMa("DA_BAT_ROI", "Đã bật theo dõi nợ phải trả rồi — tải lại trang để xem.");
  }
  const [soCutover, soBatDaGhi] = await Promise.all([
    tx.cashMovement.count({ where: { kind: { in: ["CUTOVER_ADJ_IN", "CUTOVER_ADJ_OUT"] } } }),
    // Dòng giữ mã của CHÍNH lượt này chưa có kết quả (`ketQua` NULL) ⇒ không tự chặn mình.
    tx.yeuCauGhi.count({ where: { loai: LOAI_YEU_CAU_BAT, ketQua: { path: ["ok"], equals: true } } }),
  ]);
  if (soCutover > 0 || soBatDaGhi > 0) {
    throw new LoiTheCoMa(
      "DA_BAT_ROI",
      "Đã từng bật theo dõi nợ phải trả (còn dòng điều chỉnh ngày bật / yêu cầu bật đã ghi) — gỡ Setting không " +
        "phải cách tắt; xem runbook mục lùi bước bật."
    );
  }
  const tatCaLoi = await kiemDieuKienBat({ mocM: d.mocM }, tx);
  const viShopeeChuaTheoDoi =
    d.xacNhanViShopeeChuaTheoDoi === true && tatCaLoi.some((l) => l.code === "THIEU_HO_SO_VI");
  const loiDieuKien = viShopeeChuaTheoDoi ? tatCaLoi.filter((l) => l.code !== "THIEU_HO_SO_VI") : tatCaLoi;
  if (loiDieuKien.length > 0) throw new LoiTheCoMa(loiDieuKien[0].code, loiDieuKien[0].message, "mocM");

  const mocM = dauNgayVn(d.mocM);
  const truocM = dauNgayVn(subDays(mocM, 1));
  const khoaTruocM = khoaNgayVn(truocM);

  // (1) Thẻ — khoá theo id tăng dần (thứ tự toàn cục, không khoá chéo với lượt khác), đọc lại SAU khoá.
  const cardIds = d.the.map((t) => t.cardId);
  if (new Set(cardIds).size !== cardIds.length) throw new LoiTheCoMa("THE_TRUNG", "Một thẻ khai hai lần", "the");
  for (const id of [...cardIds].sort()) await khoaThe(tx, id);
  const theMo = await tx.theTinDung.findMany({ where: { closedAt: null }, select: { id: true, ten: true } });
  const lechThe = lechTapHop(
    theMo.map((t) => t.id),
    cardIds
  );
  if (lechThe.thieu.length > 0) {
    const ten = theMo.filter((t) => lechThe.thieu.includes(t.id)).map((t) => t.ten);
    throw new LoiTheCoMa("THIEU_THE", `Chưa khai dư nợ cuối ${nhan(truocM)} cho thẻ: ${ten.join(", ")}`, "the");
  }
  if (lechThe.thua.length > 0) {
    throw new LoiTheCoMa("THE_KHONG_HOP_LE", "Có thẻ không còn mở hoặc không tồn tại — tải lại trang", "the");
  }

  for (const t of d.the) {
    // Neo cũ (nếu có — vd hồ sơ khôi phục từ thùng rác) bị THAY: mỗi thẻ một neo mở sổ (unique partial).
    await tx.kySaoKeThe.deleteMany({ where: { cardId: t.cardId, laNeoMoSo: true } });
    const sk = t.saoKeCuoi;
    if (sk !== null) {
      const khoaChot = khoaNgayVn(sk.ngayChot);
      if (khoaChot > khoaTruocM) {
        throw new LoiTheCoMa("SAO_KE_SAU_M", `Sao kê gần nhất phải chốt trước ngày bật (${nhan(mocM)})`, "the");
      }
      if (khoaNgayVn(sk.hanTra) <= khoaChot) {
        throw new LoiTheCoMa("HAN_TRUOC_CHOT", "Hạn trả sao kê phải sau ngày chốt", "the");
      }
      if (sk.daTraTruocMoSo > sk.soDu) {
        throw new LoiTheCoMa("DA_TRA_VUOT_SAO_KE", "Phần đã trả trước ngày bật không được lớn hơn số sao kê", "the");
      }
      if (khoaChot === khoaTruocM && sk.soDu !== t.duNoCuoiMTru1) {
        throw new LoiTheCoMa(
          "SAO_KE_CHOT_DUNG_NGAY_TRUOC_M",
          `Sao kê chốt đúng ngày ${nhan(truocM)}: dư nợ cuối ngày đó chính là số sao kê — hai ô phải bằng nhau`,
          "the"
        );
      }
      await tx.kySaoKeThe.create({
        data: {
          cardId: t.cardId,
          ngayChot: dauNgayVn(sk.ngayChot),
          soDu: sk.soDu,
          hanTra: dauNgayVn(sk.hanTra),
          daTraTruocMoSo: sk.daTraTruocMoSo,
          laNeoMoSo: false,
        },
      });
      if (khoaChot === khoaTruocM) continue; // dòng sao kê vừa ghi cũng là neo cuối M − 1
    }
    await tx.kySaoKeThe.create({
      data: { cardId: t.cardId, ngayChot: truocM, soDu: t.duNoCuoiMTru1, laNeoMoSo: true },
    });
  }

  // (1b) Ví ads trả trước — cùng luật đủ bộ.
  const viIds = d.viAds.map((v) => v.viAdsId);
  if (new Set(viIds).size !== viIds.length) throw new LoiTheCoMa("VI_TRUNG", "Một ví khai hai lần", "viAds");
  for (const id of [...viIds].sort()) await khoaViAds(tx, id);
  const viCo = await tx.viAdsTraTruoc.findMany({ select: { id: true, nenTang: true } });
  const lechVi = lechTapHop(
    viCo.map((v) => v.id),
    viIds
  );
  if (lechVi.thieu.length > 0 || lechVi.thua.length > 0) {
    throw new LoiTheCoMa("THIEU_VI", `Phải khai số dư cuối ${nhan(truocM)} cho mọi ví quảng cáo trả trước — tải lại trang`, "viAds");
  }
  for (const v of d.viAds) {
    await tx.viAdsTraTruoc.update({ where: { id: v.viAdsId }, data: { soDuNeo: v.soDuNeo, ngayNeo: truocM } });
  }

  // (2) Điều chỉnh quỹ đúng ngày M.
  const dieuChinh: KetQuaKhoiTao["dieuChinh"] = [];
  for (const dc of d.dieuChinh) {
    if (dc.soTien === 0) continue;
    const moTa = dc.moTa.trim();
    if (moTa === "") throw new LoiTheCoMa("THIEU_MO_TA", "Mỗi dòng điều chỉnh phải có mô tả", "dieuChinh");
    const row = await tx.cashMovement.create({
      data: {
        kind: dc.chieu === "IN" ? "CUTOVER_ADJ_IN" : "CUTOVER_ADJ_OUT",
        amount: dc.soTien,
        date: mocM,
        description: moTa,
        yeuCauId: d.yeuCauId,
      },
      select: { id: true },
    });
    dieuChinh.push({ id: row.id, chieu: dc.chieu, soTien: dc.soTien });
  }

  // (3) CÂU GHI CUỐI — từ đây bộ lọc chi phí trừ quỹ + mọi đường ghi tiền mới có hiệu lực.
  const giaTri = khoaNgayVn(mocM);
  await tx.setting.upsert({
    where: { key: KEY_NO_PHAI_TRA_TU_NGAY },
    create: { key: KEY_NO_PHAI_TRA_TU_NGAY, value: giaTri },
    update: { value: giaTri },
  });

  return {
    mocM: giaTri,
    soThe: d.the.length,
    soVi: d.viAds.length,
    dieuChinh,
    tacDong: dieuChinh.reduce((s, x) => s + (x.chieu === "IN" ? x.soTien : -x.soTien), 0),
    viShopeeChuaTheoDoi,
  };
}

/** Mô tả nhật ký: M, số thẻ/ví, tổng điều chỉnh vào/ra. */
export function moTaNhatKyBat(kq: KetQuaKhoiTao): string {
  const vao = kq.dieuChinh.filter((x) => x.chieu === "IN").reduce((s, x) => s + x.soTien, 0);
  const ra = kq.dieuChinh.filter((x) => x.chieu === "OUT").reduce((s, x) => s + x.soTien, 0);
  return (
    `Bật từ ${kq.mocM} · ${kq.soThe} thẻ · ${kq.soVi} ví · ${kq.dieuChinh.length} dòng điều chỉnh ` +
    `(vào ${formatVnd(vao)}, ra ${formatVnd(ra)})` +
    (kq.viShopeeChuaTheoDoi ? " · xác nhận ví Shopee Ads chưa theo dõi (chi ads Shopee vẫn trừ quỹ theo ngày chạy)" : "")
  );
}
