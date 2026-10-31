import { createHash, randomBytes } from "node:crypto";

import type { Prisma } from "@/generated/prisma/client";

/**
 * Đường dẫn (path) 3 webhook Pancake → n8n là DỮ LIỆU THEO INSTANCE, sống trong bảng `Setting`
 * (`n8nWebhookPath.kho|shopee|tiktok`) — KHÔNG nằm trong cây repo.
 *
 * Vì sao: 3 webhook này KHÔNG có xác thực, path là thứ duy nhất làm URL khó đoán. Path nằm trong
 * `n8n/pancake-webhook-*.json` nghĩa là ai đọc được repo (bản public, bản sao lưu, lịch sử git) đều
 * bơm được sự kiện `orders` giả — mà sự kiện đó đi thẳng Bronze → Silver → doanh thu/P&L. File JSON
 * trong repo nay chỉ mang PLACEHOLDER; lúc đóng gói workflow gửi n8n, placeholder được thay bằng
 * giá trị trong `Setting` của chính instance đó.
 *
 * Module này KHÔNG import Prisma client lúc chạy: hàm đụng DB nhận `db` từ người gọi (prisma hoặc
 * transaction client) để phần thuần (placeholder, kiểm hợp lệ, sinh path) dùng được ở nơi không có DB.
 */

export const VAI_WEBHOOK_PANCAKE = ["kho", "shopee", "tiktok"] as const;
export type VaiWebhookPancake = (typeof VAI_WEBHOOK_PANCAKE)[number];
export type DuongDanWebhookPancake = Record<VaiWebhookPancake, string>;

/** Khoá `Setting` giữ path thật của từng shop. */
export const KHOA_SETTING_DUONG_DAN_WEBHOOK: Readonly<Record<VaiWebhookPancake, string>> = {
  kho: "n8nWebhookPath.kho",
  shopee: "n8nWebhookPath.shopee",
  tiktok: "n8nWebhookPath.tiktok",
};

/** Tiền tố chung của placeholder — body đã đóng gói mà còn chuỗi này là đóng gói hỏng. */
export const TIEN_TO_PLACEHOLDER_DUONG_DAN = "__DUONG_DAN_WEBHOOK_";

/** Placeholder trong `n8n/pancake-webhook-<vai>.json` — RIÊNG từng shop để không gán nhầm path. */
export const PLACEHOLDER_DUONG_DAN_WEBHOOK: Readonly<Record<VaiWebhookPancake, string>> = {
  kho: "__DUONG_DAN_WEBHOOK_KHO__",
  shopee: "__DUONG_DAN_WEBHOOK_SHOPEE__",
  tiktok: "__DUONG_DAN_WEBHOOK_TIKTOK__",
};

/** Placeholder → vai; `null` nếu chuỗi không phải placeholder (vd path `hogikids-sync-now`). */
export function vaiTheoPlaceholder(path: string): VaiWebhookPancake | null {
  for (const vai of VAI_WEBHOOK_PANCAKE) {
    if (PLACEHOLDER_DUONG_DAN_WEBHOOK[vai] === path) return vai;
  }
  return null;
}

/**
 * Path hợp lệ để ghép vào URL `/webhook/<path>`: một đoạn URL duy nhất (không `/`, không khoảng
 * trắng), đủ dài để khó đoán, và KHÔNG phải placeholder (ký tự đầu là chữ/số nên `__…` bị loại).
 * Không ép đúng 32 hex: bản clone có thể đang chạy path khác do người dựng tự đặt — `sinhDuongDanWebhookMoi`
 * mới là nơi chốt dạng 32 hex.
 */
const DUONG_DAN_HOP_LE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;

export function laDuongDanWebhookHopLe(path: string | null | undefined): path is string {
  return typeof path === "string" && DUONG_DAN_HOP_LE.test(path) && !path.includes(TIEN_TO_PLACEHOLDER_DUONG_DAN);
}

