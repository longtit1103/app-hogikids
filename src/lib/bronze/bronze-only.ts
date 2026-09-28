import { prisma } from "@/lib/prisma";

/**
 * Chế độ CHỈ-LAND: ingest chỉ ghi Bronze (RawPancake*), KHÔNG dựng Silver.
 *
 * Dùng khi định nghĩa Silver CHƯA được chốt: raw vẫn kéo về liên tục (không mất dữ liệu, quan sát
 * được đơn đổi phí theo thời gian), còn bảng nghiệp vụ đứng yên — không có số nửa vời lọt vào P&L.
 *
 * BẤT BIẾN: mặc định TẮT. Không set biến, hoặc set bất kỳ giá trị nào khác "true"/"1" ⇒ hành vi cũ
 * (land + transform). Chuỗi "false" là truthy trong JS nên phải so khớp tường minh, không ép boolean.
 *
 * PHẠM VI: chỉ chặn luồng Pancake raw (`/api/ingest/raw`). `/api/ingest/ads` VẪN ghi thẳng Expense —
 * ads không có bảng Bronze nên chặn là mất dữ liệu.
 */
export function isBronzeOnly(): boolean {
  const v = process.env.BRONZE_ONLY?.trim().toLowerCase();
  return v === "true" || v === "1";
}

const BACKLOG_KEY = "bronzeBacklogPending";

/**
 * Cờ BACKLOG — chống mất doanh thu ÂM THẦM khi tắt công tắc.
 *
 * Bronze dedupe theo hash: đơn đã land trong lúc chỉ-land, khi kéo lại sẽ TRÙNG HASH ⇒ không land
 * lại ⇒ `landedIds` rỗng ⇒ transform dựng 0 dòng. Đơn nào đã "yên vị" (không còn đổi status/phí)
 * sẽ KHÔNG BAO GIỜ tự lên Silver, mà SyncLog vẫn báo OK.
 *
 * ⇒ Mỗi lần land ở chế độ chỉ-land phải bật cờ này; ingest thường thấy cờ bật thì KÊU TO cho tới khi
 * `rebuildFromRaw()` chạy xong SẠCH và hạ được cờ (hạ CÓ ĐIỀU KIỆN — xem
 * `haCoBacklogNeuChuaBiBatLai`). Rebuild là BẮT BUỘC khi tắt công tắc, không phải tuỳ chọn.
 */
export async function markBronzeBacklog(): Promise<void> {
  await prisma.setting.upsert({
    where: { key: BACKLOG_KEY },
    create: { key: BACKLOG_KEY, value: "1" },
    update: { value: "1" },
  });
}

export async function hasBronzeBacklog(): Promise<boolean> {
  const row = await prisma.setting.findUnique({ where: { key: BACKLOG_KEY } });
  return row?.value === "1";
}

/**
 * Hạ cờ VÔ ĐIỀU KIỆN — chỉ còn là tiện ích DỌN TRẠNG THÁI cho test (`beforeEach`).
 *
 * ⚠️ ĐỪNG gọi từ `src/` hay `scripts/`: cả hai đường dựng lại (nút "Dựng lại từ kho thô" và
 * `scripts/rebuild-from-raw.ts`) nay hạ cờ qua `haCoBacklogNeuChuaBiBatLai`, vì lượt dựng lại chạy
 * hàng phút và webhook / `/api/ingest/raw` vẫn bật cờ được giữa chừng cho một dòng lượt đó chưa chữa.
 * Hạ vô điều kiện ở cuối lượt là xoá đúng cảnh báo vừa bật — xem lý do đầy đủ ở
 * `haCoBacklogNeuChuaBiBatLai`.
 */
export async function clearBronzeBacklog(): Promise<void> {
  await prisma.setting.upsert({
    where: { key: BACKLOG_KEY },
    create: { key: BACKLOG_KEY, value: "0" },
    update: { value: "0" },
  });
}

