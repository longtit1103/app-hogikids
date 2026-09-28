"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";

import type { ActionResult } from "@/lib/actions/action-result";
import { dangDungLaiTuKhoTho, dangPhucHoi, LOI_DANG_PHUC_HOI } from "@/lib/backup/khoa-bao-tri";
import { parseAdsFile, type AdsPreset, type ParsedAdsRow } from "@/lib/import/ads-csv";
import { giuKhoaGhiChiTieuAds } from "@/lib/ingest/khoa-ghi-chi-tieu-ads";
import { LoiFileQuaNhieuDong } from "@/lib/import/xlsx-shared";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

/**
 * Server actions cho luồng Import CSV ads (nút "Import CSV ads" ở `/chi-phi`).
 *
 * Đặt RIÊNG file này (không nhét vào `actions/expenses.ts` vốn đã 218 dòng —
 * vượt ngưỡng tách file 200 dòng của repo). `expense-form-modal`/CRUD giữ ở
 * `expenses.ts`; modal import gọi từ `@/lib/actions/ads-import`.
 *
 * Bất biến: dòng IMPORT neo `date` theo `T00:00:00+07:00` GIỐNG HỆT ingest
 * ADS_API (`api/ingest/ads/route.ts`) → 1 ngày file so khớp đúng 1 ngày API.
 */

const ADS_CATEGORY_ID = "ads";

/** "META" | "TIKTOK" (preset file) → giá trị `adsSource` lưu DB. */
function adsSourceForPreset(preset: AdsPreset): string {
  return preset === "META" ? "META" : "TIKTOK_ADS";
}

// Khoá ngày theo Asia/Ho_Chi_Minh — mọi Date ở đây đều neo 00:00:00+07 nên
// format theo TZ VN cho ra đúng "yyyy-MM-dd" của ngày đó, độc lập TZ máy chạy.
const VN_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Date (đã neo +07) → "yyyy-MM-dd" theo giờ VN. */
function vnDateKey(d: Date): string {
  return VN_DATE_FORMATTER.format(d); // en-CA → "2026-07-01"
}

/** Neo lại 1 khoá ngày "yyyy-MM-dd" thành Date 00:00:00 giờ VN (khớp ingest ADS_API). */
function anchorDate(dateKey: string): Date {
  return new Date(`${dateKey}T00:00:00+07:00`);
}

/** Biên PHẢI MỞ của một ngày VN = 00:00 giờ VN của ngày kế tiếp (VN không có DST nên +24h là đúng). */
function anchorNgaySau(dateKey: string): Date {
  return new Date(anchorDate(dateKey).getTime() + 24 * 60 * 60 * 1000);
}

/**
 * Thay cho ô `adsSource` BỎ TRỐNG của dòng đã có trong sổ.
 *
 * Có byte NUL nên không bao giờ đụng một giá trị thật: Postgres không lưu được byte NUL trong cột
 * text, mà `adsSource` cũng chỉ nhận "META"/"TIKTOK_ADS"/"SHOPEE_ADS".
 */
const O_TRONG = "\0(trống)";

