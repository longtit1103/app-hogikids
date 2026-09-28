import {
  demCanXem,
  demTonDong,
  dongDauCacBanCuChuaDongDau,
  ghiNhanThuThatBai,
  KET_CUC,
  ketCucHienTaiCuaDon,
  locDonQuaHanChuaDongDau,
} from "@/lib/bronze/ket-cuc-silver";
import { transformFromRaw } from "@/lib/bronze/transform-from-raw";

/**
 * Lượt đối soát đơn còn dở — LƯỚI AN TOÀN THỨ HAI sau dấu kết cục theo từng dòng.
 *
 * Dấu kết cục lo được phần lớn: đường ghi thường tự dựng nốt việc dở của chính nó ở lượt gửi lại.
 * Nhưng còn hai khe nó không với tới:
 *   - đơn "yên vị" (đã giao xong / đã hoàn) thì Pancake không gửi lại nữa — không có lượt nào để
 *     bám vào mà tự chữa;
 *   - lượt gửi lại có thể trượt cả trang (n8n chỉ thử lại trang 1 của mỗi cửa sổ).
 *
 * ĐÂY KHÔNG PHẢI lượt dựng lại toàn bộ: nó chỉ upsert đúng những đơn còn dở, KHÔNG đụng sản phẩm/
 * tồn kho, KHÔNG xoá gì. Khác hẳn `rebuild-from-raw` (quét cả bảng, kéo tồn về ảnh ban đêm).
 *
 * RANH GIỚI PHẢI GIỮ:
 *  - CHỈ nhặt dòng chưa đóng dấu. `LEGACY` (kho dữ liệu cũ) và `DISCARDED` (chủ shop đã xoá Sổ) đều
 *    nằm ngoài tầm — dựng lại chúng là quyết định vận hành, chỉ lượt TAY mới được.
 *  - TUYỆT ĐỐI KHÔNG đụng cờ tồn đọng toàn cục: cờ đó chỉ có một đường hạ (nút "Dựng lại từ kho
 *    thô"), nên một nhịp DB chập sẽ để banner đỏ dính vĩnh viễn dù hệ đã tự lành. Trạng thái đã
 *    theo dõi được theo TỪNG DÒNG thì tín hiệu cũng phải đọc từ đó — luôn phản ánh hiện tại và tự
 *    tắt khi hết.
 *  - Dựng bằng CHÍNH `transformFromRaw("orders")` — cùng luật mirror, cùng CAS mốc nguồn, và chính
 *    nó đóng dấu kết cục. Viết đường dựng thứ hai ở đây là cách chắc chắn nhất để hai bên trôi lệch.
 */

/**
 * Bỏ qua dòng vừa land trong khoảng này — lượt ingest của chính nó nhiều khả năng còn đang chạy.
 * Khớp `STALE_MS` của SyncLog: quá mốc đó thì lượt kia coi như đã chết.
 */
export const QUA_HAN_PHUT = 15;

/**
 * Trần mỗi lượt. Còn nợ thì `eligibleRemaining` nói ra và đêm sau nhặt tiếp — thứ tự lấy lô ưu tiên
 * dòng ÍT LƯỢT THỬ NHẤT nên một nhúm dòng hỏng lặp lại không khoá được đầu hàng đợi.
 */
export const TRAN_MOI_LUOT = 200;

/** Trạng thái NGHIỆP VỤ của lượt đối soát — nguồn chuẩn cho n8n và panel, không phải mã HTTP. */
export type TrangThaiDoiSoat = "clean" | "pending" | "needs_attention" | "skipped";

export type KetQuaDoiSoat = {
  status: TrangThaiDoiSoat;
  /** Tổng đơn đang dở (đếm THẬT, không bị trần lô chặn). */
  pendingTotal: number;
  /** Đơn đang dở CHƯA lấy ra lượt này. */
  eligibleRemaining: number;
  /** Đơn mang kết cục cần người xem (dừng thử lại tự động nhưng chưa ai xử lý). */
  needsAttentionTotal: number;
  /** Mốc tải về của đơn dở CŨ NHẤT — để biết việc đã treo bao lâu. */
  oldestPendingAt: Date | null;
  applied: number;
  excludedMirror: number;
  superseded: number;
  failedShape: number;
  failedRetryLimit: number;
  discarded: number;
  /** Số bản cũ (không phải bản mới nhất) vừa được đóng bằng SQL thuần. */
  banCuDaDong: number;
};

/**
 * Lỗi CẢ LÔ: không đối soát được đáng tin cậy (DB sập giữa chừng…). Người gọi dịch thành 500.
 *
 * Tách khỏi "đơn không dựng được": lỗi cả lô KHÔNG được tính là một lượt thử của từng dòng — nếu
 * không, một nhịp DB chập sẽ đẩy cả nghìn dòng tới ngưỡng dừng-thử-lại cùng lúc, tức dùng một sự cố
 * tạm thời để chôn vĩnh viễn cả nghìn đơn có tiền.
 */
export class LoiDoiSoatKhongDangTinCay extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoiDoiSoatKhongDangTinCay";
  }
}

/**
 * Chạy một lượt đối soát. KHÔNG tự quyết định có nên chạy hay không (BRONZE_ONLY / đang phục hồi) —
 * đó là việc của người gọi, để hàm này dùng lại được cả từ endpoint lẫn script.
 */
