import {
  demCanXem,
  demTonDong,
  dongDauCacBanCuGomLegacy,
  KET_CUC,
  ketCucHienTaiCuaDon,
  locDonLegacy,
} from "@/lib/bronze/ket-cuc-silver";
import { transformFromRaw } from "@/lib/bronze/transform-from-raw";
import { QUA_HAN_PHUT } from "@/lib/bronze/doi-soat-don-con-do";
import { demDonBiLuatLoaiConTrongSo } from "@/lib/bronze/rebuild";
import { prisma } from "@/lib/prisma";

/**
 * BACKFILL kết cục cho kho dữ liệu cũ (`silverOutcome = 'LEGACY'`).
 *
 * Migration `20260811110000` đặt nhãn `LEGACY` cho MỌI dòng `RawPancakeOrder` có trước nó — đó là
 * cách nói "dòng này chưa ai kiểm", không phải một kết cục. Lượt đối soát đêm CỐ Ý không đụng tới
 * chúng (xem ghi chú quyền hạn ở `locDonChuaDongDau`): dựng lại kho cũ là một QUYẾT ĐỊNH VẬN HÀNH,
 * phải do người bấm, một lần, có xác nhận — chứ không phải việc một payload cũ Pancake gửi lại giữa
 * đêm cũng kéo theo được.
 *
 * Vì sao phải làm cho xong: bao lâu còn dòng `LEGACY` thì câu hỏi "có đơn nào kẹt Bronze không"
 * chưa có lời đáp cho phần lịch sử — mỗi dòng ở đó có thể là đơn đã vào Sổ, đơn mirror bị loại
 * đúng luật, hay đơn MẤT ÂM THẦM, mà nhìn nhãn thì không phân biệt được.
 *
 * RANH GIỚI:
 *  - Dựng bằng CHÍNH `transformFromRaw("orders")` — cùng luật mirror, cùng CAS mốc nguồn, và chính
 *    nó đóng dấu kết cục. Viết đường dựng thứ hai ở đây là cách chắc chắn nhất để hai bên trôi lệch.
 *  - KHÔNG gọi `rebuildFromRaw`: lượt dựng lại toàn bộ còn kéo products/tồn kho về ảnh ban đêm (phá
 *    tồn realtime của webhook) và dựng lại chi tiêu quảng cáo. Việc ở đây hẹp hơn hẳn — chỉ đơn.
 *  - CÓ truyền `onRejected` + đếm đơn bị luật loại mà vẫn nằm trong Sổ: tập `LEGACY` chính là tập
 *    nhiều mirror kho nhất, mà mirror nằm trong Sổ nghĩa là doanh thu đếm 2 lần. Đơn bù Shopee
 *    (`scripts/bu-don-shopee-tu-don-kho.ts`) CỐ Ý mang id mirror nhưng đã được trừ sẵn trong
 *    `demDonBiLuatLoaiConTrongSo` (`backfilledFromMirror`), nên phép đếm này không báo động giả.
 *  - KHÔNG ghi nhận "lượt thử thất bại" (`silverAttempts`): bộ đếm đó thuộc về lượt đối soát TỰ
 *    ĐỘNG với dòng `NULL`. Dòng `LEGACY` dựng không nổi thì báo tên ra cho người xem, không tự
 *    chôn dần.
 *  - `BRONZE_ONLY` CỐ Ý không chặn lượt này — cùng lý do đã chốt ở `dungLaiTuKhoTho`: công tắc đó
 *    bắt Sổ đứng yên CHO TỚI KHI có một lượt dựng lại TAY, và đây chính là một lượt như vậy. Chặn
 *    là khoá luôn đường phục hồi. (Khác hẳn lượt đối soát ĐÊM — nó tự động nên phải tuân công tắc.)
 */

/** Số đơn mỗi lô. Đủ nhỏ để một lô hỏng không kéo theo cả lượt, đủ lớn để không nghẽn round-trip. */
export const LO_MAC_DINH = 100;

/** Lỗi CẢ LÔ — không quy được trách nhiệm cho dòng nào. Người gọi dừng lượt và báo hỏng. */
export class LoiBackfillKhongDangTinCay extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoiBackfillKhongDangTinCay";
  }
}

