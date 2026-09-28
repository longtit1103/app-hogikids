import type { Prisma, PrismaClient } from "@prisma/client";

import { prisma } from "@/lib/prisma";

/**
 * KẾT CỤC dựng Silver của một dòng `RawPancakeOrder` — lời đáp bền vững cho câu "dòng Bronze này
 * đã được xử lý xong chưa".
 *
 * VÌ SAO CẦN: Bronze commit ở một transaction, Silver ghi ở transaction khác, và ~98% thời
 * gian xử lý nằm SAU khi Bronze đã bền vững (đo: land 128ms, transform 6133ms/50 đơn). Chết cứng
 * ở giữa thì đơn nằm lại Bronze vĩnh viễn: lượt gửi lại trùng `payloadHash` nên không land lại,
 * transform nhận danh sách rỗng, HTTP 200 sạch trơn, doanh thu thiếu âm thầm. Một bit cờ toàn cục
 * không cứu được vì chính lượt ghi cờ cũng nằm sau điểm chết — phải là dấu THEO TỪNG DÒNG, và
 * trạng thái MẶC ĐỊNH phải là "chưa xong" (NULL) để hỏng thì hỏng có tiếng.
 *
 * Cùng khuôn với `RawPancakeWebhookEvent.processedAs`: payload gốc không bao giờ bị sửa, chỉ cột
 * metadata bên cạnh được ghi.
 */
export const KET_CUC = {
  /** Đã ghi vào Silver. */
  APPLIED: "APPLIED",
  /** Transform CỐ Ý không ghi (đơn mirror kho — bất biến doanh thu #2). */
  EXCLUDED_MIRROR: "EXCLUDED_MIRROR",
  /** Có phiên bản mới hơn thắng (thua CAS `rawFetchedAt`, hoặc không phải bản mới nhất của khoá). */
  SUPERSEDED: "SUPERSEDED",
  /**
   * Payload hiện KHÔNG map được. Payload Bronze bất biến ⇒ lỗi TẤT ĐỊNH, đêm nào thử lại cũng
   * hỏng y hệt ⇒ DỪNG retry tự động (nhưng vẫn hiện "cần xem"). Tách khỏi NULL là có chủ đích:
   * gộp chung thì dòng hỏng nằm mãi trong nhóm "phải retry", cảnh báo đỏ dính vĩnh viễn rồi bị bỏ
   * qua — đúng chế độ hỏng mà bộ đếm `boQuaCoChuDich` từng sinh ra để tránh.
   */
  FAILED_SHAPE: "FAILED_SHAPE",
  /**
   * Đã thử lại đủ số lượt mà vẫn hỏng. Khác `FAILED_SHAPE` ở chỗ lỗi KHÔNG nhìn ra được từ payload
   * (lỗi ghi lặp lại), nhưng để nó thử mãi thì lượt đêm hỏng vĩnh viễn — mà một lượt đêm hỏng mãi
   * thì chỉ vài tuần là không ai đọc nữa. Lượt dựng lại TAY vẫn được quyền thử lại.
   */
  FAILED_RETRY_LIMIT: "FAILED_RETRY_LIMIT",
  /**
   * Chủ shop đã bấm "Xóa dữ liệu giao dịch" khi dòng còn dở. Sổ được xoá CÓ CHỦ ĐÍCH nên dòng này
   * TUYỆT ĐỐI không được dựng lại tự động; chỉ lượt dựng lại TAY (có quyền riêng) mới ghi đè được.
   */
  DISCARDED: "DISCARDED",
  /** Dòng có trước migration `20260811110000`, chờ lượt đối soát phân loại. */
  LEGACY: "LEGACY",
} as const;

export type KetCucSilver = (typeof KET_CUC)[keyof typeof KET_CUC];

type ClientGhi = PrismaClient | Prisma.TransactionClient;