export async function doiSoatDonConDo(warnings: string[]): Promise<KetQuaDoiSoat> {
  // Đóng các bản KHÔNG phải mới nhất trước: transform chỉ chạm bản mới nhất mỗi đơn nên chúng
  // không bao giờ tự có kết cục, và nếu để nguyên thì phép đếm tồn đọng hiện hàng trăm dòng ma.
  const banCuDaDong = await dongDauCacBanCuChuaDongDau();

  const conDo = await locDonQuaHanChuaDongDau(QUA_HAN_PHUT, TRAN_MOI_LUOT);

  // Số dòng của CHÍNH lô này còn dở sau khi chạy xong — để trừ ra khi tính phần CHƯA lấy tới.
  let vanConDoSauLuot = 0;

  const dem = {
    applied: 0,
    excludedMirror: 0,
    superseded: 0,
    failedShape: 0,
    failedRetryLimit: 0,
    discarded: 0,
  };

  if (conDo.length > 0) {
    // Gom theo shop: `transformFromRaw` nhận một `shopId` mỗi lượt (nhánh orders lọc raw theo shop).
    const theoShop = new Map<string, string[]>();
    for (const r of conDo) {
      const ds = theoShop.get(r.shopId) ?? [];
      ds.push(r.externalId);
      theoShop.set(r.shopId, ds);
    }

    for (const [shopId, externalIds] of theoShop) {
      try {
        await transformFromRaw("orders", warnings, { externalIds, shopId });
      } catch (err) {
        // Cả lô của shop này KHÔNG chạy được ⇒ ta KHÔNG biết dòng nào hỏng vì chính nó. Ném ra để
        // người gọi báo "không đối soát được đáng tin cậy", và TUYỆT ĐỐI không tăng lượt thử cho
        // dòng nào — chấm điểm dòng bằng một sự cố hạ tầng là chôn nhầm đơn có tiền.
        throw new LoiDoiSoatKhongDangTinCay(
          `Đối soát shop ${shopId} không chạy được: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // Đọc lại kết cục THẬT của từng dòng đã thử — thước đo phải là trạng thái trong DB, không phải
    // bộ đếm của transform (bộ đếm không nói dòng nào ra dòng nào).
    const sau = await ketCucHienTaiCuaDon(conDo);
    const theoKhoa = new Map(sau.map((r) => [`${r.shopId} ${r.externalId}`, r.silverOutcome]));

    for (const r of conDo) {
      const kc = theoKhoa.get(`${r.shopId} ${r.externalId}`) ?? null;
      if (kc === KET_CUC.APPLIED) dem.applied++;
      else if (kc === KET_CUC.EXCLUDED_MIRROR) dem.excludedMirror++;
      else if (kc === KET_CUC.SUPERSEDED) dem.superseded++;
      else if (kc === KET_CUC.FAILED_SHAPE) dem.failedShape++;
      else if (kc === KET_CUC.FAILED_RETRY_LIMIT) dem.failedRetryLimit++;
      else if (kc === KET_CUC.DISCARDED) dem.discarded++;
      else {
        // Vẫn chưa có kết cục: lô đã chạy xong nên đây là lỗi GẮN VỚI CHÍNH DÒNG NÀY. Ghi nhận một
        // lượt thử; đủ ngưỡng thì chuyển sang dừng-thử-lại để lượt đêm không hỏng vĩnh viễn.
        // Lý do lấy đúng cảnh báo NHẮC TỚI ĐƠN NÀY, không phải cảnh báo cuối mảng (lô nhiều đơn
        // thì cái cuối gần như luôn là của đơn khác).
        const lyDo =
          warnings.filter((w) => w.includes(r.externalId)).at(-1) ??
          "không dựng được vào Sổ (không rõ lý do)";
        const daDungThuLai = await ghiNhanThuThatBai(r.id, lyDo);
        if (daDungThuLai) dem.failedRetryLimit++;
        else vanConDoSauLuot++;
      }
    }
  }

  const { tong: pendingTotal, cuNhat: oldestPendingAt } = await demTonDong(QUA_HAN_PHUT);
  const needsAttentionTotal = await demCanXem();
  // Phần CHƯA lấy tới = tổng còn dở TRỪ phần lô này đã thử mà vẫn dở. Trừ theo bộ đếm kết cục là
  // sai: `pendingTotal` đo SAU lượt chạy nên những dòng đã dựng xong vốn không còn nằm trong đó.
  const eligibleRemaining = Math.max(0, pendingTotal - vanConDoSauLuot);

  if (pendingTotal > 0) {
    warnings.push(
      `Còn ${pendingTotal} đơn chưa dựng vào Sổ (cũ nhất từ ${oldestPendingAt?.toISOString() ?? "?"}) ` +
        `— đêm sau nhặt tiếp; lượt này lấy tối đa ${TRAN_MOI_LUOT}`
    );
  }
  if (needsAttentionTotal > 0) {
    warnings.push(
      `${needsAttentionTotal} đơn đã DỪNG thử lại tự động (payload không map được hoặc hỏng lặp lại) ` +
        `— cần người xem rồi dựng lại từ kho thô`
    );
  }

  const status: TrangThaiDoiSoat =
    needsAttentionTotal > 0 ? "needs_attention" : pendingTotal > 0 ? "pending" : "clean";

  return {
    status,
    pendingTotal,
    eligibleRemaining,
    needsAttentionTotal,
    oldestPendingAt,
    ...dem,
    banCuDaDong,
  };
}