/**
 * Ảnh chụp cờ backlog tại MỘT thời điểm: giá trị + mốc sửa gần nhất của chính dòng đó.
 *
 * `moc` đóng vai SỐ PHIÊN BẢN của dòng cờ (giống `Order.rawFetchedAt` với đơn hàng), không phải
 * "bây giờ là mấy giờ" — xem `haCoBacklogNeuChuaBiBatLai`.
 */
export type AnhChupCoBacklog = { dangBat: boolean; moc: Date };

/** Chụp cờ backlog TRƯỚC khi một lượt dựng lại bắt đầu ghi. `null` = chưa từng có dòng cờ nào. */
export async function chupCoBacklog(): Promise<AnhChupCoBacklog | null> {
  const row = await prisma.setting.findUnique({ where: { key: BACKLOG_KEY } });
  return row ? { dangBat: row.value === "1", moc: row.updatedAt } : null;
}

/**
 * HẠ CỜ CÓ ĐIỀU KIỆN: chỉ hạ khi dòng cờ KHÔNG bị ai chạm kể từ ảnh chụp `anh`. Trả về `true` nếu
 * thực sự đã hạ.
 *
 * Vì sao cần: lượt dựng lại quét cả bảng nên chạy HÀNG PHÚT, mà trong quãng đó webhook Pancake và
 * `/api/ingest/raw` KHÔNG bị chặn — chúng vẫn bật cờ được vì một dòng VỪA tới không lên được Silver.
 * Hạ vô điều kiện ở cuối lượt là xoá đúng cái cảnh báo vừa bật cho một ca mà lượt này chưa hề chữa.
 *
 * Điều kiện phải nằm TRONG câu UPDATE (đọc-rồi-ghi ở 2 câu là mất tính nguyên tử: cờ bị bật đúng
 * giữa hai câu sẽ bị câu sau xoá). Cùng kỹ thuật đang dùng cho thứ tự ghi Silver (`Order.rawFetchedAt`).
 *
 * So BẰNG NHAU với mốc đã chụp, KHÔNG phải `"updatedAt" <= clock_timestamp() lúc bắt đầu`:
 *  - Mốc trên dòng cờ do trigger `setting_set_updated_at` ghi bằng `now()`, mà `now()` là mốc BẮT
 *    ĐẦU TRANSACTION. Một lượt ghi bật cờ mở transaction TRƯỚC lượt dựng lại rồi commit vào giữa
 *    lượt sẽ đóng dấu một mốc CŨ HƠN mốc bắt đầu ⇒ phép `<=` vẫn khớp và hạ cờ oan.
 *  - Nhánh INSERT (dòng cờ chưa tồn tại) không đi qua trigger: mốc do Prisma sinh bằng đồng hồ TIẾN
 *    TRÌNH APP, lệch với đồng hồ DB. Đo trên DB test 31/07: mốc INSERT sớm hơn `clock_timestamp()`
 *    ~300 ms. So `<=` với mốc lấy từ đồng hồ DB là so hai đồng hồ khác nhau.
 * So bằng nhau miễn nhiễm cả hai: bất kỳ lượt ghi nào vào dòng cờ cũng đổi mốc (đo được: upsert
 * `value="1"` lên dòng đang là `"1"` VẪN bump `updatedAt`), nên chỉ cần mốc khác ảnh chụp là không hạ.
 * Sai số duy nhất còn lại là 2 lượt ghi rơi đúng cùng một mili-giây (cột `timestamp(3)`), và nó
 * lệch về phía AN TOÀN trong mọi ca thực tế đã xét.
 *
 * `anh === null` (chưa có dòng cờ lúc bắt đầu) ⇒ KHÔNG hạ: lúc đó cờ đang tắt nên chẳng có gì để hạ,
 * còn nếu giữa chừng có ai tạo dòng cờ thì đó đúng là cảnh báo mới, không được đụng vào.
 */
export async function haCoBacklogNeuChuaBiBatLai(anh: AnhChupCoBacklog | null): Promise<boolean> {
  if (!anh?.dangBat) return false;
  const soDong = await prisma.$executeRaw`
    UPDATE "Setting" SET value = '0'
    WHERE key = ${BACKLOG_KEY} AND value = '1' AND "updatedAt" = ${anh.moc}
  `;
  return soDong > 0;
}