/**
 * Khoá dedupe nội bộ / DB: ngày + tên chiến dịch + số tiền + nguồn ads.
 *
 * Ngăn cách bằng ký tự NUL viết dạng escape (KHÔNG viết byte NUL thô vào mã nguồn —
 * `rg`/`grep`/`file` coi file có byte NUL là nhị phân rồi bỏ qua khi tìm kiếm). Chọn NUL
 * vì tên chiến dịch có thể chứa mọi ký tự in được, kể cả dấu phân cách thông thường
 * (space, `|`, `-`) — dùng chúng thì hai dòng khác nhau có thể sinh cùng một khoá.
 *
 * `adsSource` PHẢI nằm trong khoá: cùng ngày + cùng tên chiến dịch + cùng số tiền vẫn có thể là
 * HAI khoản chi THẬT của hai nền tảng khác nhau (Meta và TikTok đặt trùng tên chiến dịch, cùng
 * ngân sách ngày là chuyện thường). Thiếu chiều này thì dòng cũ chặn nhầm dòng mới ⇒ bỏ sót chi
 * tiêu ads ⇒ lợi nhuận cao ảo.
 *
 * `channelId` thì TUYỆT ĐỐI KHÔNG được vào khoá, dù nghe có vẻ đối xứng: nó KHÔNG có trong file,
 * mà là nhãn quy kênh chủ shop tự chọn ở ô "Kênh" của modal. Đưa một nhãn tuỳ chọn vào khoá định
 * danh nghĩa là import LẠI ĐÚNG MỘT FILE mà bấm kênh khác sẽ không còn dòng nào bị coi là trùng —
 * chèn nguyên một bản sao, chi phí ads đếm 2 lần, lãi ròng thấp ảo, mà màn hình vẫn báo "bỏ qua 0
 * dòng trùng". Đo thật khi thử: giá trị bị gấp đôi. Chiều `adsSource` một mình đã đủ đóng
 * lỗi chặn-nhầm, và nó suy từ preset của FILE nên người dùng không đặt sai được.
 */
function dedupeKey(dateKey: string, campaignName: string, amount: number, adsSource: string): string {
  return `${dateKey}\0${campaignName}\0${amount}\0${adsSource}`;
}

/**
 * Dòng file đã có sẵn trong sổ (IMPORT|MANUAL) chưa?
 *
 * Ô `adsSource` BỎ TRỐNG của dòng cũ được coi là "khớp mọi nguồn" — form nhập tay chỉ BẮT BUỘC
 * chọn nguồn ads từ sau này, nên sổ đời cũ có thể còn dòng thiếu ô đó. So khớp cứng với dòng ấy
 * sẽ coi nó là "khác nguồn" rồi chèn thêm một dòng nữa ⇒ chi tiêu ads đếm 2 lần, đúng chiều ngược
 * của lỗi vừa vá — nên ở đây cố ý nghiêng về phía CHẶN.
 *
 * Đánh đổi đã biết: một dòng sổ cũ thiếu `adsSource` vẫn chặn được dòng file hợp lệ của nguồn
 * khác (chiều bỏ sót chi tiêu). Đo trên sổ prod 2026-08-10: 13.419/13.419 dòng ads đều có đủ
 * `adsSource`, nên nhánh này hiện không chạm dữ liệu thật; nếu về sau xuất hiện dòng null thì
 * chiều bỏ sót đó CHƯA được đóng.
 */
function daCoTrongSo(
  ledgerKeys: Set<string>,
  dateKey: string,
  campaignName: string,
  amount: number,
  adsSource: string
): boolean {
  return (
    ledgerKeys.has(dedupeKey(dateKey, campaignName, amount, adsSource)) ||
    ledgerKeys.has(dedupeKey(dateKey, campaignName, amount, O_TRONG))
  );
}

type ValidationOk = {
  ok: true;
  buf: ArrayBuffer;
  preset: AdsPreset;
  channelId: string;
  conflictMode: "skip" | "overwrite";
};

/** Đọc + kiểm form chung cho preview/import. Trả lỗi ActionResult nếu sai. */
async function readForm(formData: FormData): Promise<ValidationOk | { ok: false; error: string; field?: string }> {
  const file = formData.get("file");
  if (!(file instanceof Blob) || file.size === 0) {
    return { ok: false, error: "Chưa chọn file" };
  }

  const presetRaw = String(formData.get("preset") ?? "");
  if (presetRaw !== "META" && presetRaw !== "TIKTOK") {
    return { ok: false, error: "Nguồn ads không hợp lệ" };
  }

  const channelId = String(formData.get("channelId") ?? "").trim();
  if (!channelId) {
    return { ok: false, error: "Chọn kênh", field: "channelId" };
  }
  const channel = await prisma.channel.findUnique({ where: { id: channelId } });
  if (!channel) {
    return { ok: false, error: "Kênh không hợp lệ", field: "channelId" };
  }

  const conflictRaw = String(formData.get("conflictMode") ?? "skip");
  const conflictMode = conflictRaw === "overwrite" ? "overwrite" : "skip";

  const buf = await file.arrayBuffer();
  return { ok: true, buf, preset: presetRaw, channelId, conflictMode };
}