/** Path ngẫu nhiên mới: 16 byte CSPRNG = 32 ký tự hex thường (128 bit, không đoán được). */
export function sinhDuongDanWebhookMoi(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Hiện path cho người vận hành mà KHÔNG lộ trọn chuỗi (log script/terminal hay bị chép vào báo cáo):
 * chỉ đuôi 4 ký tự — cùng quy ước che khoá ở khối Khóa kết nối.
 */
export function cheDuongDan(path: string): string {
  return `…${path.slice(-4)} (${path.length} ký tự)`;
}

/**
 * Vân tay sha256 (hex) của path — dạng mà cổng publish public (`VAN_TAY_PATH_WEBHOOK` trong
 * `scripts/publish-public-snapshot.sh`) dùng để chặn path thật lọt ra. Path ngẫu nhiên 128 bit nên vân
 * tay không lộ path; in ra terminal được, còn path thì không.
 */
export function vanTayDuongDan(path: string): string {
  return createHash("sha256").update(path, "utf8").digest("hex");
}

/**
 * Thiếu path (hoặc giá trị hỏng) ⇒ KHÔNG được đóng gói/hiển thị — thông điệp chỉ đường sửa.
 * Cố ý KHÔNG gợi ý sinh path ngẫu nhiên: thông điệp này hiện ở UI của bản ĐANG CHẠY, nơi sinh path mới
 * là đổi path dưới chân Pancake (Pancake vẫn bắn path cũ ⇒ 404, realtime chết mà không log nào đỏ).
 */
export class ThieuDuongDanWebhook extends Error {
  constructor(public readonly vai: VaiWebhookPancake[]) {
    super(
      `Chưa có đường dẫn webhook Pancake hợp lệ trong Setting (${vai.map((v) => KHOA_SETTING_DUONG_DAN_WEBHOOK[v]).join(", ")}). ` +
        "Nạp ĐÚNG path n8n đang chạy bằng `scripts/nap-duong-dan-webhook-n8n.ts` (lượt thử rồi --apply). " +
        "Script bỏ một shop (workflow tắt, trùng tên, n8n API key hết hạn) ⇒ sửa phía n8n rồi nạp lại — " +
        "KHÔNG sinh path mới cho bản đang chạy: Pancake vẫn bắn vào path cũ."
    );
  }
}

/**
 * Trạng thái workflow `pancake-webhook-<vai>` trên n8n, theo góc nhìn "Pancake có đang bắn vào nó không":
 *   `dang-chay`  đúng 1 workflow tên đó, ĐANG BẬT, mang path hợp lệ
 *   `khong-co`   n8n không có workflow nào tên đó
 *   `tat`        có đúng 1, đang TẮT
 *   `khong-ro`   trùng tên / không đọc được / path không hợp lệ — không chứng minh được gì
 */
export type TrangThaiWebhookTrenN8n = "dang-chay" | "khong-co" | "tat" | "khong-ro";

export type BangChungN8nChoSinhPath =
  | { docDuoc: true; trangThai: Readonly<Record<VaiWebhookPancake, TrangThaiWebhookTrenN8n>> }
  | { docDuoc: false; loi: string };

/**
 * Cổng của `--nguon=ngau-nhien` (sinh path mới cho khoá trống — CHỈ dành cho bản clone mới). Trả danh
 * sách lý do TỪ CHỐI; rỗng = cho phép. Fail-closed: không chứng minh được "n8n chưa có webhook nào đang
 * chạy và Setting chưa có path" thì từ chối — người vận hành chỉ vượt bằng cờ xác nhận tường minh.
 */
export function lyDoTuChoiSinhPathNgauNhien(dk: {
  settingDaCo: readonly VaiWebhookPancake[];
  n8n: BangChungN8nChoSinhPath;
}): string[] {
  const lyDo: string[] = [];
  if (dk.settingDaCo.length > 0) {
    lyDo.push(`Setting đã có path cho ${dk.settingDaCo.join(", ")} — đây không phải bản clone mới.`);
  }
  if (!dk.n8n.docDuoc) {
    lyDo.push(`Không đọc được workflow trên n8n (${dk.n8n.loi}) — không chứng minh được n8n chưa có webhook đang chạy.`);
  } else {
    for (const vai of VAI_WEBHOOK_PANCAKE) {
      const tt = dk.n8n.trangThai[vai];
      if (tt === "dang-chay") lyDo.push(`n8n có workflow pancake-webhook-${vai} ĐANG BẬT với path hợp lệ — Pancake có thể đang bắn vào đó.`);
      else if (tt === "khong-ro") lyDo.push(`Không xác định được workflow pancake-webhook-${vai} trên n8n (trùng tên / path hỏng).`);
    }
  }
  return lyDo;
}

type DbSetting = Pick<Prisma.TransactionClient, "setting">;

export type KetQuaDocDuongDan =
  | { ok: true; duongDan: DuongDanWebhookPancake }
  | { ok: false; duongDan: Partial<DuongDanWebhookPancake>; thieu: VaiWebhookPancake[] };

/** Đọc 3 path từ `Setting`. Giá trị có mà không hợp lệ tính là THIẾU (không đoán, không sửa hộ). */
export async function docDuongDanWebhookPancake(db: DbSetting): Promise<KetQuaDocDuongDan> {
  const rows = await db.setting.findMany({
    where: { key: { in: VAI_WEBHOOK_PANCAKE.map((v) => KHOA_SETTING_DUONG_DAN_WEBHOOK[v]) } },
  });
  const theoKhoa = new Map(rows.map((r) => [r.key, r.value.trim()]));
  const duongDan: Partial<DuongDanWebhookPancake> = {};
  const thieu: VaiWebhookPancake[] = [];
  for (const vai of VAI_WEBHOOK_PANCAKE) {
    const p = theoKhoa.get(KHOA_SETTING_DUONG_DAN_WEBHOOK[vai]);
    if (laDuongDanWebhookHopLe(p)) duongDan[vai] = p;
    else thieu.push(vai);
  }
  if (thieu.length > 0) return { ok: false, duongDan, thieu };
  return { ok: true, duongDan: duongDan as DuongDanWebhookPancake };
}

/** Như trên nhưng ném `ThieuDuongDanWebhook` — cho đường ghi (provisioning) phải dừng hẳn. */
export async function docDuongDanWebhookBatBuoc(db: DbSetting): Promise<DuongDanWebhookPancake> {
  const kq = await docDuongDanWebhookPancake(db);
  if (!kq.ok) throw new ThieuDuongDanWebhook(kq.thieu);
  return kq.duongDan;
}

export type KetQuaNapMotVai = {
  vai: VaiWebhookPancake;
  /** `da-ghi`: Setting đang trống, vừa ghi · `khop`: đã có đúng giá trị · `lech`: đã có giá trị KHÁC, KHÔNG ghi đè. */
  ketQua: "da-ghi" | "khop" | "lech";
};

/**
 * Nạp path cho các vai CÒN TRỐNG — idempotent, KHÔNG BAO GIỜ ghi đè giá trị đã có (đè path đang
 * chạy bằng giá trị khác là lượt "Cài workflows" kế tiếp đăng ký path mới ⇒ Pancake bắn vào 404).
 * Đổi path có chủ đích đi qua `xoayDuongDanWebhookPancake`.
 */
export async function napDuongDanNeuThieu(
  db: DbSetting,
  duongDan: Partial<DuongDanWebhookPancake>
): Promise<KetQuaNapMotVai[]> {
  const ketQua: KetQuaNapMotVai[] = [];
  for (const vai of VAI_WEBHOOK_PANCAKE) {
    const moi = duongDan[vai];
    if (moi === undefined) continue;
    if (!laDuongDanWebhookHopLe(moi)) {
      throw new Error(`Đường dẫn webhook "${vai}" không hợp lệ (cần 16–128 ký tự chữ/số/-/_, không phải placeholder).`);
    }
    const key = KHOA_SETTING_DUONG_DAN_WEBHOOK[vai];
    const cu = await db.setting.findUnique({ where: { key } });
    if (cu) {
      ketQua.push({ vai, ketQua: cu.value.trim() === moi ? "khop" : "lech" });
      continue;
    }
    // `update: {}` = tạo-nếu-chưa-có: lượt chạy chồng đã ghi trước thì giữ giá trị của nó, đọc lại để báo đúng.
    const sau = await db.setting.upsert({ where: { key }, create: { key, value: moi }, update: {} });
    ketQua.push({ vai, ketQua: sau.value.trim() === moi ? "da-ghi" : "lech" });
  }
  return ketQua;
}

/**
 * XOAY path: sinh path ngẫu nhiên MỚI cho các vai chỉ định và GHI ĐÈ vào `Setting`. Chỉ đổi dữ liệu —
 * KHÔNG gọi n8n. Path mới chỉ có hiệu lực sau lượt "Cài / cập nhật workflows" (PUT node webhook +
 * deactivate→activate); đúng lúc đó path CŨ ngừng nhận ⇒ trình tự an toàn (giữ path cũ chạy song
 * song tới khi Pancake đã trỏ path mới) nằm ở checklist xoay path trong `n8n/huong-dan-cai-dat-workflows.md`.
 */
export async function xoayDuongDanWebhookPancake(
  db: DbSetting,
  vaiCanXoay: readonly VaiWebhookPancake[] = VAI_WEBHOOK_PANCAKE
): Promise<Partial<DuongDanWebhookPancake>> {
  const moi: Partial<DuongDanWebhookPancake> = {};
  const daSinh = new Set<string>();
  for (const vai of new Set(vaiCanXoay)) {
    let p = sinhDuongDanWebhookMoi();
    while (daSinh.has(p)) p = sinhDuongDanWebhookMoi(); // 2^-128 — vẫn chặn cho chắc 3 shop không chung hộp thư
    daSinh.add(p);
    const key = KHOA_SETTING_DUONG_DAN_WEBHOOK[vai];
    await db.setting.upsert({ where: { key }, create: { key, value: p }, update: { value: p } });
    moi[vai] = p;
  }
  return moi;
}

/** Rút path của node webhook (đầu tiên) trong danh sách node n8n — dùng cho script nạp path từ n8n. */
export function rutDuongDanWebhookTuNodes(nodes: unknown): string | null {
  if (!Array.isArray(nodes)) return null;
  for (const n of nodes as Array<{ type?: unknown; parameters?: { path?: unknown } }>) {
    if (n?.type === "n8n-nodes-base.webhook" && typeof n.parameters?.path === "string" && n.parameters.path) {
      return n.parameters.path;
    }
  }
  return null;
}
