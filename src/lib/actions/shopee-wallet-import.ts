"use server";

import { revalidatePath } from "next/cache";

import type { ActionResult } from "@/lib/actions/action-result";
import { dangPhucHoi, LOI_DANG_PHUC_HOI } from "@/lib/backup/khoa-bao-tri";
import { landRaw } from "@/lib/bronze/land-raw";
import { layCauHinhShop } from "@/lib/ket-noi/cau-hinh-shop";
import { transformFromRaw } from "@/lib/bronze/transform-from-raw";
import { thongDiepGaySoDu, timGaySoDuVi } from "@/lib/import/shopee-wallet-lien-tuc-so-du";
import { parseShopeeWalletFile, type WalletSummary } from "@/lib/import/shopee-wallet-xlsx";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

/**
 * Server actions cho luồng Import file ví Shopee ("Tiền đã về" đa kênh, tab Dòng
 * tiền `/tai-chinh`). Shopee KHÔNG có API → chủ shop tải TAY file ví mỗi kỳ.
 *
 * WALLET-ONLY: chỉ file ví (net + rút bank). File Income (chi tiết phí) BỎ khỏi
 * scope (red-team F3 — chưa có consumer).
 *
 * Bất biến:
 *  - Land Bronze `RawShopeeWalletTxn` → transform Silver `ShopeeSettlement`. ĐỘC LẬP
 *    P&L/doanh thu (doanh thu CHỈ từ Pancake) — file này KHÔNG tạo Expense/đơn.
 *  - [F2] CỔNG CHẶN checksum: Σ theo cột "Dòng tiền" (do parser tính) PHẢI khớp block
 *    "Tóm tắt" trong file. Lệch (hoặc thiếu block) → TỪ CHỐI import, không land nửa vời.
 *    Đứng TRƯỚC nó còn một cổng nữa: còn dòng không đọc được → TỪ CHỐI (dòng lỗi bị loại
 *    khỏi cả Σ lẫn số giao dịch nên checksum có thể vẫn "khớp" mà file đã mất dòng).
 *  - CỔNG CHẶN liên-tục-số-dư (`timGaySoDuVi`): bắt file bị XUẤT THIẾU dòng do lọc "Loại
 *    giao dịch" — ca mà CẢ checksum lẫn khoá trùng đều mù, vì Shopee tính lại block "Tóm
 *    tắt" theo bộ lọc (đo trên cặp file thật 13/08). Guard tự rút lui kèm CẢNH BÁO khi
 *    thiếu dữ liệu kiểm (không có cột số dư / trạng thái lạ / file không theo thời gian).
 *  - Idempotent: land dedupe theo (shopId, externalId, payloadHash); import chồng OK.
 */

/** Đọc file từ form (chỉ 1 field `file`). */
async function readWalletFile(
  formData: FormData
): Promise<{ ok: true; buf: ArrayBuffer } | { ok: false; error: string }> {
  const file = formData.get("file");
  if (!(file instanceof Blob) || file.size === 0) {
    return { ok: false, error: "Chưa chọn file ví" };
  }
  return { ok: true, buf: await file.arrayBuffer() };
}

/** So Σ theo Dòng tiền (parser tính) với block "Tóm tắt". ok=false ⇒ chặn import. */
function verifyChecksum(
  summary: WalletSummary | null,
  computed: WalletSummary
): { ok: true } | { ok: false; detail: string } {
  if (!summary) {
    return { ok: false, detail: "Không đọc được block 'Tóm tắt' trong file để đối chiếu" };
  }
  const mism: string[] = [];
  if (summary.totalIn !== computed.totalIn)
    mism.push(`tiền vào: file ${summary.totalIn} ≠ tính được ${computed.totalIn}`);
  if (summary.totalOut !== computed.totalOut)
    mism.push(`tiền ra: file ${summary.totalOut} ≠ tính được ${computed.totalOut}`);
  if (summary.countIn !== computed.countIn)
    mism.push(`số gd vào: file ${summary.countIn} ≠ ${computed.countIn}`);
  if (summary.countOut !== computed.countOut)
    mism.push(`số gd ra: file ${summary.countOut} ≠ ${computed.countOut}`);
  return mism.length ? { ok: false, detail: mism.join("; ") } : { ok: true };
}