/** Phân bố kết cục — đếm theo BẢN MỚI NHẤT của mỗi đơn, và theo TỔNG SỐ DÒNG. */
export type PhanBoKetCuc = Record<string, number>;

/**
 * Bốn cột tiền của Sổ + số đơn — bằng chứng "lượt này chỉ dán nhãn, không đụng tiền".
 *
 * Repo có tiền lệ đắt giá: một cổng chặn suy đoán cắt mất 80.170đ trên prod mà test + CI + hai vòng
 * review đều lọt, chỉ lượt dựng lại trên DỮ LIỆU THẬT mới lộ. Nên lượt ghi nào viết lại Sổ cũng
 * phải in số tiền trước/sau, không chỉ nhãn kết cục.
 */
export type TienSo = {
  soDon: number;
  itemsTotal: number;
  discount: number;
  platformFeeEst: number;
  returnedFee: number;
};

export type KhaoSatLegacy = {
  /** Bản mới nhất mỗi đơn, gom theo kết cục (khoá `(NULL)` cho dòng chưa đóng dấu). */
  theoDonMoiNhat: PhanBoKetCuc;
  /** Mọi dòng trong bảng, gom theo kết cục — để thấy phần bản cũ sẽ thành `SUPERSEDED`. */
  theoDong: PhanBoKetCuc;
  /** Đơn có bản mới nhất còn `LEGACY` — ĐÂY là tập việc của lượt backfill. */
  legacyMoiNhat: number;
  /** Tổng dòng `LEGACY` (gồm cả bản cũ không phải mới nhất). */
  legacyTongDong: number;
  /** Bản `LEGACY` KHÔNG phải mới nhất ⇒ sẽ được đóng `SUPERSEDED` bằng SQL thuần, không transform. */
  legacyBanCu: number;
  /** Đơn chưa đóng dấu (`NULL`) — mọi tuổi, kể cả dòng vừa land. */
  nullMoiNhat: number;
  /**
   * Đơn chưa đóng dấu ĐÃ QUÁ HẠN — dùng cho phán quyết "sạch". Dòng vừa land vài giây trước không
   * tính: webhook không giữ khoá việc nặng nên vẫn land được giữa lượt backfill, coi nó là bẩn thì
   * lượt nào cũng báo hỏng oan.
   */
  nullQuaHan: number;
  /** Đơn mang kết cục CẦN NGƯỜI XEM (`FAILED_SHAPE` / `FAILED_RETRY_LIMIT`). */
  canXem: number;
  /** Đơn `LEGACY` mới nhất, gom theo shop — transform nhận một `shopId` mỗi lượt. */
  legacyTheoShop: { shopId: string; so: number }[];
  /** Ảnh chụp tiền của Sổ tại thời điểm khảo sát. */
  tienSo: TienSo;
  /**
   * Không còn dòng `LEGACY` NÀO — kể cả bản cũ. Đây là ĐỊNH NGHĨA XONG của riêng lượt backfill.
   *
   * Phải soi CẢ bản cũ: bản `LEGACY` không-phải-mới-nhất chỉ có LƯỢT NÀY đóng được (lượt đối soát
   * đêm chỉ nhận `NULL`). Bỏ sót nó là để lại một dòng không đường nào dọn, mà vẫn báo "xong".
   *
   * CỐ Ý không gộp `nullQuaHan`/`canXem` vào đây: tồn đọng dòng `NULL` là việc của lượt đối soát
   * ĐÊM, lượt này không gây ra và cũng không được phép chữa. Gộp vào thì một tồn đọng có sẵn làm
   * lượt backfill chạy đúng 100% vẫn báo hỏng — người vận hành mất luôn tín hiệu thật.
   */
  hetLegacy: boolean;
};

