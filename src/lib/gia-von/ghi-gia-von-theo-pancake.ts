/**
 * Đường GHI của công cụ đối chiếu giá vốn — tách khỏi script để có test tích hợp trên DB test.
 *
 * Ba lời hứa an toàn của công cụ này đều nằm ở đây, nên cả ba phải có test ép chúng tự đứng:
 *
 * 1. **Backup trước, ghi sau.** Ghi giá vốn là đè lên số APP-OWNED chủ shop nhập tay; không có bản
 *    chụp trước khi đè thì không có đường lùi. Backup được ghi RỒI ĐỌC LẠI xác minh trước khi chạm
 *    dòng DB đầu tiên — hỏng ở bất kỳ khâu nào (không tạo được file, đĩa đầy, ghi thiếu, nội dung
 *    lệch) thì ném luôn, DB không đổi một dòng.
 * 2. **Chỉ ghi khi giá vốn còn đúng số đã đọc lúc xem.** Điều kiện nằm TRONG chính câu UPDATE
 *    (compare-and-set), không phải đọc-rồi-ghi: chủ shop sửa tay dòng nào giữa chừng thì dòng đó
 *    không khớp `where` nữa ⇒ số của chủ shop THẮNG. Cùng luật cho dữ liệu vừa được phục hồi hay
 *    dựng lại giữa lúc xem và lúc ghi — kể cả khi bảng còn TRỐNG giữa lượt nạp: không khớp thì
 *    không đè, và khớp 0 dòng thì script phải nói rõ chứ không in "Xong".
 * 3. **Ghi DƯỚI khoá việc nặng** (`src/lib/backup/khoa-viec-nang.ts` — lease trong bảng `Setting`).
 *    Script là tiến trình RIÊNG nối thẳng DB nên không thấy cờ khoá bảo trì trong tiến trình app
 *    (`khoa-bao-tri.ts` là `globalThis`, chỉ chặn Server Action); thứ mọi tiến trình cùng thấy là
 *    lease trong DB — đúng cái lượt phục hồi TRONG APP (`POST /api/restore`) giành TRƯỚC khi chụp
 *    bản lùi và giữ tươi tới sát lệnh phá huỷ đầu tiên. Nên: lượt phục hồi đang chạy ⇒ script giành
 *    trượt ⇒ TỪ CHỐI, không tạo cả file backup; script đang ghi ⇒ lượt phục hồi nhận 409 kèm tên
 *    việc này. Không có lớp này, N dòng ghi trúng cửa sổ [chụp bản lùi, DROP SCHEMA] bị bản backup
 *    nuốt mà màn hình vẫn in "Xong: ghi N biến thể".
 *
 *    HÀNG RÀO NẰM TRONG TỪNG TRANSACTION GHI, không phải checkpoint theo lô. Lease có hạn 5' và
 *    script không có nhịp tim nền (kỷ luật đã chốt của repo): nếu script đứng > 5' giữa hai dòng
 *    (kết nối treo, máy ngủ) thì lease hết hạn, lượt phục hồi giành THẮNG hợp lệ ở mọi cổng của nó
 *    (chúng chỉ hỏi token của chính route), chụp bản lùi — và một checkpoint theo lô sẽ để script
 *    tỉnh dậy ghi nốt cả lô vào đúng khe bị nuốt. Vì thế MỖI dòng là một transaction:
 *    `kiemGiuKhoaTrongTransaction` khoá dòng lease bằng `FOR UPDATE` + kiểm token, rồi mới UPDATE
 *    `Variant` — cùng transaction. Lease đã sang tay ⇒ ném trước UPDATE; lease còn của ta ⇒ lượt
 *    giành mới phải CHỜ ta commit, tức dòng ghi luôn đứng TRƯỚC lúc lượt phục hồi có lease (= trước
 *    bản lùi). Không có khe (đo thật DB test: lease của ta đã quá hạn 60s, lượt giành bị chặn suốt
 *    850ms và chỉ có lease 1ms SAU commit của ta). Hàng rào kiểm TOKEN chứ không kiểm HẠN: lease
 *    hết hạn mà chưa ai giành thì vẫn ghi tiếp được — an toàn, vì ai giành sau đó vẫn phải chờ ta
 *    commit; đã có người giành thì dòng kế tiếp dừng. Vì thế không cần gia hạn: lượt ghi ~45ms/dòng
 *    (đo thật, 91 dòng ≈ 4s; transaction + FOR UPDATE chỉ thêm ~7ms/dòng).
 *
 *    Đánh đổi CỐ Ý, đừng "sửa": ta giữ dòng lease FOR UPDATE trong ~45ms mỗi dòng ⇒ câu gia hạn của
 *    lượt phục hồi phải chờ chừng ấy. Chiều ngược, việc nặng nào giữ dòng lease trong transaction
 *    dài (lượt xoá dữ liệu giao dịch) làm FOR UPDATE của ta chờ quá hạn transaction Prisma (5s) ⇒
 *    Prisma ném, dòng đó rollback, `LoiDungGiuaChung` — đúng hành vi. KHÔNG nâng hạn transaction.
 *
 *    Mất lease hay lỗi DB giữa chừng ⇒ `LoiDungGiuaChung`: nói rõ đã thử/ghi/bỏ qua bao nhiêu dòng
 *    và file backup nào để hoàn nguyên — không bao giờ in "Xong" cho một lượt cụt.
 *
 *    Giới hạn 1 (chung với mọi việc nặng, xem route phục hồi bước (3b)): lease nằm trong chính
 *    `Setting` mà lượt phục hồi thay sạch. `pg_restore --clean` đo thật: mọi `DROP` đi trước (cả
 *    `Variant` lẫn `Setting`), rồi `COPY Setting` TRƯỚC `COPY Variant`. Trong vùng đó câu giành
 *    lease hoặc NÉM (bảng chưa có ⇒ lỗi thoát ra trước khi chạm dòng nào, fail-closed) hoặc thắng
 *    lease cũ đã quá hạn trong file backup — nhưng lúc ấy `Variant` còn RỖNG tới khi `COPY` xong,
 *    CAS khớp 0 dòng, và `COPY` chỉ INSERT vào bảng vừa tạo nên không đè gì. Kết cục: lỗi / "không
 *    ghi được dòng nào" (script cảnh báo, exit 1) / ghi hợp lệ lên dữ liệu đã nạp — không mất im lặng.
 *
 *    Giới hạn 2 — KHÔNG phủ đường phục hồi TRÊN HOST: `deploy/restore.sh` (DR, `supabase_admin`,
 *    `DROP SCHEMA … CASCADE`) không giành lease. Chạy script trúng lượt đó vẫn là lỗ hổng gốc ⇒ quy
 *    tắc vận hành "kiểm trạng thái phục hồi TRƯỚC khi chạy" VẪN BẮT BUỘC với DR trên host; chỉ lượt
 *    phục hồi trong app là tự chặn. Vá thật cần `restore.sh` giành cùng lease trước bước drop —
 *    việc riêng, đụng DR.
 */