// KHÔNG export (file "use server" chỉ export async function) — modal tự khai shape.
type WalletPreview = {
  summary: WalletSummary | null;
  computed: WalletSummary;
  /**
   * Cờ TỔNG của cả 3 cổng chặn ở `importShopeeWallet` (dòng lỗi / checksum / trùng khoá), KHÔNG
   * riêng checksum. Giữ TÊN cũ vì modal tự khai shape — đổi tên phải sửa cả hai nơi.
   */
  checksumOk: boolean;
  /** Lý do bị chặn (theo đúng thứ tự cổng), `null` khi đi qua cả 3. */
  checksumDetail: string | null;
  rowCount: number;
  invalid: { line: number; reason: string }[];
  warnings: string[];
};

/** Parse AN TOÀN — `XLSX.read` THROW trên file .xlsx hỏng/cụt; bọc thành ActionResult (modal không treo). */
function safeParse(
  buf: ArrayBuffer
): { ok: true; parsed: ReturnType<typeof parseShopeeWalletFile> } | { ok: false; error: string } {
  try {
    return { ok: true, parsed: parseShopeeWalletFile(buf) };
  } catch {
    return { ok: false, error: "Không đọc được file ví — file .xlsx hỏng hoặc sai định dạng (cần Transaction Report từ Shopee)" };
  }
}

/** Mô tả nhóm dòng trùng khoá (Bronze/Silver sẽ gộp 1 ⇒ thiếu số). */
function duplicateKeyMessage(duplicateKeys: string[]): string {
  return (
    `${duplicateKeys.length} nhóm dòng TRÙNG khoá (cùng ngày-giờ | loại | mã đơn | số tiền) — không phân ` +
    `biệt được nên Silver sẽ gộp làm THIẾU số dù checksum khớp. Kiểm tra lại file. VD: ${duplicateKeys[0]}`
  );
}

/** Mô tả nhóm dòng KHÔNG đọc được (bị loại khỏi cả Σ lẫn số giao dịch ⇒ mất dòng chi tiết). */
function invalidRowMessage(errors: { line: number; reason: string }[]): string {
  return (
    `${errors.length} dòng KHÔNG đọc được — file bị sửa tay hoặc sai định dạng. Dòng lỗi bị loại khỏi ` +
    `cả tổng tiền lẫn số giao dịch nên có thể mất dòng chi tiết mà checksum vẫn "khớp". Sửa file rồi ` +
    `thử lại. VD dòng ${errors[0]?.line}: ${errors[0]?.reason}`
  );
}

/**
 * Preview: parse + soi ĐỦ 3 cổng chặn của `importShopeeWallet`, KHÔNG chạm DB. Modal
 * dùng để hiện tổng tiền vào/ra + lý do chặn + dòng lỗi trước khi bấm import. Dòng lỗi
 * và trùng khoá cũng coi là CHẶN (checksum "khớp" nhưng file mất dòng / Silver gộp thiếu).
 */
export async function previewShopeeWalletImport(formData: FormData): Promise<ActionResult<WalletPreview>> {
  await requireUser();

  const form = await readWalletFile(formData);
  if (!form.ok) return form;

  const p = safeParse(form.buf);
  if (!p.ok) return p;
  const { rows, errors, warnings, summary, computed, duplicateKeys, coCotSoDu } = p.parsed;

  const check = verifyChecksum(summary, computed);
  const dupBlocked = duplicateKeys.length > 0;
  const coDongLoi = errors.length > 0;
  const soDu = timGaySoDuVi(rows, coCotSoDu);
  if (soDu.boQuaViSao) {
    // Guard rút lui thì phải KÊU — mất lưới an toàn trong im lặng là chính ca nó sinh ra để bắt.
    warnings.push(`Không kiểm được tính đủ-dòng qua số dư ví: ${soDu.boQuaViSao}`);
  }
  return {
    ok: true,
    data: {
      summary,
      computed,
      // Cờ TỔNG của cả 4 cổng chặn ở `importShopeeWallet`, không chỉ riêng checksum — nút Import trên
      // modal khoá theo đúng cờ này nên nó phải phản ánh y hệt điều server sẽ làm.
      checksumOk: check.ok && !dupBlocked && !coDongLoi && soDu.gay.length === 0,
      checksumDetail: !check.ok
        ? check.detail
        : dupBlocked
          ? duplicateKeyMessage(duplicateKeys)
          : coDongLoi
            ? invalidRowMessage(errors)
            : soDu.gay.length > 0
              ? thongDiepGaySoDu(soDu.gay)
              : null,
      rowCount: rows.length,
      invalid: errors,
      warnings,
    },
  };
}