/** ĐỌC trạng thái, KHÔNG ghi gì — dùng cho cả lượt thử lẫn phép kiểm sau lượt ghi. */
export async function khaoSatLegacy(): Promise<KhaoSatLegacy> {
  const [theoDonRows, theoDongRows, legacyShopRows] = await Promise.all([
    prisma.$queryRaw<{ kc: string; so: bigint }[]>`
      SELECT coalesce(m."silverOutcome", '(NULL)') AS kc, count(*)::bigint AS so FROM (
        SELECT DISTINCT ON ("shopId", "externalId") "shopId", "externalId", "silverOutcome"
        FROM "RawPancakeOrder"
        ORDER BY "shopId", "externalId", "fetchedAt" DESC, "id" DESC
      ) m
      GROUP BY 1
    `,
    prisma.$queryRaw<{ kc: string; so: bigint }[]>`
      SELECT coalesce("silverOutcome", '(NULL)') AS kc, count(*)::bigint AS so
      FROM "RawPancakeOrder"
      GROUP BY 1
    `,
    prisma.$queryRaw<{ shopId: string; so: bigint }[]>`
      SELECT m."shopId", count(*)::bigint AS so FROM (
        SELECT DISTINCT ON ("shopId", "externalId") "shopId", "externalId", "silverOutcome"
        FROM "RawPancakeOrder"
        ORDER BY "shopId", "externalId", "fetchedAt" DESC, "id" DESC
      ) m
      WHERE m."silverOutcome" = ${KET_CUC.LEGACY}
      GROUP BY 1
      ORDER BY 2 DESC
    `,
  ]);

  const gom = (rows: { kc: string; so: bigint }[]): PhanBoKetCuc =>
    Object.fromEntries(rows.map((r) => [r.kc, Number(r.so)]));

  const theoDonMoiNhat = gom(theoDonRows);
  const theoDong = gom(theoDongRows);

  const legacyMoiNhat = theoDonMoiNhat[KET_CUC.LEGACY] ?? 0;
  const legacyTongDong = theoDong[KET_CUC.LEGACY] ?? 0;

  // Dùng chính hai phép đếm của lượt đối soát đêm — một luật "đang dở"/"cần xem" cho cả hai đường.
  const { tong: nullQuaHan } = await demTonDong(QUA_HAN_PHUT);
  const canXem = await demCanXem();

  const tong = await prisma.order.aggregate({
    _count: { _all: true },
    _sum: { itemsTotal: true, discount: true, platformFeeEst: true, returnedFee: true },
  });
  const tienSo: TienSo = {
    soDon: tong._count._all,
    itemsTotal: tong._sum.itemsTotal ?? 0,
    discount: tong._sum.discount ?? 0,
    platformFeeEst: tong._sum.platformFeeEst ?? 0,
    returnedFee: tong._sum.returnedFee ?? 0,
  };

  return {
    theoDonMoiNhat,
    theoDong,
    legacyMoiNhat,
    legacyTongDong,
    legacyBanCu: legacyTongDong - legacyMoiNhat,
    nullMoiNhat: theoDonMoiNhat["(NULL)"] ?? 0,
    nullQuaHan,
    canXem,
    legacyTheoShop: legacyShopRows.map((r) => ({ shopId: r.shopId, so: Number(r.so) })),
    tienSo,
    hetLegacy: legacyTongDong === 0,
  };
}

/** Bốn cột tiền có đổi giữa hai ảnh chụp không? Lượt backfill đúng luật phải trả `false`. */
export function tienDaDoi(truoc: TienSo, sau: TienSo): boolean {
  return (
    truoc.itemsTotal !== sau.itemsTotal ||
    truoc.discount !== sau.discount ||
    truoc.platformFeeEst !== sau.platformFeeEst ||
    truoc.returnedFee !== sau.returnedFee
  );
}

export type KetQuaBackfillLegacy = {
  truoc: KhaoSatLegacy;
  sau: KhaoSatLegacy;
  /** Bản cũ (không phải mới nhất) vừa đóng `SUPERSEDED` bằng SQL thuần. */
  banCuDaDong: number;
  /** Số lô đã chạy. */
  soLo: number;
  /** Kết cục ĐỌC LẠI TỪ DB của từng đơn đã thử, gom theo nhãn (mỗi đơn đếm MỘT lần). */
  ketCucDaThu: PhanBoKetCuc;
  /**
   * Mẫu đơn còn kẹt ở `LEGACY` sau lượt chạy — đọc lại TỪ DB nên không trùng lặp. Danh sách để
   * người xem biết đi đâu, không phải để máy tự xử.
   */
  donKet: { shopId: string; externalId: string }[];
  /** Đơn mang id bị luật loại mà vẫn nằm trong Sổ (nghi đếm doanh thu 2 lần) — chỉ đếm, không xoá. */
  mirrorConTrongSo: number;
};