import { readFileSync, writeFileSync } from "node:fs";

import type { Prisma } from "@prisma/client";

import type { DeXuatGiaVon } from "./doi-chieu-gia-von";

/** Tên việc hiện trong câu 409 của lượt phục hồi / lượt xoá dữ liệu khi chúng bị script này chặn. */
/**
 * Tên việc hiện ra khi một việc nặng khác bị từ chối vì lượt này đang giữ lease.
 *
 * Bỏ chữ "(script)" từ 2026-09-07: nay có HAI đường vào cùng dùng lease này — CLI và nút "Áp giá
 * vốn Pancake" trong app. Cùng một tên là CỐ Ý (hai đường phải loại trừ nhau); nhưng nhãn nói
 * "script" trong khi chủ shop vừa bấm nút trong app thì câu từ chối đọc như báo lỗi của hệ khác.
 */
export const VIEC_GHI_GIA_VON = "ghi giá vốn theo Pancake";

/**
 * Chỉ cần MỘT phép trên Prisma: mở transaction tương tác. Khai hẹp để test truyền client thật hoặc
 * một lớp bọc mỏng (soi/cướp lease giữa hai dòng) mà không cần ép kiểu. Bên trong transaction dùng
 * `Prisma.TransactionClient` thật vì hàng rào lease (`kiemGiuKhoaTrongTransaction`) đòi đúng kiểu đó.
 */
export type ClientGhiGiaVon = {
  $transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
};

/**
 * Ba phép trên lease mà đường ghi cần — khai đúng hình dạng module `khoa-viec-nang` để script truyền
 * thẳng kết quả `await import(...)` vào (script chỉ được nạp module đó SAU khi `.env` đã load, vì nó
 * kéo theo `PrismaClient`), và test truyền cùng module thật để chạy trên DB test, không mock.
 */
