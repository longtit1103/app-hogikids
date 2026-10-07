/**
 * Tiến độ một lượt "Đồng bộ ngay" — luật quyết định "đã xong chưa" của nút bấm.
 *
 * MODULE THUẦN (không Prisma, không I/O) để nút bấm phía client và test đơn vị cùng dùng một luật.
 * Số liệu đầu vào do server action `getTienDoDongBoNgay` đọc từ `SyncLog`.
 *
 * VÌ SAO KHÔNG dừng ở dòng SyncLog đầu tiên (luật cũ): workflow `pancake-sync-now` POST mỗi TRANG
 * về `/api/ingest/raw`, mỗi request là MỘT dòng `SyncLog` riêng ⇒ dòng đầu tiên về sau vài giây,
 * khi lượt kéo mới chạy được một trang. Nút báo "Đồng bộ xong" + nạp lại trang lúc đó thì phiếu nhập,
 * đơn, dải nhắc việc… vẫn là số CŨ — đúng ca "bấm mà tưởng nút không ăn". Mốc KẾT THÚC thật là dòng
 * của BƯỚC CUỐI workflow: `POST /api/ingest/dem-gia-von`, nhận diện bằng `stats.mode` (route gắn dấu
 * này ngay từ lúc tạo dòng RUNNING, giữ cả khi ERROR — xem `withSyncLog` tham số `dauNhanDien`).
 *
 * LỐI RA khi workflow chết giữa chừng (n8n runner sập, Code node ném trước bước cuối, request bước
 * cuối không tới app…): không có dòng bước cuối nào ⇒ nếu chỉ chờ nó thì nút quay mãi. Ba trần:
 *  - chưa có dòng nào sau mốc bấm quá `TRAN_CHO_PHAN_HOI_MS` ⇒ n8n chưa phản hồi (giữ luật cũ);
 *  - có dòng nhưng KHÔNG còn hoạt động (không dòng RUNNING, mốc bắt đầu/kết thúc mới nhất đã cũ quá
 *    `TRAN_DUNG_IM_MS`) ⇒ dừng giữa chừng. Mỗi trang là một request vài giây, nên im 3 phút liền là
 *    workflow đã chết chứ không phải đang chạy chậm;
 *  - trần cứng `TRAN_TONG_MS` cho mọi trường hợp còn lại (vd một dòng RUNNING treo).
 * Mọi phép so thời gian dùng GIỜ SERVER (`bayGio` + mốc bấm do server cấp) — không trộn đồng hồ máy
 * khách với `startedAt` trong DB.
 */

/** `stats.mode` của dòng SyncLog bước cuối (`POST /api/ingest/dem-gia-von`). */
export const MODE_BUOC_CUOI_DONG_BO_NGAY = "dem-gia-von";

/** Chưa có dòng SyncLog nào sau mốc bấm quá lâu ⇒ n8n không nhận/không chạy. */
export const TRAN_CHO_PHAN_HOI_MS = 120_000;
/** Đã có dòng nhưng im (không RUNNING, không dòng mới) quá lâu ⇒ workflow dừng giữa chừng. */
export const TRAN_DUNG_IM_MS = 180_000;
/** Trần cứng cho mọi trường hợp — nút không được quay quá mốc này. */
export const TRAN_TONG_MS = 15 * 60_000;
/**
 * Lưới cuối PHÍA MÁY KHÁCH (nút bấm): luật trần thật nằm ở `ketLuanTienDo` (giờ server). Đồng hồ này
 * chỉ để nút không quay mãi khi CHÍNH lời hỏi tiến độ hỏng liên tục (mất mạng, server action lỗi).
 */
export const TRAN_MAY_KHACH_MS = TRAN_TONG_MS + 60_000;

/**
 * Dải hợp lệ của `mocBam` server action nhận: không cũ hơn `TRAN_MOC_QUA_KHU_MS`, không ở tương lai
 * quá `TRAN_MOC_TUONG_LAI_MS` (so giờ server). `mocBam` do máy khách gửi lại — không kẹp thì
 * `"1970-01-01"` biến mỗi lời hỏi 5 giây thành một lượt quét MỌI dòng SyncLog PANCAKE (bảng không
 * dọn định kỳ). Qua `TRAN_MAY_KHACH_MS` nút đã tự thôi hỏi nên dải này không chặn lượt thật nào.
 */
export const TRAN_MOC_QUA_KHU_MS = TRAN_TONG_MS + 5 * 60_000;
export const TRAN_MOC_TUONG_LAI_MS = 60_000;
/** Mã lỗi server action trả khi `mocBam` ngoài dải — nút dừng theo dõi thay vì hỏi lại mãi. */
export const MA_MOC_NGOAI_DAI = "MOC_NGOAI_DAI";

/** `mocBam` (ms) có nằm trong dải theo dõi so với `bayGio` (ms, giờ server) không. Hàm thuần. */
export function mocBamHopLe(mocBamMs: number, bayGioMs: number): boolean {
  if (!Number.isFinite(mocBamMs)) return false;
  return mocBamMs >= bayGioMs - TRAN_MOC_QUA_KHU_MS && mocBamMs <= bayGioMs + TRAN_MOC_TUONG_LAI_MS;
}

export type TrangThaiLuot = "RUNNING" | "OK" | "ERROR";

