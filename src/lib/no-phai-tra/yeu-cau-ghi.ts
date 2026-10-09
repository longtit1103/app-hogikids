import { createHash } from "node:crypto";

import type { Prisma } from "@/generated/prisma/client";

/**
 * Yêu cầu ghi CÓ MÃ — chống ghi lặp khi mất phản hồi (spec §5.3). Client sinh `id` (uuid) cho MỘT lượt
 * bấm; server làm mọi bước trong MỘT transaction:
 *   (1) `giuYeuCau` — `INSERT … ON CONFLICT (id) DO NOTHING RETURNING id`. KHÔNG bắt P2002: unique
 *       violation làm Postgres huỷ CẢ transaction (tiền lệ `chi-phi-nhap-hang.ts`), nên câu chèn không
 *       được phép ném. Lượt gửi lại ĐỒNG THỜI chờ ở unique index tới khi lượt đầu commit/rollback rồi
 *       mới biết có xung đột ⇒ không bao giờ hai lượt cùng ghi.
 *   (2)…(5) khoá hồ sơ, kiểm vân tay sau khoá, ghi tiền, nhật ký — việc của action gọi.
 *   (6) `ghiKetQua` — CÙNG tx với dòng tiền: chưa commit thì không có kết quả nào công khai.
 * Gặp `{ cu }`: `bamNoiDung` bằng ⇒ action trả `ketQua` cũ + `DA_GHI_ROI` (không ghi gì); khác ⇒ từ chối
 * "mã yêu cầu đã dùng cho nội dung khác". Xoá dòng tiền KHÔNG xoá `YeuCauGhi`.
 */

/** Kết quả action lưu vào `YeuCauGhi.ketQua` và trả lại nguyên văn cho lượt gửi lại. */
export type KetQuaYeuCau = { ok: true; data: unknown; code?: "DA_GHI_ROI" };

/** Sắp khoá object ĐỆ QUY (mảng giữ nguyên thứ tự — thứ tự phần tử là nội dung). */
function chuanHoa(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(chuanHoa);
  if (v !== null && typeof v === "object" && !(v instanceof Date)) {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .sort()
        .map((k) => [k, chuanHoa(o[k])]),
    );
  }
  return v;
}

/** sha256 hex của payload đã chuẩn hoá khoá — cùng nội dung khác thứ tự khoá ⇒ cùng vân tay. */
export function bamNoiDung(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(chuanHoa(payload))).digest("hex");
}

/**
 * Bước (1): giữ mã yêu cầu. `"MOI"` = lượt này giữ được mã, đi tiếp các bước ghi; `{ cu }` = mã đã có
 * dòng ĐÃ COMMIT (của lượt trước) — action so `cu.bamNoiDung` với vân tay của mình rồi quyết.
 */
export async function giuYeuCau(
  tx: Prisma.TransactionClient,
  { id, loai, bam }: { id: string; loai: string; bam: string },
): Promise<"MOI" | { cu: { bamNoiDung: string; ketQua: unknown } }> {
  const chen = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "YeuCauGhi" ("id", "loai", "bamNoiDung")
    VALUES (${id}, ${loai}, ${bam})
    ON CONFLICT ("id") DO NOTHING
    RETURNING "id"`;
  if (chen.length === 1) return "MOI";

  const cu = await tx.yeuCauGhi.findUnique({ where: { id }, select: { bamNoiDung: true, ketQua: true } });
  // ON CONFLICT chỉ "không chèn" khi dòng xung đột ĐÃ commit (READ COMMITTED chờ lượt kia xong) ⇒ đọc
  // phải thấy. Không thấy = hợp đồng vỡ (vd ai xoá giữa chừng) — nổ, đừng đoán.
  if (cu === null) throw new Error(`YeuCauGhi ${id}: ON CONFLICT nhưng không đọc thấy dòng cũ`);
  return { cu };
}

/** Bước (6): ghi kết quả CÙNG tx với dòng tiền. Mã chưa giữ (quên bước 1) ⇒ Prisma ném P2025. */
export async function ghiKetQua(tx: Prisma.TransactionClient, id: string, ketQua: unknown): Promise<void> {
  // Khứ hồi JSON: `ketQua` phải là dữ liệu thuần (trả lại nguyên văn cho lượt gửi lại); `undefined` trong
  // object rơi mất như mọi JSON. Kết quả rỗng hẳn là lỗi đường ghi, không lưu NULL giả "chưa ghi".
  const json = JSON.stringify(ketQua);
  if (json === undefined || json === "null") throw new Error(`YeuCauGhi ${id}: kết quả rỗng`);
  await tx.yeuCauGhi.update({ where: { id }, data: { ketQua: JSON.parse(json) as Prisma.InputJsonValue } });
}