/**
 * Chạy backfill. GHI THẬT — người gọi chịu trách nhiệm về cổng chặn: xác nhận của người, `SyncLog`
 * PANCAKE không có lượt nào RUNNING, và khoá việc nặng đang được giữ (checkpoint truyền vào đây).
 */
export async function chayBackfillLegacy(
  warnings: string[],
  opts: { checkpoint?: () => Promise<void>; lo?: number } = {}
): Promise<KetQuaBackfillLegacy> {
  const { checkpoint, lo = LO_MAC_DINH } = opts;
  const truoc = await khaoSatLegacy();

  // Chấm mốc TRƯỚC câu GHI đầu tiên, không chỉ trong vòng lặp: khảo sát phía trên là mấy lượt quét
  // cả bảng, treo lâu hơn hạn khoá là ta ghi sau khi đã mất quyền — đúng thứ hàng rào sinh ra để
  // chặn (cùng lý do `rebuild.ts` chấm mốc trước câu `updateMany` ngoài vòng của nó).
  await checkpoint?.();
  // Đóng bản cũ TRƯỚC (giống lượt đối soát đêm): transform chỉ chạm bản mới nhất mỗi đơn nên bản cũ
  // không bao giờ tự có kết cục, để nguyên thì phép đếm tồn đọng hiện hàng trăm dòng ma.
  let banCuDaDong = await dongDauCacBanCuGomLegacy();

  const ketCucDaThu: PhanBoKetCuc = {};
  const daDem = new Set<string>();
  // `externalId` bị luật HIỆN TẠI loại khỏi Sổ (mirror / hỏng shape) — luật loại nằm DUY NHẤT trong
  // transform, người gọi không được tự suy lại.
  const biLuatLoai: string[] = [];
  let soLo = 0;

  // Trần lô — chỉ là chốt chặn quay-vòng-vô-hạn, KHÔNG phải hạn mức công việc: mỗi lô không dừng
  // sớm đều tiến được ÍT NHẤT một đơn (lô không tiến nổi dòng nào thì `daTien === 0` cắt ngay bên
  // dưới), nên số lô không bao giờ vượt số đơn. Trần này vì thế không thể chặn oan một lượt lành.
  const soLoToiDa = truoc.legacyMoiNhat + 2;

  for (;;) {
    const batch = await locDonLegacy(lo);
    if (batch.length === 0) break;
    if (soLo >= soLoToiDa) {
      warnings.push(
        `Dừng ở lô ${soLo}: vượt trần ${soLoToiDa} lô suy từ ${truoc.legacyMoiNhat} đơn LEGACY đo lúc ` +
          `bắt đầu. Trần này chỉ chạm được khi có gì đó sai — kiểm rồi chạy lại.`
      );
      break;
    }
    await checkpoint?.();

    // Gom theo shop: nhánh `orders` của transform lọc raw theo shop (dùng index, và tránh
    // over-transform khi hai shop lỡ trùng `externalId`).
    const theoShop = new Map<string, string[]>();
    for (const r of batch) {
      const ds = theoShop.get(r.shopId) ?? [];
      ds.push(r.externalId);
      theoShop.set(r.shopId, ds);
    }

    for (const [shopId, externalIds] of theoShop) {
      try {
        await transformFromRaw("orders", warnings, {
          externalIds,
          shopId,
          // Tập LEGACY là tập NHIỀU MIRROR KHO NHẤT — mà mirror nằm trong Sổ nghĩa là doanh thu
          // đếm 2 lần. Transform chỉ ngừng upsert chứ không xoá, nên phải tự đếm rồi cảnh báo.
          onRejected: (eid) => biLuatLoai.push(eid),
          // BẮT BUỘC: dấu kết cục thường đi qua CAS `IS NULL OR = kết cục sắp ghi`, mà `LEGACY` là
          // một nhãn KHÁC ⇒ CAS trượt và ném. Quyền ghi đè chính là thứ phân biệt lượt backfill có
          // người xác nhận với đường ghi thường ngày.
          luotTayDuocGhiDe: true,
          checkpoint,
        });
      } catch (err) {
        // Cả lô của shop này KHÔNG chạy được ⇒ ta KHÔNG biết dòng nào hỏng vì chính nó. Ném ra để
        // người gọi báo hỏng cả lượt, thay vì đổ lỗi cho từng đơn rồi bỏ qua chúng.
        throw new LoiBackfillKhongDangTinCay(
          `Backfill shop ${shopId} không chạy được: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // Thước đo là trạng thái THẬT trong DB, không phải bộ đếm của transform (bộ đếm không nói dòng
    // nào ra dòng nào).
    const sauLo = await ketCucHienTaiCuaDon(batch);
    const theoKhoa = new Map(sauLo.map((r) => [`${r.shopId} ${r.externalId}`, r.silverOutcome]));
    let daTien = 0;
    const ketLoNay: { shopId: string; externalId: string }[] = [];
    for (const r of batch) {
      const khoa = `${r.shopId} ${r.externalId}`;
      const kc = theoKhoa.get(khoa) ?? null;
      // Đơn kẹt được lô sau lấy lại (câu lọc không có con trỏ) — đếm mỗi đơn MỘT lần, nếu không
      // bảng thống kê phồng lên theo số lô và đọc thành "đã thử nhiều đơn hơn thực có".
      if (!daDem.has(khoa)) {
        daDem.add(khoa);
        const nhan = kc ?? "(NULL)";
        ketCucDaThu[nhan] = (ketCucDaThu[nhan] ?? 0) + 1;
      }
      if (kc === KET_CUC.LEGACY) ketLoNay.push(r);
      else daTien++;
    }
    soLo++;

    if (daTien === 0) {
      // `locDonLegacy` không có con trỏ: lô sau lấy lại đúng nhóm này ⇒ lặp vô hạn. Dừng và báo tên
      // ra ngoài; số liệu lượt này vẫn giữ để người xem biết đã đi được tới đâu.
      warnings.push(
        `${ketLoNay.length} đơn thử xong vẫn ở LEGACY (lô ${soLo}) — dừng để không quay vòng vô hạn. ` +
          `Ví dụ: ${ketLoNay
            .slice(0, 5)
            .map((r) => `${r.shopId}/${r.externalId}`)
            .join(", ")}`
      );
      break;
    }
  }

  // Đóng bản cũ LẦN NỮA: giữa lượt, webhook vẫn land được (nó KHÔNG giữ khoá việc nặng), nên một
  // đơn đang `LEGACY` có thể vừa có bản mới hơn — dòng LEGACY cũ tụt khỏi nhóm "bản mới nhất" mà
  // lượt đối soát đêm thì chỉ nhận `NULL`. Không quét lại là để lại một dòng KHÔNG đường nào dọn.
  await checkpoint?.();
  banCuDaDong += await dongDauCacBanCuGomLegacy();

  // Đơn mang id bị luật loại mà VẪN nằm trong Sổ = nghi đếm doanh thu 2 lần. Dùng đúng phép đếm của
  // lượt dựng lại toàn bộ (đã trừ đơn bù từ bản sao kho) — chỉ CẢNH BÁO, không tự xoá.
  const mirrorConTrongSo = await demDonBiLuatLoaiConTrongSo([...new Set(biLuatLoai)]);
  if (mirrorConTrongSo > 0) {
    warnings.push(
      `${mirrorConTrongSo} đơn Silver nay bị luật loại nhưng vẫn còn trong Sổ ` +
        `(doanh thu có thể đếm 2 lần) — cần xoá tay`
    );
  }

  const sau = await khaoSatLegacy();
  // Mẫu đơn còn kẹt đọc lại TỪ DB: đó là sự thật sau lượt chạy, và không lẫn bản trùng do lô sau
  // lấy lại cùng một đơn.
  const donKet = sau.legacyMoiNhat > 0 ? await locDonLegacy(20) : [];
  return { truoc, sau, banCuDaDong, soLo, ketCucDaThu, donKet, mirrorConTrongSo };
}