/**
 * Đọc file thành dòng chuẩn hoá, KHÔNG để lỗi đọc file ném ra ngoài server action.
 *
 * `parseAdsFile` gọi `XLSX.read`, và thư viện này THROW với file .xlsx hỏng/cắt cụt (chữ ký ZIP
 * đúng nhưng ruột hỏng). Ném ra khỏi server action thì client chỉ nhận một lỗi chung, không rơi
 * vào nhánh `!res.ok` ⇒ modal kẹt spinner "đang đọc file" vĩnh viễn, chủ shop không biết phải làm gì.
 */
function docFileAds(
  buf: ArrayBuffer,
  preset: AdsPreset
): { ok: true; rows: ParsedAdsRow[]; errors: { line: number; reason: string }[] } | { ok: false; error: string } {
  try {
    return { ok: true, ...parseAdsFile(buf, preset) };
  } catch (err) {
    // Vượt trần số dòng là ca KHÁC HẲN "file hỏng" — nói đúng lý do (xem `LoiFileQuaNhieuDong`).
    if (err instanceof LoiFileQuaNhieuDong) return { ok: false, error: err.message };
    return { ok: false, error: "Không đọc được file — file hỏng hoặc không phải CSV/XLSX xuất từ Ads Manager" };
  }
}

/**
 * Dedupe nội bộ file trên — giữ dòng đầu tiên. Dùng ĐÚNG khoá của bước dedupe DB (một định nghĩa
 * khoá duy nhất cho cả file); mọi dòng của một lượt import đều cùng nguồn ads nên chiều đó là
 * hằng số ở đây, truyền vào chỉ để không đẻ ra khoá thứ hai lệch định nghĩa.
 */
function dedupeInternal(rows: ParsedAdsRow[], adsSource: string): ParsedAdsRow[] {
  const seen = new Set<string>();
  const out: ParsedAdsRow[] = [];
  for (const r of rows) {
    const key = dedupeKey(vnDateKey(r.date), r.campaignName, r.amount, adsSource);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * Khoảng thời gian bao MỌI dòng file, dạng NỬA MỞ `[min, denHet)`: `min` = 00:00 giờ VN của ngày sớm
 * nhất, `denHet` = 00:00 giờ VN của ngày SAU ngày muộn nhất. null nếu không có dòng nào.
 *
 * Biên phải phải MỞ: mọi so sánh ngày trong file này dùng KHOÁ NGÀY VN, nên truy vấn phải phủ TRỌN
 * ngày cuối. Chốt `lte` ở mốc 00:00 của ngày cuối sẽ bỏ sót dòng mang giờ khác 00:00+07 trong đúng
 * ngày đó ⇒ ngày đó vừa không được báo xung đột, vừa không bị xoá khi ghi đè = chi phí đếm 2 lần.
 */
function dateBounds(rows: ParsedAdsRow[]): { min: Date; denHet: Date } | null {
  if (rows.length === 0) return null;
  let min = rows[0].date;
  let max = rows[0].date;
  for (const r of rows) {
    if (r.date < min) min = r.date;
    if (r.date > max) max = r.date;
  }
  return { min, denHet: anchorNgaySau(vnDateKey(max)) };
}

/**
 * Preview: parse + dedupe nội bộ, liệt kê dòng lỗi + các ngày đã có số ADS_API
 * cùng `adsSource` (để modal cảnh báo amber + cho chọn skip/overwrite).
 */
export async function previewAdsImport(formData: FormData): Promise<
  ActionResult<{
    rows: { date: string; campaignName: string; amount: number }[];
    invalid: { line: number; reason: string }[];
    apiConflicts: { date: string; adsSource: string; apiAmount: number }[];
  }>
> {
  await requireUser();

  const form = await readForm(formData);
  if (!form.ok) return form;

  const doc = docFileAds(form.buf, form.preset);
  if (!doc.ok) return { ok: false, error: doc.error };
  const { rows: parsed, errors } = doc;
  const adsSource = adsSourceForPreset(form.preset);
  const unique = dedupeInternal(parsed, adsSource);

  const apiConflicts = await findApiConflicts(unique, adsSource);

  return {
    ok: true,
    data: {
      rows: unique.map((r) => ({ date: vnDateKey(r.date), campaignName: r.campaignName, amount: r.amount })),
      invalid: errors,
      apiConflicts,
    },
  };
}

/**
 * Các ngày (trong tập dòng file) đã tồn tại dòng ADS_API cùng `adsSource`.
 * `apiAmount` = tổng chi tiêu API của ngày đó (nhiều campaign cộng lại).
 */
async function findApiConflicts(
  rows: ParsedAdsRow[],
  adsSource: string
): Promise<{ date: string; adsSource: string; apiAmount: number }[]> {
  const bounds = dateBounds(rows);
  if (!bounds) return [];

  const fileDays = new Set(rows.map((r) => vnDateKey(r.date)));
  const apiRows = await prisma.expense.findMany({
    where: {
      categoryId: ADS_CATEGORY_ID,
      source: "ADS_API",
      adsSource,
      date: { gte: bounds.min, lt: bounds.denHet },
    },
    select: { date: true, amount: true },
  });

  const byDay = new Map<string, number>();
  for (const e of apiRows) {
    const day = vnDateKey(e.date);
    if (!fileDays.has(day)) continue; // chỉ báo ngày thực sự trùng với file
    byDay.set(day, (byDay.get(day) ?? 0) + e.amount);
  }

  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, apiAmount]) => ({ date, adsSource, apiAmount }));
}

