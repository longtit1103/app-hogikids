/**
 * Phân loại một đơn thuộc NỀN "chưa đối chiếu được" của bước kiểm landSeq (`dem-khop-moc-land-don.ts`): `Order.raw` KHÔNG
 * bằng CHÍNH XÁC (phép `=` của `jsonb`) payload của bất kỳ dòng kho thô nào của đơn.
 *
 * Đối chiếu THÊM theo đúng cách đường ghi Silver đọc dữ liệu: transform đọc payload kho thô qua client Prisma (`jsonb` ⇒
 * `JSON.parse` của JS) rồi ghi nguyên đối tượng đó vào `Order.raw`. Vậy đem CẢ HAI phía qua cùng phép đó — payload từng
 * dòng và `Order.raw`, đều đọc qua Prisma — rồi so dạng chuẩn hoá (khoá sắp xếp). Khớp ⇒ biết Silver đang giữ bản nào.
 *
 * ⚠️ Phép so JS KHÔNG khôi phục được độ chính xác đã mất: số nguyên > 2^53 / số thực nhiều chữ số đã bị làm tròn ở lúc
 * ghi thì không cách nào biết giá trị gốc từ `Order.raw`. Hai bản KHÁC nhau của cùng đơn mà chỉ khác ở những chữ số đã
 * mất sẽ trở thành GIỐNG nhau sau chuyển đổi ⇒ KHÔNG ĐỦ CĂN CỨ (không đoán).
 *
 * Kết quả (KHÔNG làm tròn heuristic, KHÔNG bỏ trường):
 *  - `GIAI_THICH_DUOC`: khớp đúng MỘT bản (một `payloadHash`) và đó là bản THAM CHIẾU (dòng cặp mốc Silver trỏ tới) ⇒
 *    lệch chỉ do lưu trữ qua JS.
 *  - `LECH_BAN_KHAC`: khớp đúng MỘT bản và đó KHÔNG phải bản tham chiếu ⇒ Silver giữ nội dung bản khác (tính lệch nội dung).
 *  - `KHONG_DU_CAN_CU`: không khớp bản nào; hoặc khớp ≥ 2 bản khác nhau (va chạm sau chuyển đổi JS); hoặc không có bản tham
 *    chiếu để biết bản nào là đúng. Không tính là đạt.
 */
export type DongDoiChieu = {
  id: string;
  payloadHash: string;
  /** Payload ĐÃ đọc qua client Prisma (`$queryRaw*`) — đúng phép parse đường transform dùng. */
  payload: unknown;
  /** Dòng mà cặp mốc của Silver trỏ tới (bản Silver PHẢI đang giữ). */
  laThamChieu: boolean;
};

export type LoaiNen = "GIAI_THICH_DUOC" | "LECH_BAN_KHAC" | "KHONG_DU_CAN_CU";

/** Chuỗi chuẩn hoá của một giá trị JSON đã parse: khoá đối tượng sắp xếp, mảng giữ thứ tự, số theo biểu diễn JS. */
export function chuanHoaJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(chuanHoaJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${chuanHoaJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** Bỏ khoá `_buTuDonKho` (đơn bù từ bản sao kho mang thêm khoá này so với payload). */
function boKhoaDonBu(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const con = { ...(raw as Record<string, unknown>) };
  delete con._buTuDonKho;
  return con;
}

export function phanLoaiNenQuaJs(rawSilver: unknown, dong: readonly DongDoiChieu[]): { loai: LoaiNen; lyDo: string } {
  const can = chuanHoaJson(boKhoaDonBu(rawSilver));
  const khop = dong.filter((d) => chuanHoaJson(d.payload) === can);
  const banKhop = new Set(khop.map((d) => d.payloadHash));
  if (banKhop.size === 0) return { loai: "KHONG_DU_CAN_CU", lyDo: "khong-khop-ban-nao" };
  if (banKhop.size > 1) return { loai: "KHONG_DU_CAN_CU", lyDo: `va-cham-${banKhop.size}-ban-sau-chuyen-doi-js` };
  const thamChieu = dong.filter((d) => d.laThamChieu);
  if (thamChieu.length !== 1) return { loai: "KHONG_DU_CAN_CU", lyDo: "khong-co-ban-tham-chieu" };
  // Khớp đúng MỘT bản: nếu bản tham chiếu va chạm với bản khác thì `banKhop` đã có ≥ 2 bản ở trên; còn khớp một bản khác
  // hẳn dạng tham chiếu ⇒ chắc chắn Silver giữ bản khác (dù tham chiếu va chạm với ai).
  return banKhop.has(thamChieu[0].payloadHash)
    ? { loai: "GIAI_THICH_DUOC", lyDo: "khop-ban-tham-chieu-sau-chuyen-doi-js" }
    : { loai: "LECH_BAN_KHAC", lyDo: "khop-ban-khac-sau-chuyen-doi-js" };
}