/**
 * Trượt CAS vì dòng vừa bị lượt "Xóa dữ liệu giao dịch" đóng `DISCARDED` — kết cục CÓ CHỦ ĐÍCH.
 *
 * Phải là lớp lỗi RIÊNG vì hai phía cần hai cách xử KHÁC NHAU trên cùng một cú ném: lượt ghi Silver
 * PHẢI cuộn lại (không hồi sinh thứ vừa xoá) — nên vẫn ném, không trả cờ; nhưng cổng đối soát KHÔNG
 * được đếm nó là mất dòng — nuốt vào `skipped` là bật cờ backlog GIẢ, banner "chạy rebuild" dính
 * vĩnh viễn, mà làm theo banner (rebuild TAY ghi đè DISCARDED) lại dựng lại đúng đơn vừa cố ý xoá.
 * Caller bắt lớp này ⇒ đếm `ordersDiscardedGiuaChung` (đã-hạch-toán) thay vì `skipped`.
 */
export class KetCucDaXoaTay extends Error {
  constructor(rawRowId: string) {
    super(
      `Dòng kho thô ${rawRowId} vừa bị lượt "Xóa dữ liệu giao dịch" đóng DISCARDED trong lúc đang ` +
        `dựng Sổ — huỷ lượt ghi này để không dựng lại thứ vừa bị xoá.`
    );
    this.name = "KetCucDaXoaTay";
  }
}

/**
 * Đóng dấu kết cục lên ĐÚNG dòng Bronze.
 *
 * `db` nhận client của transaction đang ghi Silver: với `APPLIED`/`SUPERSEDED`, dấu PHẢI commit
 * CÙNG lượt ghi Silver — tách ra là đẻ lại đúng khe vừa bịt ở quy mô nhỏ hơn (Silver ghi xong, chết
 * trước khi đóng dấu ⇒ lượt đối soát ghi lại lần nữa; lũy đẳng nên không hỏng tiền, nhưng thà
 * đóng luôn). Với `EXCLUDED_MIRROR`/`FAILED_SHAPE` thì không có transaction Silver nào để bám —
 * gọi bằng client thường là đúng.
 */
export async function dongDauKetCuc(
  db: ClientGhi,
  rawRowId: string,
  ketCuc: KetCucSilver,
  note?: string
): Promise<void> {
  // CAS `IS NULL OR = ketCuc`: dòng được đóng dấu khi CÒN đang dở, HOẶC khi đã mang ĐÚNG kết cục
  // sắp ghi (đóng lại thành no-op). Ném CHỈ khi dòng đã có kết cục KHÁC — cụ thể là chủ shop bấm
  // "Xóa dữ liệu giao dịch" (đóng `DISCARDED`); lúc đó lượt ghi Silver PHẢI cuộn lại vì ghi tiếp là
  // dựng lại đúng phần dữ liệu vừa chủ ý xoá.
  //
  // Vì sao nhận `= ketCuc` (lũy đẳng) chứ không chỉ `IS NULL`: hai lượt transform CHẠY SONG SONG trên
  // CÙNG một dòng Bronze mới nhất đều đi tới CÙNG một kết cục (kẻ thua khoá tư vấn vẫn khớp `updateMany`
  // vì `rawFetchedAt` bằng nhau, rồi tới đây). Nếu chỉ CAS `IS NULL` thì kẻ thua ném OAN ⇒ nuốt thành
  // `skipped` ⇒ cổng đối soát "đã land vs đã hạch toán" lệch ⇒ bật cờ backlog GIẢ (dính, chỉ rebuild
  // mới hạ) dù Sổ đã đúng. Kịch bản thường ngày: webhook Pancake bắn 2 sự kiện cùng đơn cách 0,2–7s;
  // và self-heal `/api/ingest/raw` trùng nhịp lượt đối soát đêm. `ketCuc` KHÔNG bao giờ là `DISCARDED`
  // (chỉ `dongDauDaXoaTay` đóng dấu đó) nên nhánh `= ketCuc` không thể hồi sinh dòng đã xoá.
  const r = await db.rawPancakeOrder.updateMany({
    where: { id: rawRowId, OR: [{ silverOutcome: null }, { silverOutcome: ketCuc }] },
    data: { silverOutcome: ketCuc, silverProcessedAt: new Date(), silverNote: note ?? null },
  });
  if (r.count === 0) {
    // Phân biệt VÌ SAO trượt để caller xử đúng: `DISCARDED` là kết cục có chủ đích (ném lớp riêng —
    // cuộn lại lượt ghi nhưng KHÔNG đếm là mất dòng); còn lại (dòng không tồn tại, hay một kết cục
    // khác không có đường hợp lệ nào dẫn tới) thì ném to như cũ.
    const hienTai = await db.rawPancakeOrder.findUnique({
      where: { id: rawRowId },
      select: { silverOutcome: true },
    });
    if (hienTai?.silverOutcome === KET_CUC.DISCARDED) throw new KetCucDaXoaTay(rawRowId);
    throw new Error(
      `Dòng kho thô ${rawRowId} đã có kết cục khác trong lúc đang dựng Sổ — huỷ lượt ghi này để ` +
        `không ghi đè một kết cục đã chốt.`
    );
  }
}