/**
 * Import ads → Expense. TẤT CẢ trong 1 `prisma.$transaction`, đúng thứ tự:
 *  1. parse (lỗi → skippedInvalid);
 *  2. dedupe nội bộ file (ngày+tên+tiền);
 *  3. dedupe DB: đã có Expense ads source IMPORT|MANUAL cùng ngày+mô tả+tiền+nguồn ads
 *     (ô nguồn bỏ trống của dòng cũ khớp mọi nguồn) → skippedDuplicates;
 *  4. xung đột API: ngày đã có ADS_API cùng adsSource — skip → bỏ dòng ngày đó;
 *     overwrite → xoá dòng ADS_API (ngày, adsSource) rồi ghi dòng file (đếm overwrittenApiRows);
 *  5. createMany phần còn lại (source=IMPORT, refId=null).
 * Chạy lại cùng file → imported=0 nhờ bước 3. Cuối `revalidatePath("/chi-phi")`.
 *
 * LOẠI TRỪ với đường ghi máy: transaction giữ `giuKhoaGhiChiTieuAds` NGAY TỪ ĐẦU — hai lượt import
 * cùng file, hoặc import chen vào giữa lượt `/api/ingest/ads` đêm, đều làm chi phí quảng cáo của
 * ngày đó đếm 2 lần (xem `khoa-ghi-chi-tieu-ads.ts`). Riêng lượt DỰNG LẠI TỪ KHO THÔ không nằm
 * trong transaction nào (nó ghi hàng chục nghìn dòng, giữ khoá suốt là khoá cả app hàng phút) nên
 * chặn theo cách khác: thấy lượt dựng lại đang chạy thì từ chối import.
 */
export async function importAdsExpenses(formData: FormData): Promise<
  ActionResult<{
    imported: number;
    skippedDuplicates: number;
    skippedInvalid: number;
    overwrittenApiRows: number;
  }>
