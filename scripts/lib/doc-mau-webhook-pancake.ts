import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Đọc 2 KHO MẪU webhook Pancake có sẵn (chỉ đọc + chuẩn hoá về cùng một shape, KHÔNG ghi DB):
 *   1. Thư mục file mẫu pha 1 do n8n ghi ra (`webhook-samples/<shop>/<yyyyLLdd-HHmmss>-<id>.json`).
 *   2. Khối `COPY` bảng `webhook_raw_events` của hệ cũ, trích từ bản dump cluster 2026-06-18.
 *
 * Tách khỏi script nạp để phần phân tích định dạng (dễ sai, đáng test bằng mắt) không lẫn với
 * phần ghi DB.
 */

export type SuKienMau = {
  /** Slug shop: `kho` | `shopee` | `tiktok` — script gọi tự map sang shop id Pancake. */
  shopSlug: string;
  /** Payload NGUYÊN XI (file mẫu) hoặc text jsonb đã bỏ escape của COPY (bảng cũ). */
  payload: string;
  receivedAt: Date;
};

/**
 * Tên file n8n sinh: `20260726-161637-104574.json` — mốc giờ theo `$now` của n8n, tức GIỜ VN
 * (container đặt `TZ=Asia/Ho_Chi_Minh`). Neo `+07:00` tường minh để máy chạy script ở múi giờ
 * nào cũng ra cùng một mốc UTC (bất biến #3).
 */
export function mocGioTuTenFile(tenFile: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/.exec(tenFile);
  if (!m) return null;
  const [, nam, thang, ngay, gio, phut, giay] = m;
  return new Date(`${nam}-${thang}-${ngay}T${gio}:${phut}:${giay}+07:00`);
}

/** Đọc thư mục `webhook-samples/` (mỗi shop một thư mục con). */
export function docThuMucFileMau(goc: string): SuKienMau[] {
  const ket: SuKienMau[] = [];
  for (const shopSlug of readdirSync(goc, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)) {
    const thuMuc = path.join(goc, shopSlug);
    for (const tenFile of readdirSync(thuMuc).filter((f) => f.endsWith(".json")).sort()) {
      const receivedAt = mocGioTuTenFile(tenFile);
      if (!receivedAt) continue; // tên không theo khuôn n8n → bỏ qua, không đoán mốc giờ
      ket.push({
        shopSlug,
        payload: readFileSync(path.join(thuMuc, tenFile), "utf8"),
        receivedAt,
      });
    }
  }
  return ket;
}

/**
 * Bỏ escape của định dạng COPY text Postgres. Trong khối COPY, mỗi bản ghi là 1 dòng, các cột
 * ngăn bằng TAB, và ký tự đặc biệt được escape bằng backslash. Không bỏ escape thì mọi `\"`
 * trong JSON sẽ thành `\\"` → payload không parse được.
 */
export function boEscapeCopy(s: string): string {
  let ket = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "\\") {
      ket += s[i];
      continue;
    }
    const tiep = s[++i];
    if (tiep === undefined) break;
    const bang: Record<string, string> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
    ket += bang[tiep] ?? tiep; // `\\` → `\`, ký tự lạ giữ nguyên chính nó
  }
  return ket;
}

/**
 * Hệ cũ chỉ đăng ký 2 đường webhook, mỗi đường một shop bán (xác minh 2026-07-26 bằng bảng
 * `webhook_entity` + tên node n8n + warehouse_id trong chính payload). KHÔNG có shop Kho Tổng.
 */
const SHOP_THEO_URL_CU: Readonly<Record<string, string>> = {
  "pancake-pos-hogikids1": "shopee",
  "pancake-pos-hogikids2": "tiktok",
};

/**
 * `timestamptz` của Postgres xuất ra dạng `2026-06-13 07:30:08.051101+00` — Date của JS KHÔNG
 * hiểu (thiếu `T`, offset 2 ký tự, 6 chữ số phần giây). Chuẩn hoá về ISO: cắt còn mili giây và
 * bù `:00` cho offset, nếu không mọi mốc giờ sẽ thành Invalid Date.
 */
export function chuanHoaMocGioPostgres(s: string): string {
  return s
    .trim()
    .replace(" ", "T")
    .replace(/(\.\d{3})\d+/, "$1")
    .replace(/([+-]\d{2})$/, "$1:00");
}

/** Đọc khối `COPY public.webhook_raw_events (id, source_type, body, received_at, webhook_name)`. */
export function docKhoiCopyBangCu(duongDan: string): { suKien: SuKienMau[]; boQua: string[] } {
  const suKien: SuKienMau[] = [];
  const boQua: string[] = [];

  for (const dong of readFileSync(duongDan, "utf8").split("\n")) {
    if (!dong || dong.startsWith("COPY ") || dong === "\\.") continue;
    const cot = dong.split("\t");
    if (cot.length < 5) {
      boQua.push(`dòng thiếu cột: ${dong.slice(0, 60)}…`);
      continue;
    }
    const [, , body, receivedAtRaw, webhookName] = cot;
    const shopSlug = SHOP_THEO_URL_CU[webhookName.trim().replace(/^.*\//, "")];
    if (!shopSlug) {
      boQua.push(`không suy được shop từ URL: ${webhookName}`);
      continue;
    }
    const receivedAt = new Date(chuanHoaMocGioPostgres(receivedAtRaw));
    if (Number.isNaN(receivedAt.getTime())) {
      boQua.push(`mốc giờ hỏng: ${receivedAtRaw}`);
      continue;
    }
    suKien.push({ shopSlug, payload: boEscapeCopy(body), receivedAt });
  }
  return { suKien, boQua };
}