/**
 * Đóng dấu KHÔNG qua CAS — CHỈ cho lượt dựng lại TAY.
 *
 * Lượt dựng lại là chủ shop chủ động yêu cầu dựng lại từ kho thô, nên nó ĐƯỢC quyền ghi đè mọi kết
 * cục cũ, kể cả `DISCARDED`/`FAILED_*`. Tách hàm riêng thay vì thêm cờ vào `dongDauKetCuc`: quyền
 * ghi đè phải nằm ở TÊN HÀM để nhìn danh sách nơi gọi là biết ai có quyền.
 */
export async function dongDauKetCucBoiLuotTay(
  db: ClientGhi,
  rawRowId: string,
  ketCuc: KetCucSilver,
  note?: string
): Promise<void> {
  await db.rawPancakeOrder.update({
    where: { id: rawRowId },
    data: { silverOutcome: ketCuc, silverProcessedAt: new Date(), silverNote: note ?? null },
  });
}

/**
 * Trong số `externalIds`, đơn nào có BẢN MỚI NHẤT còn ở trạng thái CHƯA ĐÓNG DẤU (`NULL`)?
 *
 * Dùng ngay sau `landRaw` để lượt gửi lại tự chữa: khi tiến trình chết giữa chừng, lượt sau gửi
 * đúng payload cũ nên `landedIds` rỗng, nhưng dòng Bronze vẫn đang ở "chưa xong" — hỏi câu này là
 * biết ngay phải dựng lại đơn nào.
 *
 * ⚠️ CHỈ nhận `NULL`, TUYỆT ĐỐI KHÔNG nhận `LEGACY`. Hai trạng thái này khác nhau về QUYỀN HẠN,
 * không chỉ về nghĩa: `NULL` là việc dở của chính hệ thống nên đường ghi thường được tự dọn, còn
 * `LEGACY` là kho dữ liệu cũ chưa ai kiểm — dựng lại nó là một quyết định vận hành, phải đi qua
 * script backfill có xác nhận (`locDonLegacy`). Gộp chung thì bất kỳ payload cũ nào Pancake gửi
 * lại cũng âm thầm kéo theo một lượt backfill ngoài ý muốn, giữa đêm, không ai bấm nút.
 *
 * ⚠️ Điều kiện `silverOutcome` PHẢI lọc SAU `DISTINCT ON`, không được nhét vào `WHERE` bên trong:
 * `WHERE` chạy TRƯỚC `DISTINCT ON` nên lọc ở đó cho ra "bản mới nhất TRONG SỐ các bản chưa xong",
 * không phải bản mới nhất thật. Ca cụ thể: đơn có v1 chết dở (NULL) rồi v2 land sau và APPLIED —
 * lọc sai chỗ sẽ chọn v1 đem dựng lại, tức đẩy payload CŨ vào Silver. CAS `rawFetchedAt` chặn kịp
 * nên không hỏng tiền, nhưng lượt đối soát sẽ hiểu nhầm là "xử lý không được" và báo động giả mãi.
 */
export async function locDonChuaDongDau(shopId: string, externalIds: string[]): Promise<string[]> {
  if (externalIds.length === 0) return [];
  const rows = await prisma.$queryRaw<{ externalId: string }[]>`
    SELECT m."externalId" FROM (
      SELECT DISTINCT ON ("shopId", "externalId") "externalId", "silverOutcome"
      FROM "RawPancakeOrder"
      WHERE "shopId" = ${shopId} AND "externalId" = ANY(${externalIds}::text[])
      ORDER BY "shopId", "externalId", "fetchedAt" DESC, "id" DESC
    ) m
    WHERE m."silverOutcome" IS NULL
  `;
  return rows.map((r) => r.externalId);
}