> {
  await requireUser();

  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  const form = await readForm(formData);
  if (!form.ok) return form;

  if (dangDungLaiTuKhoTho()) {
    return {
      ok: false,
      error: "Đang dựng lại dữ liệu từ kho thô — chờ xong rồi import lại (tránh ghi đè lẫn nhau)",
    };
  }

  const doc = docFileAds(form.buf, form.preset);
  if (!doc.ok) return { ok: false, error: doc.error };
  const { rows: parsed, errors } = doc;
  const skippedInvalid = errors.length;
  const adsSource = adsSourceForPreset(form.preset);

  // Bước 2: dedupe nội bộ.
  const unique = dedupeInternal(parsed, adsSource);
  const bounds = dateBounds(unique);

  if (!bounds) {
    // Không có dòng hợp lệ nào — không cần vào transaction.
    return {
      ok: true,
      data: { imported: 0, skippedDuplicates: 0, skippedInvalid, overwrittenApiRows: 0 },
    };
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Khoá TRƯỚC mọi truy vấn đọc: cả bước 3 (dedupe) lẫn bước 4 (xung đột API) đều là
      // đọc-để-quyết-định — đọc ngoài khoá thì hai lượt ghi vẫn cùng thấy "chưa có gì".
      await giuKhoaGhiChiTieuAds(tx);

      // Bước 3: dedupe DB (IMPORT|MANUAL) trên ngày+mô tả+tiền+nguồn ads.
      //
      // Bộ lọc dưới đây là bản SQL của đúng luật khoá ở `daCoTrongSo`: chỉ dòng CÙNG nguồn ads —
      // hoặc BỎ TRỐNG ô đó — mới có cửa chặn dòng file. Dòng khác nguồn không bao giờ sinh ra khoá
      // khớp nên kéo về cũng vô nghĩa. KHÔNG lọc theo `channelId`: kênh không thuộc định danh dòng
      // (xem `dedupeKey`), lọc theo nó sẽ giấu mất chính dòng trùng cần chặn khi chủ shop bấm nhầm
      // kênh ở lần import sau. Bước 4 (xung đột ADS_API) cũng chỉ làm theo `adsSource` — hai bước
      // dùng CÙNG một luật định danh, không lệch nhau.
      const existingLedger = await tx.expense.findMany({
        where: {
          categoryId: ADS_CATEGORY_ID,
          source: { in: ["IMPORT", "MANUAL"] },
          date: { gte: bounds.min, lt: bounds.denHet },
          OR: [{ adsSource }, { adsSource: null }],
        },
        select: { date: true, description: true, amount: true, adsSource: true },
      });
      const ledgerKeys = new Set(
        existingLedger.map((e) =>
          dedupeKey(vnDateKey(e.date), e.description, e.amount, e.adsSource ?? O_TRONG)
        )
      );

      let skippedDuplicates = 0;
      const afterDbDedupe: ParsedAdsRow[] = [];
      for (const r of unique) {
        if (daCoTrongSo(ledgerKeys, vnDateKey(r.date), r.campaignName, r.amount, adsSource)) {
          skippedDuplicates++;
          continue;
        }
        afterDbDedupe.push(r);
      }

      // Bước 4: xung đột API — những ngày đã có dòng ADS_API cùng adsSource.
      const apiRows = await tx.expense.findMany({
        where: {
          categoryId: ADS_CATEGORY_ID,
          source: "ADS_API",
          adsSource,
          date: { gte: bounds.min, lt: bounds.denHet },
        },
        select: { date: true },
      });
      const apiDays = new Set(apiRows.map((e) => vnDateKey(e.date)));

      // Dòng ADS_API mang giờ khác 00:00+07 chỉ có thể đến từ ngoài app (UI neo 00:00+07 và chặn
      // sửa/xoá dòng ADS_API) hoặc từ một hợp đồng ingest đời cũ. Cửa sổ quét theo KHOẢNG NGÀY nay
      // tóm được chúng và ghi đè sẽ xoá đúng — nhưng phải kêu lên, vì nó báo có đường ghi thẳng vào
      // sổ chi phí mà app không biết.
      const lechMoc = apiRows.filter((e) => e.date.getTime() !== anchorDate(vnDateKey(e.date)).getTime());
      if (lechMoc.length > 0) {
        console.warn(
          `[import ads] ${lechMoc.length} dòng ADS_API mang giờ khác 00:00+07 trong khoảng ngày của file ` +
            `(${[...new Set(lechMoc.map((e) => vnDateKey(e.date)))].join(", ")}) — dữ liệu này được ghi ` +
            `từ ngoài app, kiểm lại nguồn`
        );
      }

      // Ngày ghi đè = ngày file (đã dedupe NỘI BỘ) trùng ngày đã có ADS_API —
      // tính ĐỘC LẬP với dedupe DB (bước 3). Nếu chỉ lấy từ afterDbDedupe thì 1
      // ngày vừa có sẵn dòng IMPORT/MANUAL (khiến dòng file bị loại ở bước 3)
      // VỪA có dòng ADS_API sẽ không bao giờ bị xoá → ngày đó bị đếm 2 lần
      // (IMPORT + ADS_API) mà action vẫn báo overwrittenApiRows=0.
      const fileDays = new Set(unique.map((r) => vnDateKey(r.date)));
      const overwriteDayKeys = new Set<string>();
      for (const day of apiDays) {
        if (fileDays.has(day)) overwriteDayKeys.add(day);
      }

      let overwrittenApiRows = 0;
      const toInsert: ParsedAdsRow[] = [];

      for (const r of afterDbDedupe) {
        const day = vnDateKey(r.date);
        // skip: bỏ dòng file thuộc ngày đã có số API. overwrite: vẫn chèn (dòng
        // ADS_API của ngày đó bị xoá ngay dưới đây, độc lập với vòng lặp này).
        if (apiDays.has(day) && form.conflictMode === "skip") {
          continue;
        }
        toInsert.push(r);
      }

      // Xoá dòng ADS_API của các ngày ghi đè (chỉ đúng adsSource) rồi mới chèn dòng file.
      if (form.conflictMode === "overwrite" && overwriteDayKeys.size > 0) {
        const deleted = await tx.expense.deleteMany({
          where: {
            categoryId: ADS_CATEGORY_ID,
            source: "ADS_API",
            adsSource,
            // Xoá theo KHOẢNG NGÀY VN, khớp đúng cách phát hiện xung đột (`apiDays` so bằng khoá
            // ngày). Xoá bằng `date: { in: … }` mốc 00:00+07 sẽ để lại dòng ADS_API mang giờ khác
            // trong đúng ngày vừa ghi đè ⇒ ngày đó có cả IMPORT lẫn ADS_API, `overwrittenApiRows`
            // báo 0, chi phí quảng cáo đếm 2 lần mà sổ trông vẫn hợp lệ.
            OR: [...overwriteDayKeys].map((d) => ({
              date: { gte: anchorDate(d), lt: anchorNgaySau(d) },
            })),
          },
        });
        overwrittenApiRows = deleted.count;
      }

      // Bước 5: chèn phần còn lại.
      if (toInsert.length > 0) {
        await tx.expense.createMany({
          data: toInsert.map((r) => ({
            date: r.date,
            categoryId: ADS_CATEGORY_ID,
            adsSource,
            description: r.campaignName,
            channelId: form.channelId,
            amount: r.amount,
            source: "IMPORT" as const,
            refId: null,
          })),
        });
      }

      return { imported: toInsert.length, skippedDuplicates, overwrittenApiRows };
    },
    // Từ khi transaction phải GIÀNH KHOÁ ở lệnh đầu, thời gian NẰM CHỜ tính vào hạn transaction.
    // Bên kia khoá là `/api/ingest/ads` — nó cố ý chạy tới 60s cho lô lớn. Giữ mặc định 5s ở đây
    // nghĩa là: lượt import trùng giờ lượt ingest đêm sẽ chết vì P2028 dù chẳng có gì sai.
    { timeout: 60_000, maxWait: 10_000 },
    );

    revalidatePath("/chi-phi");
    return { ok: true, data: { ...result, skippedInvalid } };
  } catch (err) {
    // P2028 = hết hạn transaction; ở đây gần như luôn là "đang chờ khoá của lượt ghi ads khác".
    // Nói rõ để chủ shop CHỜ chứ không đi sửa file (file vừa qua bước xem trước thì không sai).
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2028") {
      return { ok: false, error: "Đang có lượt ghi chi tiêu quảng cáo khác chạy — chờ ít phút rồi import lại" };
    }
    return { ok: false, error: "Lỗi khi import chi phí ads" };
  }
}