type WalletImportResult = {
  landed: number; // dòng Bronze MỚI (đã trừ trùng hash)
  transformed: number; // ShopeeSettlement upsert
  rowCount: number; // dòng hợp lệ trong file
  skipped: number; // record transform lỗi shape
  recovered: number; // dòng KẸT từ lượt hỏng trước được dựng lại trong lượt này (tự chữa)
  warnings: string[];
};

/**
 * Trong các khoá đã cho, khoá nào CHƯA có dòng Silver `ShopeeSettlement`.
 *
 * Dùng cho cả hai việc: tìm dòng KẸT từ lượt import hỏng trước (Bronze có mà Silver thiếu) để tự
 * chữa, và làm cổng đủ-dòng sau transform. Khác luồng orders (cột `silverOutcome` do CAS đóng dấu),
 * ví Shopee không có cột kết cục — hỏi thẳng Silver là đủ vì mỗi record land = đúng một dòng Silver,
 * không có kết cục "cố ý bỏ qua" nào hợp lệ.
 */
async function locKhoaChuaCoSilver(externalIds: string[]): Promise<string[]> {
  if (externalIds.length === 0) return [];
  const daCo = await prisma.shopeeSettlement.findMany({
    where: { externalId: { in: externalIds } },
    select: { externalId: true },
  });
  const co = new Set(daCo.map((r) => r.externalId));
  return externalIds.filter((id) => !co.has(id));
}

/**
 * Import: parse → 3 CỔNG CHẶN (dòng lỗi → checksum → trùng khoá) → land Bronze →
 * transform Silver. Còn dòng lỗi, lệch checksum, HOẶC trùng khoá → TỪ CHỐI (không
 * land nửa vời). Sau transform, dòng upsert lỗi (skipped>0) → cũng trả lỗi TO thay vì
 * báo thành công giả (số "Tiền đã về" sẽ thiếu ngầm).
 */