/**
 * Các đơn có BẢN MỚI NHẤT còn CHƯA ĐÓNG DẤU và đã quá hạn — việc cho lượt đối soát đêm.
 *
 * `quaHanPhut` để tránh giẫm chân lượt ingest ĐANG chạy: một dòng vừa land vài giây trước thì rất
 * có thể transform của chính nó còn đang chạy, nhặt lên là hai lượt cùng dựng một đơn (CAS đỡ được
 * nên không hỏng tiền, nhưng tốn công và đẻ cảnh báo khó hiểu). Ngưỡng khớp `STALE_MS` của SyncLog:
 * quá mốc đó thì lượt kia coi như đã chết.
 *
 * CHỈ `NULL` — `LEGACY` là kho dữ liệu cũ, chỉ script backfill có xác nhận mới được đụng.
 */
export async function locDonQuaHanChuaDongDau(
  quaHanPhut: number,
  gioiHan: number
): Promise<{ id: string; shopId: string; externalId: string }[]> {
  return prisma.$queryRaw<{ id: string; shopId: string; externalId: string }[]>`
    SELECT m."id", m."shopId", m."externalId" FROM (
      SELECT DISTINCT ON ("shopId", "externalId")
        "id", "shopId", "externalId", "silverOutcome", "fetchedAt", "silverAttempts"
      FROM "RawPancakeOrder"
      ORDER BY "shopId", "externalId", "fetchedAt" DESC, "id" DESC
    ) m
    WHERE m."silverOutcome" IS NULL
      AND m."fetchedAt" < now() - make_interval(mins => ${quaHanPhut}::int)
    -- Ít lượt thử TRƯỚC, rồi mới tới cũ nhất. Sắp thuần theo mốc tải về thì một nhúm dòng hỏng
    -- lặp lại (luôn là cũ nhất) sẽ khoá đầu hàng đợi vĩnh viễn và đơn kẹt MỚI không bao giờ tới
    -- lượt — đúng kiểu chết đói mà trần lô che mất.
    ORDER BY m."silverAttempts", m."fetchedAt"
    LIMIT ${gioiHan}
  `;
}

/**
 * ĐẾM tổng số đơn đang dở — câu riêng KHÔNG có `LIMIT`.
 *
 * Dùng chính câu lấy lô để đếm thì con số bị trần lô chặn: tồn 3.000 đơn vẫn báo "còn 200", nên
 * mỗi đêm nhìn đều như sắp xong trong khi phải mất hai tuần mới rút hết.
 */
export async function demTonDong(quaHanPhut: number): Promise<{ tong: number; cuNhat: Date | null }> {
  const [r] = await prisma.$queryRaw<{ tong: bigint; cuNhat: Date | null }[]>`
    SELECT count(*)::bigint AS tong, min(m."fetchedAt") AS "cuNhat" FROM (
      SELECT DISTINCT ON ("shopId", "externalId") "silverOutcome", "fetchedAt"
      FROM "RawPancakeOrder"
      ORDER BY "shopId", "externalId", "fetchedAt" DESC, "id" DESC
    ) m
    WHERE m."silverOutcome" IS NULL
      AND m."fetchedAt" < now() - make_interval(mins => ${quaHanPhut}::int)
  `;
  return { tong: Number(r?.tong ?? 0), cuNhat: r?.cuNhat ?? null };
}

/** Đếm các dòng mang kết cục CẦN NGƯỜI XEM (dừng thử lại tự động nhưng chưa ai xử lý). */
export async function demCanXem(): Promise<number> {
  const [r] = await prisma.$queryRaw<{ tong: bigint }[]>`
    SELECT count(*)::bigint AS tong FROM (
      SELECT DISTINCT ON ("shopId", "externalId") "silverOutcome"
      FROM "RawPancakeOrder"
      ORDER BY "shopId", "externalId", "fetchedAt" DESC, "id" DESC
    ) m
    WHERE m."silverOutcome" IN (${KET_CUC.FAILED_SHAPE}, ${KET_CUC.FAILED_RETRY_LIMIT})
  `;
  return Number(r?.tong ?? 0);
}

