import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

/**
 * KHOÁ DÙNG CHUNG cho các "việc nặng" đụng cùng một tập dữ liệu: xoá dữ liệu giao dịch, dựng lại từ
 * kho thô (nút trong app), lượt phục hồi DB (`POST /api/restore`), và các script chạy NGOÀI tiến
 * trình app: `scripts/rebuild-from-raw.ts`, `scripts/backfill-ket-cuc-legacy.ts`, đường ghi giá vốn
 * `src/lib/gia-von/ghi-gia-von-theo-pancake.ts` (của `doi-chieu-gia-von-pancake.ts --ghi`).
 *
 * Lượt phục hồi đứng vào hàng việc nặng vì một lý do riêng: cổng drain của nó soi `SyncLog`
 * chỉ đoán sống/chết bằng TUỔI (RUNNING > 15' coi như chết), nên một lượt dựng lại chạy quá 15'
 * thành vô hình đúng lúc còn đang ghi. Khoá này thì được chủ giữ TƯƠI bằng checkpoint tiến độ thật
 * ⇒ "giành trượt" là tín hiệu sống thật. ⚠️ Riêng với phục hồi, khoá CHỈ là cổng chặn TRƯỚC vùng
 * phá huỷ — nó nằm trong chính bảng `Setting` mà lượt phục hồi thay sạch, nên sau lệnh phá huỷ đầu
 * tiên không được coi là hàng rào nữa, và trả khoá phía đó là best-effort (xem route).
 *
 * VÌ SAO PHẢI Ở DB, không phải cờ trong bộ nhớ: cờ `globalThis` chỉ có hiệu lực TRONG container
 * app, mà script dựng lại chạy ở TIẾN TRÌNH RIÊNG (`docker compose run --rm app npx tsx ...`).
 * Kịch bản hỏng đã chỉ ra: script đang chạy → chủ shop bấm "Xóa dữ liệu giao dịch" → lượt xoá vẫn
 * giành được cờ trong app, đóng dấu đã-xoá-tay rồi xoá Sổ → script chạy tiếp với quyền ghi đè của
 * lượt tay và dựng dữ liệu trở lại. Nút xoá báo thành công nhưng bị hoàn tác ngầm.
 *
 * GIÀNH NGUYÊN TỬ: một câu `INSERT ... ON CONFLICT DO UPDATE ... WHERE` — Postgres tự tuần tự hoá,
 * nên hai tiến trình cùng bấm thì đúng một bên thắng. Kiểm-rồi-giành (kể cả kiểm bằng `SyncLog`)
 * luôn còn khe giữa lúc kiểm và lúc giành.
 *
 * HẾT HẠN + CHECKPOINT (KHÔNG dùng nhịp tim nền): chủ khoá phải tự gia hạn, nhưng gia hạn bằng một
 * timer chạy nền là SAI — repo đã chốt điều này ở `khoa-bao-tri.ts`. Timer sống độc lập với công
 * việc: việc chính treo cứng mà pool vẫn trả được câu gia hạn thì khoá được giữ VÔ HẠN, tức là mất
 * đúng cái mà hạn sinh ra để bảo vệ.
 *
 * Thay vào đó: `taoCheckpoint()` trả một hàm mà chính công việc gọi ở các mốc TIẾN ĐỘ THẬT (trước
 * mỗi stream, giữa các lô dài). Một lời gọi làm CẢ HAI việc trong MỘT câu ghi nguyên tử — gia hạn
 * nếu còn giữ, và báo mất nếu không. Việc treo thì không có checkpoint nào chạy ⇒ khoá hết hạn đúng
 * như thiết kế; việc chạy bình thường thì mỗi bước tiến là một lần gia hạn.
 *
 * Hàng rào là BẮT BUỘC chứ không phải tuỳ chọn: hạn KHÔNG kèm hàng rào còn nguy hơn không hạn, vì
 * khoá hết hạn oan trong lúc chủ cũ vẫn đang ghi thì hai bên cùng ghi lên một tập dữ liệu.
 */

const KHOA_KEY = "khoaViecNang";

/**
 * Hạn của khoá. Chủ khoá gia hạn ở mỗi CHECKPOINT (mốc tiến độ thật), nên hạn này chỉ tới khi chủ
 * ĐÃ CHẾT hoặc treo cứng — lúc đó không checkpoint nào chạy để đẩy hạn.
 */
export const HAN_KHOA_MS = 5 * 60_000;

/**
 * Mất khoá giữa chừng. Công việc PHẢI dừng ngay — ghi tiếp là ghi song song với việc vừa giành khoá.
 */
export class MatKhoaViecNang extends Error {
  constructor(viec: string) {
    super(
      `Mất khoá việc nặng ("${viec}") giữa chừng — một việc khác đã giành được. Dừng để không ghi ` +
        `đè lên việc đó. Chạy lại sau khi việc kia xong.`,
    );
    this.name = "MatKhoaViecNang";
  }
}

export type TheKhoa = { token: string; viec: string };

/** Chuỗi lưu trong `Setting.value`: `<token>|<hạn epoch ms>|<tên việc>`. */
function dungGiaTri(token: string, viec: string): string {
  return `${token}|${Date.now() + HAN_KHOA_MS}|${viec}`;
}