export type KhoaViecNangPort = Pick<
  typeof import("@/lib/backup/khoa-viec-nang"),
  "giuKhoaViecNang" | "kiemGiuKhoaTrongTransaction" | "traKhoaViecNang"
>;

export type NoiDungBackup = {
  ghiLuc: string;
  cheDo: string;
  soDong: number;
  dong: { variantId: string; sku: string; ten: string; costPriceCu: number; costPriceMoi: number }[];
};

export type KetQuaGhi = {
  daGhi: number;
  /** Dòng không khớp điều kiện — giá vốn đã đổi giữa chừng (hoặc bảng trống), số đang có được giữ. */
  boQua: number;
  duongDanBackup: string;
};

/**
 * Lượt ghi bị cắt giữa chừng (mất lease ở hàng rào, hoặc lỗi DB ở một dòng). Mang theo số dòng ĐÃ
 * ghi và đã bỏ qua để câu báo không bao giờ đọc như "chưa làm gì" hay "đã xong": một phần đã vào DB,
 * và bản chụp để hoàn nguyên nằm ở `duongDanBackup`.
 *
 * "Ít nhất `daGhi`": một câu UPDATE đã commit mà kết nối đứt trước khi trả lời thì đếm thiếu 1 —
 * không tránh được, nên câu chữ không hứa con số chính xác.
 */
export class LoiDungGiuaChung extends Error {
  constructor(
    public readonly daGhi: number,
    public readonly boQua: number,
    public readonly tong: number,
    public readonly duongDanBackup: string,
    cause: unknown,
  ) {
    const lyDo = cause instanceof Error ? cause.message : String(cause);
    super(
      `DỪNG GIỮA CHỪNG sau ${daGhi + boQua}/${tong} dòng (ít nhất ${daGhi} đã ghi, ${boQua} bỏ qua vì ` +
        `không còn khớp giá lúc xem) — ${lyDo}\n` +
        `Backup "${duongDanBackup}" giữ giá TRƯỚC KHI GHI của cả ${tong} dòng đề xuất: chỉ hoàn nguyên ` +
        `dòng nào đang mang giá MỚI trong DB; dòng bị bỏ qua (chủ shop vừa sửa tay) thì để nguyên.`,
      { cause },
    );
    this.name = "LoiDungGiuaChung";
  }
}

/**
 * Ghi backup rồi ĐỌC LẠI để xác minh nguyên vẹn.
 *
 * Đọc lại chứ không tin `writeFileSync` trả về êm: ca đắt nhất không phải "ném lỗi" mà là ghi
 * được một phần (đĩa đầy, tiến trình bị cắt giữa chừng) — file vẫn tồn tại, mở ra mới biết cụt.
 * So cả số dòng lẫn từng cặp giá để bản chụp dùng được thật khi cần hoàn nguyên.
 */