/** Một đơn cần người xem trên panel /cai-dat. */
export type DonCanXem = {
  shopId: string;
  externalId: string;
  silverOutcome: string;
  silverNote: string | null;
  silverProcessedAt: Date | null;
};

/**
 * Danh sách các đơn ĐÃ DỪNG thử lại tự động (payload không map được, hoặc hỏng lặp lại đủ ngưỡng) —
 * mỗi dòng là một việc cần vào sửa mapping rồi dựng lại từ kho thô. Đọc bản mới nhất mỗi khoá.
 *
 * ⚠️ Điều kiện `silverOutcome` PHẢI lọc SAU `DISTINCT ON` (giống `demCanXem`): lọc ở `WHERE` bên
 * trong sẽ chọn "bản mới nhất TRONG SỐ các bản hỏng", bỏ sót ca đơn đã được sửa (bản mới APPLIED).
 */
export async function dsDonCanXem(gioiHan: number): Promise<DonCanXem[]> {
  return prisma.$queryRaw<DonCanXem[]>`
    SELECT m."shopId", m."externalId", m."silverOutcome", m."silverNote", m."silverProcessedAt" FROM (
      SELECT DISTINCT ON ("shopId", "externalId")
        "shopId", "externalId", "silverOutcome", "silverNote", "silverProcessedAt"
      FROM "RawPancakeOrder"
      ORDER BY "shopId", "externalId", "fetchedAt" DESC, "id" DESC
    ) m
    WHERE m."silverOutcome" IN (${KET_CUC.FAILED_SHAPE}, ${KET_CUC.FAILED_RETRY_LIMIT})
    ORDER BY m."silverProcessedAt" DESC NULLS LAST
    LIMIT ${gioiHan}
  `;
}

/**
 * Số lượt thử thất bại LIÊN TIẾP trước khi chuyển sang dừng-thử-lại, và khoảng cách tối thiểu
 * giữa hai lượt được tính.
 *
 * Khoảng cách là phần quan trọng: không có nó thì một sự cố kéo dài (hoặc ai đó bấm lại vài lần)
 * bị tính thành nhiều lượt thử độc lập và dòng bị chôn sống chỉ sau vài phút. 20 giờ = sát nhịp
 * một-lượt-mỗi-đêm nhưng vẫn co giãn được nếu lượt đêm chạy sớm/muộn.
 */
export const SO_LUOT_THU_TOI_DA = 3;
export const CACH_NHAU_TOI_THIEU_GIO = 20;

/**
 * Ghi nhận MỘT lượt thử THẤT BẠI gắn với chính dòng này. Đủ ngưỡng thì đóng `FAILED_RETRY_LIMIT`.
 *
 * CHỈ gọi khi lượt đối soát thật sự thử dòng đó và nhận lỗi CỦA NÓ. Lỗi hạ tầng/cả lô thì tuyệt
 * đối không gọi — nếu không, một nhịp DB chập đẩy cả nghìn dòng tới ngưỡng dừng-thử-lại cùng lúc,
 * tức là dùng một sự cố tạm thời để chôn vĩnh viễn cả nghìn đơn có tiền.
 *
 * Trả `true` nếu dòng vừa bị chuyển sang dừng-thử-lại.
 */
export async function ghiNhanThuThatBai(rawRowId: string, note: string): Promise<boolean> {
  const row = await prisma.rawPancakeOrder.findUnique({
    where: { id: rawRowId },
    select: { silverAttempts: true, silverLastAttemptAt: true, silverOutcome: true },
  });
  // Dòng đã có kết cục trong lúc đó (vd vừa bị đóng DISCARDED) ⇒ không đụng nữa.
  if (!row || row.silverOutcome !== null) return false;

  // Lượt thử quá gần lượt trước KHÔNG được tính: cùng một sự cố, không phải hai bằng chứng độc lập.
  const quaGan =
    row.silverLastAttemptAt !== null &&
    Date.now() - row.silverLastAttemptAt.getTime() < CACH_NHAU_TOI_THIEU_GIO * 3_600_000;
  const soLuot = quaGan ? row.silverAttempts : row.silverAttempts + 1;
  const chuyenSangDungThuLai = soLuot >= SO_LUOT_THU_TOI_DA;

  await prisma.rawPancakeOrder.updateMany({
    where: { id: rawRowId, silverOutcome: null },
    data: {
      silverAttempts: soLuot,
      silverLastAttemptAt: quaGan ? row.silverLastAttemptAt : new Date(),
      silverNote: note.slice(0, 500),
      ...(chuyenSangDungThuLai
        ? { silverOutcome: KET_CUC.FAILED_RETRY_LIMIT, silverProcessedAt: new Date() }
        : {}),
    },
  });
  return chuyenSangDungThuLai;
}