export async function importShopeeWallet(formData: FormData): Promise<ActionResult<WalletImportResult>> {
  await requireUser();
  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const form = await readWalletFile(formData);
  if (!form.ok) return form;

  const p = safeParse(form.buf);
  if (!p.ok) return p;
  const { rows, errors, warnings, summary, computed, duplicateKeys } = p.parsed;

  // CỔNG CHẶN 1: còn dòng không đọc được → TỪ CHỐI. Phần lớn ca này đã tự lệch checksum (dòng lỗi bị
  // loại khỏi cả Σ lẫn countIn/countOut), nhưng KHÔNG phải tất cả: dòng rác mà block "Tóm tắt" không
  // đếm thì checksum vẫn khớp và dòng đó mất im lặng. Nặng hơn: lỗi CẤU TRÚC (thiếu dòng tiêu đề,
  // thiếu cột) trả về 0 dòng + Σ = 0, gặp file có Tóm tắt toàn 0 là báo "import 0 dòng thành công".
  if (errors.length > 0) {
    return { ok: false, error: invalidRowMessage(errors), code: "PARSE_ERROR" };
  }

  // CỔNG CHẶN 2: Σ theo Dòng tiền phải khớp block Tóm tắt.
  const check = verifyChecksum(summary, computed);
  if (!check.ok) {
    return {
      ok: false,
      error: `Checksum không khớp — từ chối import để tránh thiếu/lệch số. Chi tiết: ${check.detail}`,
      code: "CHECKSUM_MISMATCH",
    };
  }

  // CỔNG CHẶN 3: trùng khoá tổng hợp → Bronze/Silver gộp 1 dòng ⇒ số sẽ thiếu dù checksum khớp.
  if (duplicateKeys.length > 0) {
    return { ok: false, error: duplicateKeyMessage(duplicateKeys), code: "DUPLICATE_KEY" };
  }

  // CỔNG CHẶN 4: chuỗi "Số dư Ví sau giao dịch" phải liền mạch. File xuất CÓ LỌC loại giao dịch
  // qua được cả 3 cổng trên (Shopee tính lại block "Tóm tắt" theo bộ lọc — đo trên cặp file thật
  // 13/08) nhưng số dư từng dòng thì Shopee KHÔNG tính lại ⇒ chỗ thiếu giao dịch để lại vết đứt
  // số học. Guard tự rút lui (không chặn) khi thiếu dữ liệu kiểm — nhưng phải kêu vào warnings.
  const soDu = timGaySoDuVi(rows, p.parsed.coCotSoDu);
  if (soDu.gay.length > 0) {
    return { ok: false, error: thongDiepGaySoDu(soDu.gay), code: "BALANCE_GAP" };
  }
  if (soDu.boQuaViSao) {
    warnings.push(`Không kiểm được tính đủ-dòng qua số dư ví: ${soDu.boQuaViSao}`);
  }

  if (rows.length === 0) {
    return { ok: true, data: { landed: 0, transformed: 0, rowCount: 0, skipped: 0, recovered: 0, warnings } };
  }

  try {
    const { shopee } = await layCauHinhShop();
    const landRes = await landRaw("shopee/wallet", shopee, JSON.stringify({ data: rows }));

    const tWarnings: string[] = [];
    // [RT-FM6] Transform dòng vừa land (O(trang)) + TỰ CHỮA dòng kẹt từ lượt hỏng trước — cùng
    // khuôn `seenIds` của luồng orders. Land commit Bronze RIÊNG rồi transform mới chạy, nên một
    // lượt chết/lỗi giữa hai bước để lại dòng Bronze CÓ mà Silver THIẾU; nhập lại đúng file đó thì
    // payload y hệt ⇒ `ON CONFLICT DO NOTHING` ⇒ `landedIds` RỖNG. Chỉ transform theo `landedIds`
    // là bỏ rơi dòng kẹt trong khi lượt nhập lại báo xanh "0 dòng mới" — đường cứu còn lại là một
    // lượt "Dựng lại từ kho thô" TOÀN BỘ (nút UI/script, kéo tồn kho lùi ảnh đêm nên phải vá tồn
    // sau đó) chỉ để vá vài dòng ví, mà chủ shop không có dấu hiệu nào để biết cần bấm nó.
    //
    // CHỈ soi phần "thấy mà không vừa land": dòng vừa land đằng nào cũng được transform ngay dưới,
    // soi cả chúng thì mọi lượt bình thường đều bị kể là "còn kẹt" — cảnh báo giả ở mọi lượt nhập.
    const landedSet = new Set(landRes.landedIds);
    const thayMaKhongLand = landRes.seenIds.filter((id) => !landedSet.has(id));
    const conKet = await locKhoaChuaCoSilver(thayMaKhongLand);
    if (conKet.length > 0) {
      tWarnings.push(
        `${conKet.length} dòng của file này còn kẹt từ lượt import hỏng trước — dựng lại trong lượt này`,
      );
    }
    const canTransform = [...new Set([...landRes.landedIds, ...conKet])];
    const stats = await transformFromRaw("shopee/wallet", tWarnings, { externalIds: canTransform });

    revalidatePath("/tai-chinh");

    // Dòng đã land NHƯNG upsert Silver lỗi (vd amount vượt INT Postgres, lỗi ghi tạm) →
    // skipped>0. Báo thành công lúc này = số "Tiền đã về" thiếu ÂM THẦM. Trả lỗi TO; dòng
    // vẫn ở Bronze, nhập lại chính file này là lượt tự chữa phía trên dựng nốt.
    if (stats.skipped > 0) {
      return {
        ok: false,
        error: `${stats.skipped} dòng KHÔNG lưu được vào Silver (lỗi ghi DB) — số "Tiền đã về" có thể thiếu. Nhập lại chính file này để dựng nốt phần thiếu. ${tWarnings[0] ?? ""}`.trim(),
        code: "PARTIAL_PERSIST",
      };
    }

    // CỔNG ĐỦ-DÒNG: mọi khoá của file (kể cả record không rút được khoá — `skippedNoId`) phải có
    // dòng Silver rồi mới được nói "xong". Lưới an toàn cho mọi đường rơi chưa lường: thiếu mà vẫn
    // `ok:true` chính là kiểu toast-xanh-giả cả bản vá này sinh ra để diệt.
    const thieuSauTransform = await locKhoaChuaCoSilver(landRes.seenIds);
    if (thieuSauTransform.length > 0 || landRes.skippedNoId > 0) {
      const soThieu = thieuSauTransform.length + landRes.skippedNoId;
      return {
        ok: false,
        error: `${soThieu} dòng của file CHƯA vào được Silver — số "Tiền đã về" đang thiếu. Nhập lại chính file này để dựng nốt; còn lỗi thì báo kiểm tra hệ thống. ${tWarnings[0] ?? ""}`.trim(),
        code: "PARTIAL_PERSIST",
      };
    }

    return {
      ok: true,
      data: {
        landed: landRes.landed,
        transformed: stats.shopeeUpserted,
        rowCount: rows.length,
        skipped: stats.skipped,
        recovered: conKet.length,
        warnings: [...warnings, ...tWarnings],
      },
    };
  } catch {
    return { ok: false, error: "Lỗi khi import file ví Shopee" };
  }
}