/** Số liệu SyncLog PANCAKE tính từ mốc bấm — server action trả về, mọi mốc là ISO giờ server. */
export type SoLieuTienDoDongBoNgay = {
  /** Dòng bước cuối mới nhất sau mốc bấm; `null` = workflow chưa tới bước cuối. */
  buocCuoi: { status: TrangThaiLuot; error: string | null } | null;
  /** Tổng số dòng sau mốc bấm (mọi trang + bước cuối). */
  soLuot: number;
  /** Số dòng ERROR sau mốc bấm, KHÔNG tính dòng bước cuối. */
  soLuotLoi: number;
  /** Còn dòng RUNNING nào sau mốc bấm không. */
  coLuotDangChay: boolean;
  /** max(startedAt, finishedAt) của các dòng sau mốc bấm; `null` khi chưa có dòng nào. */
  hoatDongCuoi: string | null;
  /** Mốc bấm do server cấp (`triggerSyncNow`). */
  mocBam: string;
  /** Giờ server lúc đọc. */
  bayGio: string;
};

export type KetLuanTienDo =
  | { loai: "dang-chay" }
  | { loai: "xong"; soLuotLoi: number }
  | { loai: "loi-buoc-cuoi"; error: string | null; soLuotLoi: number }
  | { loai: "khong-phan-hoi" }
  | { loai: "dung-giua-chung"; soLuot: number; soLuotLoi: number }
  | { loai: "qua-tran"; soLuot: number };

/** Luật quyết định "đã xong chưa". Hàm thuần — test đơn vị khoá từng nhánh. */
export function ketLuanTienDo(s: SoLieuTienDoDongBoNgay): KetLuanTienDo {
  // Bước cuối ĐÃ KẾT THÚC là lời khẳng định mạnh nhất — xét trước mọi trần thời gian.
  if (s.buocCuoi?.status === "OK") return { loai: "xong", soLuotLoi: s.soLuotLoi };
  if (s.buocCuoi?.status === "ERROR") {
    return { loai: "loi-buoc-cuoi", error: s.buocCuoi.error, soLuotLoi: s.soLuotLoi };
  }

  const bayGio = Date.parse(s.bayGio);
  if (bayGio - Date.parse(s.mocBam) > TRAN_TONG_MS) return { loai: "qua-tran", soLuot: s.soLuot };

  if (s.soLuot === 0) {
    return bayGio - Date.parse(s.mocBam) > TRAN_CHO_PHAN_HOI_MS ? { loai: "khong-phan-hoi" } : { loai: "dang-chay" };
  }

  // Bước cuối đang chạy, hoặc còn trang đang ghi ⇒ workflow còn sống.
  if (s.buocCuoi?.status === "RUNNING" || s.coLuotDangChay) return { loai: "dang-chay" };

  const hoatDong = s.hoatDongCuoi ? Date.parse(s.hoatDongCuoi) : Date.parse(s.mocBam);
  if (bayGio - hoatDong > TRAN_DUNG_IM_MS) {
    return { loai: "dung-giua-chung", soLuot: s.soLuot, soLuotLoi: s.soLuotLoi };
  }
  return { loai: "dang-chay" };
}

export type ThongDiepKetLuan = { muc: "thanh-cong" | "canh-bao" | "loi"; noiDung: string };

/**
 * Câu báo cho chủ shop ứng với từng kết luận ĐÃ DỪNG. `dang-chay` ⇒ `null` (chưa báo gì).
 * Tách ra đây để test khoá: kết luận lỗi KHÔNG BAO GIỜ được báo thành "xong".
 */
export function thongDiepKetLuan(k: KetLuanTienDo): ThongDiepKetLuan | null {
  switch (k.loai) {
    case "dang-chay":
      return null;
    case "xong":
      return k.soLuotLoi === 0
        ? { muc: "thanh-cong", noiDung: "Đồng bộ xong" }
        : {
            muc: "canh-bao",
            noiDung: `Đồng bộ xong nhưng ${k.soLuotLoi} lượt kéo bị lỗi — xem Cài đặt › Đồng bộ`,
          };
    case "loi-buoc-cuoi":
      return {
        muc: "loi",
        // `error` của dòng bước cuối: lỗi ĐẾM ("Đếm … hỏng") và/hoặc lỗi KÉO Pancake do workflow báo
        // kèm ("Kéo Pancake lỗi N lượt — purchases/kho …") — câu đã tự nêu stream/shop.
        noiDung: `Đồng bộ có lỗi — ${k.error ?? "không rõ lỗi"}`,
      };
    case "khong-phan-hoi":
      return { muc: "loi", noiDung: "n8n chưa phản hồi — kiểm tra workflow" };
    case "dung-giua-chung":
      return {
        muc: "loi",
        noiDung:
          `Đồng bộ dừng giữa chừng (đã nhận ${k.soLuot} lượt, chưa tới bước cuối) — ` +
          "xem lượt chạy pancake-sync-now trong n8n. Dữ liệu đã về vẫn giữ",
      };
    case "qua-tran":
      return {
        muc: "loi",
        noiDung:
          `Đồng bộ chạy quá ${TRAN_TONG_MS / 60_000} phút chưa xong — ngừng theo dõi. ` +
          "Dữ liệu đã về vẫn giữ; xem lượt chạy pancake-sync-now trong n8n",
      };
  }
}