/**
 * Đóng `DISCARDED` cho mọi dòng CHƯA ĐƯỢC HẠCH TOÁN — gọi TRONG transaction xoá Sổ của
 * "Xóa dữ liệu giao dịch".
 *
 * Không có bước này thì đúng những dòng còn dở (chính ca mà cột kết cục sinh ra để bắt) sẽ được
 * lượt đối soát đêm dựng lại vào một cái Sổ vừa được xoá sạch — chủ shop xoá xong, hôm sau Sổ có
 * lại một nhúm đơn lẻ và P&L thành số nửa vời.
 *
 * PHẢI gồm CẢ `LEGACY`, không chỉ `NULL`. `LEGACY` là kho dữ liệu cũ chưa ai kiểm, và nó có một
 * đường dựng lại riêng (`scripts/backfill-ket-cuc-legacy.ts`) không đi qua nút "Dựng lại từ kho
 * thô". Bỏ sót nhánh này thì chuỗi "xoá dữ liệu giao dịch → chạy backfill" dựng lại hàng trăm ĐƠN
 * mà KHÔNG dựng settlement / chi tiêu quảng cáo / chi phí nhập tay — một cái Sổ phục hồi NỬA VỜI mà
 * lượt chạy vẫn báo thành công. Đúng chế độ hỏng mà `DISCARDED` sinh ra để chặn, chỉ khác cửa vào.
 *
 * Các kết cục ĐÃ CHỐT (`APPLIED`, `EXCLUDED_MIRROR`, `SUPERSEDED`, `FAILED_*`) KHÔNG bị đụng: chúng
 * là dấu vết một lần xử lý đã xong, không phải việc còn treo. Riêng `APPLIED` sau lượt xoá mang
 * nghĩa "đã từng vào Sổ" trong khi Sổ rỗng — đó là điều đã biết và có chủ đích (xem ghi chú
 * `silverOutcome` ở `schema.prisma`), đường dựng lại đúng của chúng là nút "Dựng lại từ kho thô".
 *
 * Trả số dòng đã đóng.
 */
export async function dongDauDaXoaTay(tx: Prisma.TransactionClient): Promise<number> {
  const r = await tx.rawPancakeOrder.updateMany({
    where: { OR: [{ silverOutcome: null }, { silverOutcome: KET_CUC.LEGACY }] },
    data: {
      silverOutcome: KET_CUC.DISCARDED,
      silverProcessedAt: new Date(),
      silverNote: "Sổ đã được xoá tay khi dòng này chưa được hạch toán — không dựng lại tự động",
    },
  });
  return r.count;
}

/**
 * Kết cục HIỆN TẠI của bản mới nhất, cho đúng danh sách đơn đã cho.
 *
 * Lượt đối soát dùng để phân loại kết quả SAU khi dựng: dòng còn `NULL` là kẹt thật (thử lại được,
 * phải kêu đỏ), còn dòng thành `FAILED_SHAPE` là hỏng tất định (dừng thử lại, chỉ hiện "cần xem").
 * Trộn hai loại vào nhau thì hoặc mất tín hiệu, hoặc lượt đêm đỏ vĩnh viễn rồi bị bỏ qua.
 */
export async function ketCucHienTaiCuaDon(
  cap: { shopId: string; externalId: string }[]
): Promise<{ shopId: string; externalId: string; silverOutcome: string | null }[]> {
  if (cap.length === 0) return [];
  const shopIds = cap.map((c) => c.shopId);
  const externalIds = cap.map((c) => c.externalId);
  return prisma.$queryRaw`
    SELECT m."shopId", m."externalId", m."silverOutcome" FROM (
      SELECT DISTINCT ON ("shopId", "externalId") "shopId", "externalId", "silverOutcome"
      FROM "RawPancakeOrder"
      WHERE ("shopId", "externalId") IN (
        SELECT * FROM unnest(${shopIds}::text[], ${externalIds}::text[])
      )
      ORDER BY "shopId", "externalId", "fetchedAt" DESC, "id" DESC
    ) m
  `;
}

