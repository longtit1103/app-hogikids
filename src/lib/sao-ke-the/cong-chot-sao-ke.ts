/**
 * Cổng THUẦN (không DB, không server) quyết một sao kê thẻ chốt được hay chưa — dùng chung cho đường nhập PDF
 * (`actions/sao-ke-the.ts`, CHẶN) và form chốt gõ tay (`chot-sao-ke-form-modal.tsx`, chỉ cảnh báo). Không import gì
 * phía server để component client import được.
 */

const MOT_NGAY_MS = 24 * 3600 * 1000;

/**
 * Hoá đơn TikTok tạo chiều/tối ngày chốt D chỉ về app ở lượt kéo đêm D+2 (API hoá đơn trễ 6–11h, lượt kéo 01:15).
 * Chốt trước đó thì các lần trừ ngày D chưa có trong app; khi về chúng mang ngày ≤ D ⇒ lõi `ky-sao-ke.ts` coi là đã
 * nằm trong neo ⇒ bỏ sót tới kỳ chốt sau.
 */
export const SO_DEM_HOA_DON_TIKTOK_VE = 2;

/** `yyyy-MM-dd` + `n` ngày theo lịch (cộng trên UTC nên không lệch múi). */
function congNgayLich(ngay: string, n: number): string {
  return new Date(Date.parse(`${ngay}T00:00:00Z`) + n * MOT_NGAY_MS).toISOString().slice(0, 10);
}

/** `yyyy-MM-dd` ⇒ `dd/MM`. */
function ngayNgan(khoa: string): string {
  return `${khoa.slice(8, 10)}/${khoa.slice(5, 7)}`;
}

/** Ngày (khoá VN) sớm nhất mà mọi hoá đơn TikTok của ngày chốt `ngayChot` đã về app. */
export function ngayHoaDonTiktokDuVe(ngayChot: string): string {
  return congNgayLich(ngayChot, SO_DEM_HOA_DON_TIKTOK_VE);
}

/**
 * Lý do CHƯA chốt được vì hoá đơn TikTok ngày chốt có thể chưa về app (null = đủ tươi). Hai điều kiện:
 *  1. hôm nay (khoá VN) ≥ D + 2;
 *  2. lượt kéo hoá đơn mới nhất vào app ≥ D + 2 — lượt kéo đêm có thể hỏng/bị bỏ, hôm nay đủ muộn chưa chắc hoá đơn
 *     đã về. `lanKeoMoiNhat` null = chưa từng có lượt kéo hoá đơn thành công nào.
 * Đường nhập PDF đo điều kiện 2 THEO TỪNG BC (+ trang lỗi, backlog kho thô) ở `lyDoHoaDonTiktokChuaDu`
 * (`no-phai-tra/doi-chieu-sao-ke-voi-app.ts`) và chỉ mượn hàm này cho điều kiện 1.
 *
 * Rủi ro còn lại: workflow n8n `tiktok-business-nightly.json` chỉ POST trang có hoá đơn (`if (list.length)`) ⇒ lượt
 * kéo mà CẢ cửa sổ 10 ngày (`HOA_DON_CUA_SO_NGAY`) không có hoá đơn nào thì không ghi `SyncLog`, mốc đứng yên ⇒ cổng
 * chặn nhập PDF chứ không chốt sai — chủ shop dùng form chốt tay (chỉ cảnh báo).
 */
export function lyDoHoaDonTiktokChuaVe(ngayChot: string, homNay: string, lanKeoMoiNhat: string | null): string | null {
  const tu = ngayHoaDonTiktokDuVe(ngayChot);
  if (homNay < tu) {
    return `Hoá đơn TikTok tối ngày chốt về app sau 2 đêm; nhập lại từ ${ngayNgan(tu)}`;
  }
  if (lanKeoMoiNhat === null || lanKeoMoiNhat < tu) {
    const lan = lanKeoMoiNhat === null ? "chưa có lượt nào" : `lượt mới nhất ngày ${ngayNgan(lanKeoMoiNhat)}`;
    return `Chưa có lượt kéo hoá đơn TikTok sau ngày chốt (${lan}) — đợi lượt kéo đêm từ ${ngayNgan(tu)} rồi nhập lại`;
  }
  return null;
}

export type KiemSoCuoiThe = { chan: string | null; canhBao: string | null };

/**
 * Sao kê có đúng thẻ không, theo 4 số cuối in trên sao kê so với tên + ghi chú thẻ:
 *  - tên/ghi chú có đúng 4 số đó ⇒ ổn;
 *  - có một bộ 4 chữ số KHÁC (và không có số đúng) ⇒ CHẶN — gần như chắc chọn nhầm thẻ, chốt là ghi neo sai thẻ;
 *  - không có bộ 4 chữ số nào ⇒ chỉ cảnh báo (thẻ đặt tên không kèm số).
 */
export function kiemSoCuoiThe(ten: string, note: string, soCuoiThe: string): KiemSoCuoiThe {
  const boSo: string[] = `${ten} ${note}`.match(/(?<!\d)\d{4}(?!\d)/g) ?? [];
  if (boSo.includes(soCuoiThe)) return { chan: null, canhBao: null };
  if (boSo.length > 0) {
    return {
      chan: `Sao kê của thẻ đuôi ${soCuoiThe} — thẻ "${ten}" mang số ${boSo.join(", ")}: chọn đúng thẻ (hoặc sửa tên thẻ) rồi nhập lại`,
      canhBao: null,
    };
  }
  return { chan: null, canhBao: `Sao kê của thẻ đuôi ${soCuoiThe} — tên thẻ "${ten}" không có số này, kiểm đúng thẻ.` };
}