function docGiaTri(
  v: string,
): { token: string; hanMs: number; viec: string } | null {
  const [token, han, ...rest] = v.split("|");
  const hanMs = Number(han);
  if (!token || !Number.isFinite(hanMs)) return null;
  return { token, hanMs, viec: rest.join("|") };
}

/**
 * Giành khoá. Trả thẻ khi thắng, `null` khi việc khác đang giữ (kèm tên việc đó ở `dangGiu`).
 *
 * Điều kiện thắng nằm TRONG chính câu ghi: chưa ai giữ, hoặc khoá đang giữ đã QUÁ HẠN (chủ cũ chết).
 */
export async function giuKhoaViecNang(
  viec: string,
): Promise<{ the: TheKhoa } | { the: null; dangGiu: string }> {
  const token = randomUUID();
  const rows = await prisma.$queryRaw<{ value: string }[]>`
    INSERT INTO "Setting" ("key", "value") VALUES (${KHOA_KEY}, ${dungGiaTri(token, viec)})
    ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value"
    WHERE split_part("Setting"."value", '|', 2)::bigint < (extract(epoch from now()) * 1000)::bigint
    RETURNING "value"
  `;
  if (rows.length > 0) return { the: { token, viec } };

  const dang = await prisma.setting.findUnique({ where: { key: KHOA_KEY } });
  return {
    the: null,
    dangGiu:
      (dang?.value && docGiaTri(dang.value)?.viec) || "một việc nặng khác",
  };
}

/**
 * Gia hạn VÀ kiểm quyền trong MỘT câu ghi nguyên tử. Trả `false` nếu đã mất khoá.
 *
 * Một câu duy nhất là cố ý: kiểm rồi mới gia hạn (hai câu) lại mở đúng khe mà nó sinh ra để đóng.
 */
export async function giaHanKhoa(the: TheKhoa): Promise<boolean> {
  const r = await prisma.$executeRaw`
    UPDATE "Setting" SET "value" = ${dungGiaTri(the.token, the.viec)}
    WHERE "key" = ${KHOA_KEY} AND split_part("value", '|', 1) = ${the.token}
  `;
  return r > 0;
}

/**
 * Phép ĐỌC trạng thái khoá — cho test/chẩn đoán, KHÔNG phải hàng rào.
 *
 * Đây là đọc-rồi-trả-lời, có TOCTOU: giữa lúc đọc và lúc caller hành động, khoá có thể đổi chủ.
 * Hai hàng rào THẬT là nguyên tử: `giaHanKhoa` (qua `taoCheckpoint`, gia-hạn-và-kiểm trong một câu
 * ghi) cho việc chạy dài, và `kiemGiuKhoaTrongTransaction` (khoá dòng `FOR UPDATE`) cho việc phá
 * huỷ trong transaction. Đừng dùng hàm này để quyết định có ghi tiếp hay không.
 */
export async function conGiuKhoa(the: TheKhoa): Promise<boolean> {
  const row = await prisma.setting.findUnique({ where: { key: KHOA_KEY } });
  const d = row?.value ? docGiaTri(row.value) : null;
  return d?.token === the.token;
}

/** Trả khoá — CHỈ khi ta còn là chủ (không giật khoá của việc khác). Gọi trong `finally`. */
export async function traKhoaViecNang(the: TheKhoa): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM "Setting" WHERE "key" = ${KHOA_KEY} AND split_part("value", '|', 1) = ${the.token}
  `;
}

/**
 * Tạo hàm CHECKPOINT cho một việc nặng: gọi ở các mốc tiến độ thật; ném khi đã mất khoá.
 *
 * Đây là cách DUY NHẤT nên dùng để giữ khoá sống — không timer nền (xem ghi chú đầu file).
 */
export function taoCheckpoint(the: TheKhoa): () => Promise<void> {
  return async () => {
    if (!(await giaHanKhoa(the))) throw new MatKhoaViecNang(the.viec);
  };
}

/**
 * HÀNG RÀO BÊN TRONG TRANSACTION: khoá chính dòng khoá bằng `FOR UPDATE` rồi kiểm quyền.
 *
 * Kiểm TRƯỚC transaction vẫn còn khe: giữa lúc kiểm và lúc commit, khoá có thể hết hạn và việc khác
 * giành mất. `FOR UPDATE` giữ dòng tới khi transaction này commit, nên lượt giành mới PHẢI CHỜ —
 * và khi nó chạy được thì hạn của ta đã tươi, nên nó không giành nổi.
 */
export async function kiemGiuKhoaTrongTransaction(
  tx: Prisma.TransactionClient,
  the: TheKhoa,
): Promise<void> {
  const rows = await tx.$queryRaw<{ value: string }[]>`
    SELECT "value" FROM "Setting" WHERE "key" = ${KHOA_KEY} FOR UPDATE
  `;
  const d = rows[0]?.value ? docGiaTri(rows[0].value) : null;
  if (d?.token !== the.token) throw new MatKhoaViecNang(the.viec);
}