/**
 * Trong số `externalIds`, đơn nào có BẢN MỚI NHẤT mang nhãn `LEGACY` (dữ liệu cũ chưa ai kiểm)?
 *
 * CHỈ script backfill có xác nhận được gọi — xem ghi chú quyền hạn ở `locDonChuaDongDau`. Tách
 * hàm riêng thay vì thêm tham số cờ là cố ý: một tham số boolean rất dễ bị truyền nhầm từ đường
 * ghi thường, còn hàm riêng thì nhìn danh sách nơi gọi là biết ai có quyền.
 */
export async function locDonLegacy(gioiHan: number): Promise<{ shopId: string; externalId: string }[]> {
  return prisma.$queryRaw<{ shopId: string; externalId: string }[]>`
    SELECT m."shopId", m."externalId" FROM (
      SELECT DISTINCT ON ("shopId", "externalId") "shopId", "externalId", "silverOutcome"
      FROM "RawPancakeOrder"
      ORDER BY "shopId", "externalId", "fetchedAt" DESC, "id" DESC
    ) m
    WHERE m."silverOutcome" = ${KET_CUC.LEGACY}
    LIMIT ${gioiHan}
  `;
}

/**
 * Đóng dấu `SUPERSEDED` cho mọi dòng chưa có kết cục mà KHÔNG phải bản mới nhất của khoá
 * (shopId, externalId).
 *
 * Transform chỉ chạm bản mới nhất mỗi khoá, nên các bản cũ hơn không bao giờ được đóng dấu —
 * chúng sẽ nằm mãi trong nhóm "chưa xong" và làm phép đếm tồn đọng hiện hàng trăm dòng ma (đo
 * prod 11/08: 291/1293 dòng không phải bản mới nhất). Đây là lượt quét SQL thuần, KHÔNG chạy
 * transform: chúng đã bị một phiên bản mới hơn thay thế, dựng lại là dựng bằng dữ liệu cũ.
 *
 * Trả số dòng đã đóng.
 *
 * KHÔNG export trực tiếp: quyền hạn "có được đụng `LEGACY` không" phải nằm ở TÊN HÀM chứ không
 * phải một tham số boolean — cờ boolean rất dễ bị truyền nhầm từ đường ghi thường, còn hai hàm
 * riêng thì nhìn danh sách nơi gọi là biết ai có quyền gì.
 */
async function dongDauCacBanCu(gomLegacy: boolean): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    WITH moi_nhat AS (
      SELECT DISTINCT ON ("shopId", "externalId") "id"
      FROM "RawPancakeOrder"
      ORDER BY "shopId", "externalId", "fetchedAt" DESC, "id" DESC
    ),
    da_dong AS (
      UPDATE "RawPancakeOrder" r
      SET "silverOutcome" = ${KET_CUC.SUPERSEDED},
          "silverProcessedAt" = now(),
          "silverNote" = 'Bản cũ hơn — đã có phiên bản mới hơn của cùng đơn'
      WHERE ("silverOutcome" IS NULL OR (${gomLegacy}::boolean AND "silverOutcome" = ${KET_CUC.LEGACY}))
        AND r."id" NOT IN (SELECT "id" FROM moi_nhat)
      RETURNING 1
    )
    SELECT count(*)::bigint AS count FROM da_dong
  `;
  return Number(rows[0]?.count ?? 0);
}

/**
 * Đóng các bản cũ CHƯA ĐÓNG DẤU — dùng được ở lượt đối soát đêm (không đụng kho dữ liệu cũ).
 */
export const dongDauCacBanCuChuaDongDau = (): Promise<number> => dongDauCacBanCu(false);

/**
 * Đóng các bản cũ, GỒM CẢ `LEGACY` — CHỈ script backfill có xác nhận được gọi.
 */
export const dongDauCacBanCuGomLegacy = (): Promise<number> => dongDauCacBanCu(true);