export function ghiBackupVaXacMinh(duongDan: string, noiDung: NoiDungBackup): void {
  try {
    writeFileSync(duongDan, JSON.stringify(noiDung, null, 2), "utf8");
  } catch (e) {
    throw new Error(
      `Không ghi được backup giá vốn vào "${duongDan}" — TỪ CHỐI ghi DB. ` +
        `Nguyên nhân: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  let docLai: NoiDungBackup;
  try {
    docLai = JSON.parse(readFileSync(duongDan, "utf8")) as NoiDungBackup;
  } catch (e) {
    throw new Error(
      `Backup "${duongDan}" ghi xong nhưng đọc lại KHÔNG được (file cụt/hỏng) — TỪ CHỐI ghi DB. ` +
        `Nguyên nhân: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const lech =
    docLai.soDong !== noiDung.soDong ||
    docLai.dong.length !== noiDung.dong.length ||
    docLai.dong.some((d, i) => {
      const goc = noiDung.dong[i];
      return (
        d.variantId !== goc.variantId ||
        d.costPriceCu !== goc.costPriceCu ||
        d.costPriceMoi !== goc.costPriceMoi
      );
    });
  if (lech) {
    throw new Error(
      `Backup "${duongDan}" đọc lại KHÔNG khớp nội dung định ghi — TỪ CHỐI ghi DB. ` +
        `Bản chụp không hoàn nguyên được thì không có đường lùi.`,
    );
  }
}

/**
 * Ghi giá vốn cho danh sách đề xuất. Backup là CỔNG CHẶN: hỏng thì ném trước khi chạm DB.
 *
 * `ghiLuc` truyền vào (không tự lấy trong hàm) để test ghim được mốc và để script in ra đúng mốc
 * đã đóng dấu trong file backup — mốc trong bản chụp phải là mốc thật, không phải `null`.
 *
 * `hangRao` (tuỳ chọn) chạy BÊN TRONG transaction của MỖI dòng, ngay trước câu UPDATE — đường vào
 * từ script luôn đi qua `ghiGiaVonDuoiKhoaViecNang` bên dưới, nơi nó là hàng rào lease; hàm này để
 * trần để test lời hứa 1–2 không phải dựng lease. Hàng rào ném ⇒ transaction dòng đó huỷ, vòng ghi
 * dừng tại chỗ.
 */
export async function ghiGiaVonTheoPancake(
  client: ClientGhiGiaVon,
  deXuat: DeXuatGiaVon[],
  opts: {
    duongDanBackup: string;
    cheDo: string;
    ghiLuc: Date;
    hangRao?: (tx: Prisma.TransactionClient) => Promise<void>;
  },
): Promise<KetQuaGhi> {
  ghiBackupVaXacMinh(opts.duongDanBackup, {
    ghiLuc: opts.ghiLuc.toISOString(),
    cheDo: opts.cheDo,
    soDong: deXuat.length,
    dong: deXuat.map((d) => ({
      variantId: d.variantId,
      sku: d.sku,
      ten: d.ten,
      costPriceCu: d.giaHienTai,
      costPriceMoi: d.giaDeXuat,
    })),
  });

  let daGhi = 0;
  let boQua = 0;
  try {
    for (const d of deXuat) {
      const kq = await client.$transaction(async (tx) => {
        await opts.hangRao?.(tx);
        return tx.variant.updateMany({
          where: { id: d.variantId, costPrice: d.giaHienTai },
          data: { costPrice: d.giaDeXuat },
        });
      });
      if (kq.count > 0) daGhi += kq.count;
      else boQua += 1;
    }
  } catch (e) {
    throw new LoiDungGiuaChung(daGhi, boQua, deXuat.length, opts.duongDanBackup, e);
  }
  return { daGhi, boQua, duongDanBackup: opts.duongDanBackup };
}

/**
 * Đường vào DUY NHẤT của script: giành lease việc nặng → ghi (backup + CAS + hàng rào lease trong
 * từng transaction) → trả lease.
 *
 * Trả `{ tuChoi }` (kèm tên việc đang giữ) khi giành trượt — chưa tạo file backup, chưa chạm DB.
 * Câu giành NÉM (mất kết nối; bảng `Setting` không tồn tại vì schema đang bị thay) thì lỗi thoát
 * thẳng ra — cũng chưa chạm dòng nào. Cả hai đều là fail-closed: không có lease chắc tay thì không ghi.
 */
export async function ghiGiaVonDuoiKhoaViecNang(
  client: ClientGhiGiaVon,
  khoa: KhoaViecNangPort,
  deXuat: DeXuatGiaVon[],
  opts: { duongDanBackup: string; cheDo: string; ghiLuc: Date },
): Promise<KetQuaGhi | { tuChoi: string }> {
  const gianh = await khoa.giuKhoaViecNang(VIEC_GHI_GIA_VON);
  if (!gianh.the) return { tuChoi: gianh.dangGiu };
  const the = gianh.the;
  try {
    return await ghiGiaVonTheoPancake(client, deXuat, {
      ...opts,
      hangRao: (tx) => khoa.kiemGiuKhoaTrongTransaction(tx, the),
    });
  } finally {
    // Trả lease là best-effort: `traKhoaViecNang` chỉ xoá đúng token của mình (không giật khoá của
    // việc vừa giành), và nếu nó NÉM (bảng `Setting` đang bị thay) thì không được che lỗi gốc của
    // lượt ghi — lease tự hết hạn trong tối đa 5 phút.
    try {
      await khoa.traKhoaViecNang(the);
    } catch (e) {
      console.error(
        "Không trả được khoá việc nặng sau lượt ghi giá vốn — nó tự hết hạn trong tối đa 5 phút.",
        e,
      );
    }
  }
}
