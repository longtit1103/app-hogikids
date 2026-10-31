import { randomBytes } from "node:crypto";
import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import { format } from "date-fns";

import { chayMienCong, choDrain, docBoDem, laLoiCongGhiDangKhoa } from "@/lib/backup/cong-ghi-toan-cuc";
import { chuanBiThuMucRiengTu, ghiFileRiengTu } from "@/lib/backup/ghi-file-rieng-tu";
import {
  dangPhucHoi,
  giaHanKhoaPhucHoi,
  laChuKhoaPhucHoi,
  LoiMatKhoaPhucHoi,
  type ThePhienPhucHoi,
  thuGiuKhoaPhucHoi,
  traKhoaPhucHoi,
} from "@/lib/backup/khoa-bao-tri";
import {
  giuDocQuyenRestore,
  type KhoaDocQuyenRestore,
  type PhienGiuKhoa,
  TIEN_TO_APP_RESTORE,
} from "@/lib/backup/khoa-chung-cli";
import {
  giaHanKhoa,
  giuKhoaViecNang,
  MatKhoaViecNang,
  type TheKhoa,
  traKhoaViecNang,
} from "@/lib/backup/khoa-viec-nang";
import { LoiBackupTruocPhanQuyen } from "@/lib/backup/kiem-migration-trong-dump";
import { runPgDump } from "@/lib/backup/run-pg-dump";
import {
  assertNotArchive,
  detectRestoreFormat,
  gunzipHead,
  kiemDumCoM1,
  runRestore,
} from "@/lib/backup/run-restore";
import { thuHoiMoiPhienCoHan } from "@/lib/backup/thu-hoi-phien-co-han";
import { chanRequestKhacOrigin } from "@/lib/chan-request-khac-origin";
import { coLuotDangChay } from "@/lib/ingest/sync-log";
import { ghiNhatKy, ghiNhatKyLoi, type ActorNhatKy } from "@/lib/nhat-ky/ghi-nhat-ky";
import { HANH_DONG } from "@/lib/nhat-ky/hanh-dong";
import { prisma } from "@/lib/prisma";
import { congChuShopRoute } from "@/lib/quyen/cong-route";
import { cauHinhClientKhoa } from "@/lib/tao-prisma-client";

const KEEP_PRE_RESTORE = 3;

/**
 * Thư mục bản lùi `pre-restore-*.dump`. Container mount `/backups`; `BACKUP_DIR` chỉ để test/dev
 * trỏ sang thư mục tạm (cùng biến với lượt ghi giá vốn). Đọc lúc GỌI, không lúc nạp module — thứ tự
 * import ESM quyết định giá trị đọc lúc nạp, khó thấy và chỉ vỡ trong test.
 */
function thuMucBackup(): string {
  return process.env.BACKUP_DIR ?? "/backups";
}

/**
 * Câu cảnh báo cho ca "nạp xong rồi mới phát hiện mất khoá". Dùng chung 3 nhánh (mất trước khi thu
 * hồi phiên, mất sau khi thu hồi xong, mất khi thu hồi lỗi) — cùng một sự thật với người đọc: dữ
 * liệu đã bị thay, có thể có lượt khác chồng lên, và mốc phiên không đáng tin.
 */
const CANH_BAO_MAT_KHOA_SAU_NAP =
  "Đã nạp xong nhưng lượt phục hồi này chạy quá lâu nên khoá bảo trì đã tự nhả giữa chừng: " +
  "một lượt phục hồi khác có thể đã chạy chồng lên, và mốc thu hồi phiên CHƯA chắc được đẩy " +
  "(thiết bị khác có thể còn đăng nhập). Kiểm lại dữ liệu, khởi động lại container app rồi " +
  "đổi mật khẩu ngay.";

// Trần kích thước file upload phục hồi — chặn OOM từ phía nhận file
// (`bodySizeLimit` next.config chỉ áp cho Server Action, KHÔNG áp Route Handler).
// Backup .sql.gz/.dump thật hiện < vài MB; backup > 200MB thì nới có chủ đích
// (lưu ý Cloudflare tunnel cap ~100MB/request đứng trước).
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200MB

/**
 * Trần cho TOÀN BỘ thân request (phong bì multipart), kiểm trên `Content-Length` TRƯỚC `formData()`.
 *
 * Vì sao cần dù đã có `MAX_UPLOAD_BYTES`: cap kia đọc `file.size`, tức chỉ có số ĐO ĐƯỢC **sau khi**
 * `request.formData()` đã phân tích trọn thân request — mà đó chính là bước tốn RAM/đĩa. Cap sau
 * chặn được việc bung bytes vào RAM ở `arrayBuffer()`, KHÔNG chặn được việc nhận và parse phong bì.
 *
 * Cộng thêm 1MB cho phần khung multipart (boundary + header từng part): phong bì luôn LỚN HƠN file,
 * nên nếu kẹp đúng 200MB thì một file đúng 200MB hợp lệ sẽ bị từ chối oan.
 *
 * ⚠️ `Content-Length` có thể VẮNG (chunked) hoặc bịa — nên đây là lớp THỨ NHẤT, không thay thế
 * `MAX_UPLOAD_BYTES`. Thiếu header thì đi tiếp và để cap kia gác.
 */
const MAX_UPLOAD_ENVELOPE_BYTES = MAX_UPLOAD_BYTES + 1024 * 1024;

/**
 * Tên lượt phục hồi trong khoá việc nặng — hiện nguyên văn trong câu 409 của lượt xoá dữ liệu /
 * dựng lại / script khi chúng bị một lượt phục hồi đang chạy chặn lại.
 */
const VIEC_PHUC_HOI = "phục hồi dữ liệu từ bản sao lưu";

/**
 * POST /api/restore — phục hồi DB từ file backup tải lên (multipart).
 *
 * TÍNH NĂNG NGUY HIỂM NHẤT app: sai thứ tự = DROP schema rồi mới fail nạp → xoá
 * đúng DB đang cần cứu. THỨ TỰ GUARD LÀ SỐNG-CÒN (C1):
 *   401 (không phiên) / 403 (không phải chủ shop) → cap size 200MB (413, chưa đọc bytes) → detect (chưa đụng
 *   DB) → (plain-gzip) gunzip HEAD bounded + assertNotArchive (chặn .tar.gz
 *   toàn-server TRƯỚC mọi DROP) → guard schema (400) rồi cổng "dump đời trước phân quyền" (422), cả hai
 *   chỉ đọc file → LEASE VIỆC NẶNG (409 kèm tên việc nếu một writer chạy dài còn sống thật) →
 *   KHOÁ GHI CHUNG X (409 kèm phiên CLI đang giữ) → CỜ BẢO TRÌ (409 nếu lượt khác đang chạy) →
 *   DRAIN cổng ghi (chờ request/action/op lẻ đã vào trước cờ chạy trọn; quá hạn 409) → cổng
 *   SyncLog (409) → fencing → pre-restore backup (không có bản lùi thì KHÔNG restore) → fencing
 *   (+ X còn giữ + lease) → runRestore (chốt cuối trước phá huỷ) → fencing → thu hồi phiên →
 *   `finally`: trả cờ → nhả X → trả lease.
 *
 * Mọi lối dừng TRƯỚC lệnh phá huỷ đầu tiên trả 409 "chưa thay đổi gì" (riêng pre-backup hỏng: 500
 * "đã hủy phục hồi"). Từ lúc giữ cờ, câu ghi của chính lượt phục hồi đi LỐI MIỄN cổng ghi.
 *
 * KHOÁ BẢO TRÌ giữ suốt drain → phục hồi xong (xem `khoa-bao-tri.ts`): hai lượt
 * phục hồi chồng nhau sẽ xen vào đúng lúc schema bị drop/tạo lại (dữ liệu lai, hoặc
 * bản lùi của lượt này chụp trạng thái dở của lượt kia), và mọi đường ghi khác
 * (webhook, n8n, nút bấm) bị cửa ghi trả 503 / lỗi "đang phục hồi" trong cửa sổ đó.
 *
 * PHẠM VI LOẠI TRỪ (nói đúng, không hơn): (1) mọi đường ghi của CHÍNH tiến trình app này (cửa ghi +
 * lưới cấp op + drain); (2) mọi script/seed CLI dựng client qua `@/lib/prisma` / `taoPrismaClient`
 * (khoá ghi chung X — 409 kèm phiên + nút cắt phiên). KHÔNG loại trừ: `next dev` trên Mac trỏ DB prod
 * (tiến trình Next khác — cờ là RAM của container này, nó không giữ khoá CLI), Prisma Studio, `psql`
 * tay, hay bất kỳ client nào không đi qua `taoPrismaClient` ⇒ phải tắt chúng trước khi phục hồi. Nhân
 * sự thao tác qua app thì không cần báo ngừng nhập.
 *
 * KIỂM QUYỀN SỞ HỮU XEN GIỮA (fencing) — giữ được khoá lúc VÀO không có nghĩa là còn giữ lúc chạy
 * tới lệnh nạp. Cờ có TTL, mà mấy bước chờ ở đây (`coLuotDangChay()` là truy vấn Prisma không hạn,
 * `runPgDump` là tiến trình con) đều có thể treo lâu hơn TTL; khi đó cờ tự nhả, chủ shop bấm lại và
 * một lượt MỚI vào drop + nạp schema. Lượt cũ tỉnh dậy mà cứ đi tiếp là hai lượt cùng phá một
 * schema. Nên sau MỖI bước chờ không hạn và ngay TRƯỚC mỗi lệnh phá huỷ đều đi qua MỘT cổng duy
 * nhất: `giaHanKhoaPhucHoi()` — nó tự kiểm quyền rồi mới đẩy mốc, nên vừa chặn lượt đã mất khoá
 * (`false` ⇒ 409, không thêm một lệnh pg nào) vừa giữ cho TTL khỏi nhả oan một lượt đang tiến
 * triển. ĐỪNG tách thành "kiểm rồi gia hạn": TTL hết giữa hai lời gọi là lọt.
 * `laChuKhoaPhucHoi()` chỉ dùng để HỎI SUÔNG sau khi mọi việc đã xong (không cần thêm cửa sổ nữa).
 *
 * Chạy trong container app (`postgresql-client-15`), nối `-h supabase-db` từ
 * DATABASE_URL. `/backups` là volume mount (`./backups` host) — bền qua rebuild.
 */
export async function POST(request: Request): Promise<Response> {
  // Chỉ chủ shop: phục hồi thay TOÀN BỘ dữ liệu, kể cả tài khoản nhân sự và quyền của họ.
  const cong = await congChuShopRoute();
  if (!cong.ok) return cong.response;

  // Nhật ký ghi SAU khi `phucHoi` trả về — lúc đó `finally` của nó đã nhả khoá bảo trì + khoá việc
  // nặng. Kết cục thu hồi phiên đi qua `vet.thuHoiPhien` (không suy từ mã HTTP). Xem `ghiNhatKyPhucHoi`.
  // Restore khô (seam CHỈ bản build e2e, `docRestoreKhoE2e`) dừng trước bản lùi, không đổi dữ liệu ⇒
  // KHÔNG ghi nhật ký phục hồi.
  const khoE2e = docRestoreKhoE2e(request);
  if (khoE2e instanceof Response) return khoE2e;
  const vet: VetPhucHoi = { thuHoiPhien: "KHONG_TOI" };
  const response = await phucHoi(request, vet, khoE2e);
  if (khoE2e) return response;
  await ghiNhatKyPhucHoi(response, vet, { id: cong.nguoiDung.id, email: cong.nguoiDung.email });
  return response;
}

/** Lượt phục hồi nạp gì: file tải lên (lượt thật) hoặc restore khô (seam e2e — dừng trước bản lùi). */
type NguonPhucHoi = { loai: "file"; fileBuf: Buffer } | { loai: "kho-e2e"; hanDrainMs: number };

/**
 * SEAM "RESTORE KHÔ" — CHỈ cho e2e cổng ghi trên bản build (`tests/e2e/cong-ghi-prod.spec.ts`). Trả hạn
 * drain khi request này là restore khô; `null` ở mọi trường hợp khác (luôn luôn trên bản build prod).
 * Request ĐÃ đăng ký mà hạn không hợp lệ ⇒ `Response` 400 — KHÔNG BAO GIỜ rơi về lối phục hồi thật:
 * request do route chỉ-test dựng ra không được có đường nào tới bản lùi / lệnh phá huỷ.
 *
 * Restore khô đi ĐÚNG chuỗi thật của lượt phục hồi — cổng chủ shop → origin → lease → X → cờ → drain →
 * cổng SyncLog → fencing — rồi DỪNG trước bản lùi: không đọc file, không `pg_dump`/`pg_restore`, không
 * đụng dữ liệu, không ghi nhật ký. Bật khi CẢ HAI cùng đúng:
 *  1. `E2E_CONG_GHI=1` lúc chạy (chỉ `playwright.cong-ghi-prod.config.ts` đặt; mẫu `.env` không có biến này);
 *  2. CHÍNH object `request` này đã được đăng ký vào bảng neo `globalThis`. Chỉ route chỉ-test
 *     `src/app/api/e2e-cong-ghi/route.e2e.ts` đăng ký (qua `src/lib/backup/cong-ghi-e2e-chi-test.ts`), và
 *     Next chỉ build file đó khi `E2E_CONG_GHI_BUILD=1` (`pageExtensions` ở `next.config.ts`). Khoá của
 *     bảng là object trong RAM — không HTTP client nào tạo được mục, nên bản build prod (kể cả lỡ đặt
 *     biến ở (1)) không có đường nào bật seam.
 * Đọc bảng bằng chuỗi `Symbol.for` viết TẠI CHỖ, KHÔNG import module chỉ-test (import là kéo nó vào bundle
 * prod). Lưới `tests/luoi/file-chi-build-e2e.test.ts` khoá chuỗi hai bên trùng nhau.
 */
function docRestoreKhoE2e(request: Request): { hanDrainMs: number } | Response | null {
  if (process.env.E2E_CONG_GHI !== "1") return null;
  const bang = (globalThis as unknown as Record<symbol, WeakMap<Request, { hanDrainMs: unknown }> | undefined>)[
    Symbol.for("hogikids.e2eCongGhi.restoreKho")
  ];
  const muc = bang?.get(request);
  if (!muc) return null;
  const han = muc.hanDrainMs;
  if (typeof han !== "number" || !Number.isInteger(han) || han < 1 || han > HAN_DRAIN_GHI_MS) {
    return Response.json(
      { error: `Restore khô: hạn drain phải là số nguyên 1..${HAN_DRAIN_GHI_MS} — chưa làm gì.` },
      { status: 400 },
    );
  }
  return { hanDrainMs: han };
}

/**
 * Kết cục bước thu hồi phiên — căn cứ DUY NHẤT để nhật ký ghi OK hay LOI cho lượt đã nạp xong.
 * - `KHONG_TOI`: dừng trước bước nạp (mọi nhánh 4xx/5xx) — dữ liệu còn nguyên.
 * - `XONG`: nạp xong, đã đẩy mốc phiên VÀ vẫn là chủ khoá sau đó.
 * - `MAT_KHOA`: nạp xong nhưng mất khoá bảo trì trước/sau/trong lúc thu hồi phiên.
 * - `LOI`: nạp xong, vẫn giữ khoá, nhưng câu thu hồi phiên ném.
 */
type KetQuaThuHoiPhien = "KHONG_TOI" | "XONG" | "MAT_KHOA" | "LOI";

/** Điều `phucHoi` biết được về file + kết cục, để ghi nhật ký sau khi đã nhả khoá. */
type VetPhucHoi = { dinhDang?: string; kichThuoc?: number; thuHoiPhien: KetQuaThuHoiPhien };

/**
 * Mã lý do CỐ ĐỊNH cho ca "nạp xong nhưng chưa thu hồi được phiên" — HTTP vẫn 200 kèm `canhBao`
 * (dữ liệu đã bị thay, nói "chưa làm gì" là xui chủ shop bấm lại), còn nhật ký phải là LOI: thiết bị
 * khác có thể còn đăng nhập bằng phiên đời backup. Mã thay vì câu tự do để lọc/đếm được.
 */
const LY_DO_CHUA_THU_HOI_PHIEN: Readonly<Record<"MAT_KHOA" | "LOI", string>> = {
  MAT_KHOA: "CHUA_THU_HOI_PHIEN_MAT_KHOA",
  LOI: "CHUA_THU_HOI_PHIEN_LOI",
};

/**
 * Lý do từ chối theo mã HTTP — chuỗi CỐ ĐỊNH, không chép câu lỗi (câu guard có thể trích tên object lấy
 * từ file tải lên; `ghiChu` nhật ký không nhận chuỗi tự do từ đầu vào).
 */
const LY_DO_THEO_MA: Readonly<Record<number, string>> = {
  400: "File sao lưu không hợp lệ",
  403: "Request khác origin",
  409: "Đang bận hoặc mất khoá giữa chừng — dữ liệu còn nguyên",
  413: "File quá lớn",
  422: "Bản sao lưu đời trước phân quyền",
  500: "Phục hồi thất bại",
};

/**
 * Nhật ký `PHUC_HOI` — gọi SAU khi `phucHoi` đã trả (khoá đã nhả).
 *
 * Quyết định theo `vet.thuHoiPhien`, KHÔNG theo `response.ok`: nhánh nạp xong mà chưa thu hồi được
 * phiên vẫn trả 200 (kèm `canhBao`), dựa vào mã HTTP là ghi nhầm OK.
 *
 * - OK (chỉ `XONG`): ghi vào DB VỪA phục hồi — đúng chỗ: đó là sự kiện của DB hiện hành, và ghi TRƯỚC
 *   lúc nạp là bị chính bản sao lưu xoá mất. Không có cổng tự bỏ qua như `ghiNhatKyLoi` nên tự kiểm
 *   `dangPhucHoi()`: một lượt khác đang giữ khoá ⇒ ghi lúc này là chen vào schema lượt kia đang thay —
 *   bỏ dòng (log console). Lỗi ghi bị nuốt: dữ liệu đã nạp xong, không được biến lượt phục hồi thành
 *   công thành 500.
 * - LOI `MAT_KHOA`/`LOI`: nạp xong nhưng chưa thu hồi phiên — mã lý do cố định.
 * - LOI `KHONG_TOI` (mọi mã ≥ 400 sau cổng chủ shop): lý do theo mã HTTP.
 * Mọi dòng LOI đi qua `ghiNhatKyLoi` — nó tự bỏ qua khi đang có lượt phục hồi giữ khoá (vd 409 "lượt
 * khác đang chạy", hoặc lượt khác đã giành khoá lượt này đánh rơi) và tự nuốt lỗi ghi.
 */
async function ghiNhatKyPhucHoi(response: Response, vet: VetPhucHoi, actor: ActorNhatKy): Promise<void> {
  const doiTuong =
    vet.dinhDang !== undefined
      ? { loai: "BanSaoLuu", moTa: `${vet.dinhDang} · ${vet.kichThuoc ?? 0} byte` }
      : undefined;
  if (vet.thuHoiPhien === "XONG") {
    if (dangPhucHoi()) {
      console.error("[nhat-ky] Bỏ dòng PHUC_HOI OK: một lượt phục hồi khác đang giữ khoá bảo trì.");
      return;
    }
    try {
      await ghiNhatKy(prisma, {
        hanhDong: HANH_DONG.PHUC_HOI,
        actor,
        doiTuong,
      });
    } catch (loi) {
      console.error("[nhat-ky] Không ghi được dòng PHUC_HOI OK sau khi đã nạp xong:", loi);
    }
    return;
  }
  await ghiNhatKyLoi({
    hanhDong: HANH_DONG.PHUC_HOI,
    actor,
    doiTuong,
    ghiChu: {
      lyDo:
        vet.thuHoiPhien === "KHONG_TOI"
          ? (LY_DO_THEO_MA[response.status] ?? `Mã ${response.status}`)
          : LY_DO_CHUA_THU_HOI_PHIEN[vet.thuHoiPhien],
    },
  });
}

/**
 * Thân phục hồi (sau cổng chủ shop). Ghi `vet` để `POST` ghi nhật ký sau khi khoá đã nhả. `khoE2e` khác
 * `null` CHỈ ở restore khô của bản build e2e (`docRestoreKhoE2e`): bỏ bước nhận + kiểm file, mọi bước
 * giành khoá / drain / fencing phía sau là đúng mã của lượt thật.
 */
async function phucHoi(request: Request, vet: VetPhucHoi, khoE2e: { hanDrainMs: number } | null): Promise<Response> {
  // Next KHÔNG tự so Origin/Host cho Route Handler (chỉ cho Server Action) — route phá huỷ nhất
  // của app phải tự gác. Xem lý do đầy đủ ở `chanRequestKhacOrigin`.
  const khacOrigin = chanRequestKhacOrigin(request);
  if (khacOrigin) return khacOrigin;

  let nguon: NguonPhucHoi;
  if (khoE2e) {
    nguon = { loai: "kho-e2e", hanDrainMs: khoE2e.hanDrainMs };
  } else {
    const file = await nhanVaKiemFileTaiLen(request, vet);
    if (file instanceof Response) return file;
    nguon = { loai: "file", fileBuf: file };
  }

  return giuKhoaRoiPhucHoi(nguon, vet);
}

/**
 * Nhận file tải lên + TOÀN BỘ guard chỉ-đọc-file (bước 1–2b) — CHƯA giành khoá, CHƯA đụng DB. Trả
 * `Buffer` khi file hợp lệ, `Response` (400/413/422) khi phải dừng.
 */
async function nhanVaKiemFileTaiLen(request: Request, vet: VetPhucHoi): Promise<Buffer | Response> {
  // Chặn theo `Content-Length` TRƯỚC khi chạm thân request — xem `MAX_UPLOAD_ENVELOPE_BYTES`.
  const khaiDoDai = Number(request.headers.get("content-length"));
  if (Number.isFinite(khaiDoDai) && khaiDoDai > MAX_UPLOAD_ENVELOPE_BYTES) {
    return Response.json(
      { error: "File backup quá lớn (tối đa 200MB) — từ chối phục hồi." },
      { status: 413 },
    );
  }

  // Đọc file tải lên → Buffer.
  let fileBuf: Buffer;
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return Response.json({ error: "Thiếu file backup." }, { status: 400 });
    }
    // Cap size TRƯỚC khi arrayBuffer() bung bytes vào RAM (SEC-H1).
    if (file.size > MAX_UPLOAD_BYTES) {
      return Response.json(
        { error: "File backup quá lớn (tối đa 200MB) — từ chối phục hồi." },
        { status: 413 },
      );
    }
    fileBuf = Buffer.from(await file.arrayBuffer());
  } catch {
    return Response.json({ error: "Không đọc được file tải lên." }, { status: 400 });
  }

  // (1) Nhận diện định dạng — CHƯA đụng DB. Không hợp lệ → 400.
  const head = fileBuf.subarray(0, 512);
  const fmt = detectRestoreFormat(head);
  vet.kichThuoc = fileBuf.length;
  if (fmt !== null) vet.dinhDang = fmt;
  if (fmt === null) {
    return Response.json(
      { error: "File backup không hợp lệ (chỉ nhận .dump hoặc .sql.gz)" },
      { status: 400 },
    );
  }

  // (2) plain-gzip: gunzip HEAD bounded (gunzipHead — KHÔNG bung cả file vào
  // RAM, chống gzip-bomb SEC-H1) + assertNotArchive để chặn .tar.gz
  // backup-toàn-server (magic gzip giống .sql.gz) TRƯỚC KHI bất kỳ DROP nào đụng
  // DB. TAR / không-SQL → 400, DB NGUYÊN VẸN.
  if (fmt === "plain-gzip") {
    try {
      assertNotArchive(gunzipHead(fileBuf));
    } catch (err) {
      const message = err instanceof Error ? err.message : "File backup không hợp lệ.";
      return Response.json({ error: message }, { status: 400 });
    }
  }

  // (2b) TOÀN BỘ guard chỉ-đọc-file — guard schema (mục lục `pg_restore -l` + `assertDumpOnlySchema`
  // / bung có trần + `assertPlainSqlOnlySchema`) RỒI MỚI cổng "dump đời trước phân quyền" (M1).
  // Không đụng DB. Đặt TRƯỚC khoá bảo trì, khoá việc nặng, bản lùi và prune: đặt sau thì mỗi lần chủ
  // shop chọn nhầm file, route chụp một bản lùi rác rồi prune đẩy một bản lùi THẬT ra ngoài (chỉ giữ
  // KEEP_PRE_RESTORE bản) — nhầm đủ số lần là mất sạch lưới an toàn của các lượt phục hồi trước.
  // `runRestore` vẫn tự kiểm lại (phòng thủ nhiều lớp), nên nhánh 422 trong catch của bước (5) giữ.
  //
  // Thứ tự guard quyết định MÃ LỖI: file không phải backup của app (schema khác, nhiều schema) phải
  // ra 400 kèm câu guard, KHÔNG phải 422 "đời trước phân quyền" chỉ sang quy trình host. Chỉ file
  // đúng schema `app` mà thiếu/chưa hoàn tất M1 mới là 422.
  //
  // Lỗi khác (file .dump hỏng pg_restore không đọc được, .sql.gz vượt trần bung nén, lệnh đọc quá
  // hạn) cũng dừng ở đây với 400: chưa giành khoá, chưa ghi gì — dữ liệu hiện tại còn nguyên, đúng
  // câu modal hiện cho 400. Để chúng rơi xuống bước (5) là 500 kèm gợi ý đi lùi bản lùi — sai.
  try {
    await kiemDumCoM1(fileBuf, fmt);
  } catch (err) {
    if (err instanceof LoiBackupTruocPhanQuyen) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    const message = err instanceof Error ? err.message : "Không đọc được file backup.";
    return Response.json({ error: message }, { status: 400 });
  }

  return fileBuf;
}

/**
 * Bước (3) trở đi: giành lease → X → cờ, rồi chạy phần còn lại TRONG lối miễn cổng ghi; `finally` nhả
 * ngược cờ → X → lease. Dùng chung cho lượt thật và restore khô (seam e2e) — một mã duy nhất.
 */
async function giuKhoaRoiPhucHoi(nguon: NguonPhucHoi, vet: VetPhucHoi): Promise<Response> {
  // (3) CHỐT SỚM "lượt phục hồi khác đang chạy" — TRƯỚC mọi câu ghi: lease việc nặng ở (3a) là câu ghi
  // ngoài ngữ cảnh cửa, cờ đang bật thì cổng ghi chặn nó. Chốt THẬT vẫn là `thuGiuKhoaPhucHoi()` ở (3c).
  if (dangPhucHoi()) return traLoiLuotKhacDangChay();

  // Ba khoá giành THEO THỨ TỰ lease → X → cờ, nhả NGƯỢC lại ở `finally` (cờ → X → lease). Lý do thứ tự:
  //  - lease + X giành TRƯỚC cờ: hai cổng này trượt là chuyện thường (việc nặng/CLI đang ghi) — trả 409
  //    khi chưa bật cờ thì app không bị khoá ghi oan một giây nào.
  //  - cờ bật SAU X: từ lúc này mọi writer trong tiến trình bị cửa từ chối, mọi CLI bị X chặn ở lần ghi
  //    đầu; drain chỉ còn chờ lượt ĐÃ vào.
  // Thẻ/khoá gán TRONG try sau khi giành thắng; `null` = chưa giành ⇒ finally không đụng khoá của ai.
  let khoaViec: TheKhoa | null = null;
  let khoaX: KhoaDocQuyenRestore | null = null;
  let thePhien: ThePhienPhucHoi | null = null;

  try {
    // (3a) KHOÁ VIỆC NẶNG. Cổng SyncLog ở (4) đoán sống/chết bằng TUỔI (RUNNING > 15' coi như app
    // chết), nên một lượt "dựng lại từ kho thô" chạy quá 15' trở nên VÔ HÌNH đúng lúc nó vẫn đang
    // ghi. Cả 3 việc nặng giữ lease này TƯƠI bằng checkpoint tiến độ thật (mỗi 25 dòng ghi, hạn 5' —
    // `khoa-viec-nang.ts`), nên "giành trượt" = việc đó CÒN SỐNG THẬT.
    //
    // ⚠️ Lease nằm trong chính `app."Setting"` mà lượt phục hồi sẽ thay sạch ⇒ nó CHỈ là cổng chặn
    // TRƯỚC vùng phá huỷ, không phải hàng rào xuyên suốt: sau khi phá huỷ bắt đầu thì không fence bằng
    // nó nữa, và trả lease ở finally là best-effort. Hàng rào xuyên suốt với tiến trình ngoài app là
    // khoá X ở (3b) — sống ngoài schema app.
    //
    // Lỗi DB / cổng ghi chặn (một lượt phục hồi khác vừa bật cờ giữa chốt (3) và đây) ⇒ 409, chưa đụng gì.
    let luotGianh: Awaited<ReturnType<typeof giuKhoaViecNang>>;
    try {
      luotGianh = await giuKhoaViecNang(VIEC_PHUC_HOI);
    } catch (err) {
      if (laLoiCongGhiDangKhoa(err)) return traLoiLuotKhacDangChay();
      console.error("Không giành được khoá việc nặng trước lượt phục hồi (lỗi DB):", err);
      return traLoiChuaDoiGi("Không kiểm được khoá việc nặng — cơ sở dữ liệu không phản hồi.");
    }
    if (!luotGianh.the) {
      return Response.json(
        {
          error:
            `Đang có việc nặng "${luotGianh.dangGiu}" chạy — nó vẫn đang ghi vào đúng schema sắp ` +
            "bị thay. Chờ xong rồi phục hồi lại. (Nếu app vừa khởi động lại hoặc vừa nạp một bản " +
            "backup thì đây có thể là khoá cũ còn sót — nó tự hết hạn trong tối đa 5 phút.)",
        },
        { status: 409 },
      );
    }
    khoaViec = luotGianh.the;
    const theViec = luotGianh.the;

    // (3b) KHOÁ GHI CHUNG X — loại trừ mọi tiến trình CLI (script/seed ngoài Next giữ shared ở lần ghi
    // đầu, `khoa-chung-cli.ts`). Trượt ⇒ 409 kèm phiên đang giữ (pid, application_name, backend_start)
    // để chủ shop biết script nào còn chạy, hoặc cắt phiên mồ côi (`catPhienGiuKhoaChung`).
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) return traLoiChuaDoiGi("DATABASE_URL chưa được cấu hình.");
    let x: Awaited<ReturnType<typeof giuDocQuyenRestore>>;
    try {
      x = await giuDocQuyenRestore(cauHinhClientKhoa(dbUrl, TIEN_TO_APP_RESTORE));
    } catch (err) {
      console.error("Không giành được khoá ghi chung (lỗi kết nối):", err);
      return traLoiChuaDoiGi("Không giành được khoá ghi chung — cơ sở dữ liệu không phản hồi.");
    }
    if (!x.ok) return traLoiCliDangGhi(x.nguoiGiu);
    khoaX = x.khoa;
    const khoaGhiChung = x.khoa;

    // (3c) KHOÁ BẢO TRÌ (cờ) — từ đây cửa ghi từ chối writer mới. Lượt thứ hai nhận 409 chứ không xếp
    // hàng: phục hồi là thao tác tay, chờ mù hàng chục giây rồi mới biết là tệ hơn. Giữ THẺ PHIÊN để
    // `finally` chỉ trả đúng cờ của lượt này (xem `khoa-bao-tri.ts`).
    thePhien = thuGiuKhoaPhucHoi();
    if (!thePhien) return traLoiLuotKhacDangChay();
    const the = thePhien;

    // Từ khi giữ cờ, MỌI câu ghi của chính lượt phục hồi (gia hạn lease, thu hồi phiên) đi LỐI MIỄN
    // cổng ghi — không thì cổng chặn chính nó. Lượt phục hồi KHÔNG được đếm vào drain.
    return await chayMienCong("restore", () =>
      phaHuyCoKiemSoat({ nguon, vet, the, theViec, khoaGhiChung }),
    );
  } finally {
    // Trả cờ bảo trì (RAM, đồng bộ) TRƯỚC MỌI I/O: các bước nhả dưới đây là I/O có thể TREO — để
    // chúng đứng trước thì một cú treo giữ cả app ở chế độ chỉ-đọc tới hết TTL (~50') và response
    // không bao giờ về tay chủ shop.
    if (thePhien) traKhoaPhucHoi(thePhien);
    // Nhả X sau cờ: CLI chỉ chạy lại khi app cũng đã ghi lại được. `nha()` không ném.
    if (khoaX) await khoaX.nha();
    if (khoaViec) {
      // Best-effort: restore chết giữa vùng phá huỷ thì bảng `Setting` có thể không tồn tại lúc
      // này — lỗi trả khoá TUYỆT ĐỐI không được che response gốc (nhất là 500 của chính lượt nạp).
      // `traKhoaViecNang` chỉ xoá đúng token của mình nên không giật khoá việc khác. Lưu ý dòng
      // khoá trong FILE BACKUP vừa nạp thì KHÔNG chắc đã quá hạn: backup chụp giữa một việc nặng
      // (kể cả bản `pre-restore-*.dump` do chính route này tạo — nó chụp SAU khi ta giành lease)
      // mang dòng khoá còn hạn tối đa 5'. Chấp nhận: khoá ma đó tự hết hạn ≤5' và lần giành sau
      // thắng nó — câu 409 đã nói rõ để chủ shop khỏi hoang mang.
      //
      // `traKhoaViecNang` tự đi LỐI MIỄN cổng ghi: cờ có thể đang thuộc một lượt khác (lượt này treo
      // quá TTL) — trả lease của CHÍNH mình (xoá đúng token) không được để cổng chặn, không thì lease
      // kẹt tới hết hạn 5'. Không đè lên lượt phá huỷ của ai: lượt kia phải giành lease rồi X trước
      // khi bật cờ, cả hai đều còn trong tay lượt này cho tới các dòng ngay trên.
      try {
        await traKhoaViecNang(khoaViec);
      } catch (err) {
        console.error(
          "Không trả được khoá việc nặng sau lượt phục hồi (bảng Setting có thể chưa dựng lại). " +
            "Khoá tự hết hạn sau tối đa 5 phút — không cần xử lý tay.",
          err,
        );
      }
    }
  }
}

/**
 * Hạn chờ DRAIN — request/action/op lẻ đã vào TRƯỚC cờ chạy cho xong. Một trang ingest được cấp tới
 * 60s cho bước land cộng bước transform; 2 phút đủ rộng cho đường thường mà vẫn nhỏ hơn nhiều so với
 * TTL cờ. Quá hạn ⇒ 409 "chưa thay đổi gì", cờ nhả, lượt vào trước chạy tiếp bình thường.
 */
const HAN_DRAIN_GHI_MS = 120_000;

/** Lượt phục hồi mất khoá ghi chung X ở một chốt trước phá huỷ — dữ liệu còn nguyên (409). */
class MatKhoaGhiChung extends Error {
  constructor(public readonly buoc: string) {
    super(`Lượt phục hồi đã mất khoá ghi chung ở bước "${buoc}" — dừng trước khi đụng vào dữ liệu.`);
    this.name = "MatKhoaGhiChung";
  }
}

/**
 * Phần còn lại của lượt phục hồi SAU khi đã giữ đủ lease + X + cờ, chạy TRONG lối miễn cổng ghi:
 * drain → cổng SyncLog → fencing → pre-backup → fencing (+ X + lease) → nạp (chốt cuối trong
 * `runRestore`) → fencing → thu hồi phiên. Mọi nhánh lỗi TRƯỚC lệnh phá huỷ đầu tiên ⇒ 409 "chưa
 * thay đổi gì"; riêng pre-backup hỏng giữ 500 "đã hủy phục hồi" (hợp đồng cũ, dữ liệu cũng còn nguyên).
 */
async function phaHuyCoKiemSoat(p: {
  nguon: NguonPhucHoi;
  vet: VetPhucHoi;
  the: ThePhienPhucHoi;
  theViec: TheKhoa;
  khoaGhiChung: KhoaDocQuyenRestore;
}): Promise<Response> {
  const { nguon, vet, the: thePhien, theViec, khoaGhiChung } = p;

  // (3d) DRAIN — chờ request/action/op lẻ/tx lẻ đã vào TRƯỚC cờ chạy TRỌN (đếm về 0). Cờ đã bật nên
  // không writer mới nào vào thêm; drain trước khi bật cờ là để writer mới lọt khe. Hạn chỉ khác mặc
  // định ở restore khô của e2e (đo nhánh quá hạn mà không phải chờ 2 phút).
  const hanDrainMs = nguon.loai === "kho-e2e" ? nguon.hanDrainMs : HAN_DRAIN_GHI_MS;
  const sach = await choDrain(hanDrainMs);
  if (!sach) {
    await inGiaoDichDangMoChanDoan();
    const dem = docBoDem();
    return traLoiChuaDoiGi(
      `Còn ${dem.soRequest} lượt ghi trong app và ${dem.soOpLe} câu ghi lẻ chưa xong sau ` +
        `${hanDrainMs / 1000} giây.`,
    );
  }

  // (4) CỔNG SyncLog — giữ cho lượt đồng bộ NHIỀU request (n8n đẩy từng trang): cửa chỉ đếm từng
  // request, giữa hai trang của cùng một lượt bộ đếm có thể về 0. Gọi KHÔNG truyền kind = soi mọi
  // luồng: lượt phục hồi thay sạch schema nên ads, TikTok Shop và lượt dựng lại tay đều đang ghi vào
  // schema sắp mất. Từ chối sớm chứ không xếp hàng, để không đốt một suất trong 3 bản lùi.
  const conLuotDangGhi = await coLuotDangChay();

  // FENCING (chốt 1) sau các bước chờ ở trên. Hỏi quyền sở hữu TRƯỚC KHI đọc kết quả cổng SyncLog:
  // lượt này vừa treo quá TTL thì nguyên nhân dừng thật là "mất khoá", nói "đang có lượt đồng bộ" là
  // chỉ sai hướng điều tra. MỘT cổng duy nhất: `giaHanKhoaPhucHoi` tự kiểm quyền rồi mới đẩy mốc —
  // ĐỪNG tách thành "kiểm rồi gia hạn": TTL có thể hết GIỮA hai lời gọi.
  if (!giaHanKhoaPhucHoi(thePhien)) return traLoiMatKhoa("dò lượt đồng bộ đang chạy");

  if (conLuotDangGhi) {
    return Response.json(
      { error: "Đang có lượt đồng bộ chạy — chờ xong rồi phục hồi lại." },
      { status: 409 },
    );
  }

  // Gia hạn lease việc nặng sau bước chờ — `giaHanKhoa` kiểm quyền + đẩy hạn trong MỘT câu ghi nguyên
  // tử. Trượt = lease hết hạn giữa chừng và một việc nặng đã giành mất, tức nó ĐANG GHI — dừng ngay.
  if (!(await giaHanKhoaViecNangAnToan(theViec))) {
    return traLoiMatKhoaViecNang("dò lượt đồng bộ đang chạy");
  }

  // Restore khô (seam e2e — `docRestoreKhoE2e`): DỪNG ở đây. Đã đi trọn lease → X → cờ → drain → cổng
  // SyncLog → fencing; CHƯA chụp bản lùi, chưa đụng dữ liệu. `finally` của `giuKhoaRoiPhucHoi` nhả
  // cờ → X → lease như lượt thật. `boDem` chụp lúc cờ còn bật (đối chiếu "drain xong khi cờ còn giữ").
  if (nguon.loai === "kho-e2e") {
    return Response.json({ ok: true, khoE2e: "da-drain", luc: Date.now(), boDem: docBoDem() });
  }
  const { fileBuf } = nguon;

  // (5) Pre-restore backup: chụp DB hiện tại TRƯỚC khi phục hồi. Lỗi → 500, KHÔNG restore (không phá
  // khi chưa có bản lùi).
  try {
    const preRestore = await runPgDump();
    const thuMuc = thuMucBackup();
    // 0700 kể cả thư mục bind-mount ĐÃ có sẵn 0755 (xem `ghi-file-rieng-tu.ts`).
    await chuanBiThuMucRiengTu(thuMuc);
    // Giây + hậu tố ngẫu nhiên: mốc giây một mình KHÔNG đủ tách hai lượt phục hồi (khoá bảo trì cho
    // phép lượt sau chạy ngay khi lượt trước xong, vẫn có thể rơi vào cùng giây) — trùng tên là ghi đè
    // mất đúng điểm rollback vừa tạo. Tên vẫn giữ tiền tố thời gian nên sort vẫn ra thứ tự thời gian.
    const preName = `pre-restore-${format(new Date(), "yyyyMMdd-HHmmss")}-${randomBytes(3).toString("hex")}.dump`;
    await ghiFileRiengTu(join(thuMuc, preName), preRestore); // 0600, wx
    await prunePreRestoreBackups(thuMuc);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Không tạo được bản lùi trước khi phục hồi.";
    return Response.json(
      { error: `Không tạo được bản sao lưu trước phục hồi — đã hủy phục hồi: ${message}` },
      { status: 500 },
    );
  }

  // FENCING (chốt 2) — ngay sau bản lùi (bước dài nhất trước lệnh phá huỷ: `pg_dump` được cấp tới 10
  // phút). Kèm kiểm khoá X còn giữ (kết nối khoá chết giữa `pg_dump` ⇒ CLI có thể đã giành shared và
  // đang ghi) và gia hạn lease việc nặng.
  if (!giaHanKhoaPhucHoi(thePhien)) return traLoiMatKhoa("chụp bản lùi trước phục hồi");
  if (!(await khoaGhiChung.conGiu())) return traLoiMatKhoaGhiChung("chụp bản lùi trước phục hồi");
  if (!(await giaHanKhoaViecNangAnToan(theViec))) {
    return traLoiMatKhoaViecNang("chụp bản lùi trước phục hồi");
  }

  // (6) Phục hồi thật. runRestore lặp lại detect + assertNotArchive nội bộ (an toàn 2 lớp).
  try {
    // FENCING (chốt 3), đặt SÂU BÊN TRONG `runRestore` — giữa chốt 2 và lệnh phá huỷ đầu tiên còn
    // `writeFile`, `gunzipAsync`, `pg_restore -l` không có hạn ở tầng Node. Callback chạy ngay trước
    // lệnh phá huỷ đầu tiên; ném ở đó là an toàn vì chưa có gì trong DB bị đụng. Sau chốt thì KHÔNG
    // fence nữa — nửa chuỗi phá huỷ bị bỏ dở còn tệ hơn chạy trọn.
    const { format: restoredFormat } = await runRestore(fileBuf, {
      truocKhiPhaHuy: async () => {
        // THỨ TỰ SỐNG-CÒN: các câu chờ DB đứng TRƯỚC, cổng đồng bộ đứng CUỐI. `giaHanKhoa` và
        // `conGiu()` là câu DB có thể chờ lâu — để chúng SAU cổng khoá bảo trì là tự chèn một bước chờ
        // vào đúng khe giữa chốt fencing cuối và lệnh phá huỷ: chờ quá TTL thì cờ tự nhả, mọi đường
        // ghi mở lại, rồi ta DROP schema lên đúng dữ liệu đang được ghi. Cổng đồng bộ đứng cuối thì cú
        // treo đó bị chính nó bắt: mất cờ ⇒ ném ⇒ 409, chưa phá gì.
        if (!(await giaHanKhoaViecNangAnToan(theViec))) throw new MatKhoaViecNang(VIEC_PHUC_HOI);
        if (!(await khoaGhiChung.conGiu())) throw new MatKhoaGhiChung("chuẩn bị file để nạp");
        if (!giaHanKhoaPhucHoi(thePhien)) throw new LoiMatKhoaPhucHoi("chuẩn bị file để nạp");
      },
    });

    // Phục hồi nạp lại CẢ cột `User.sessionEpoch` đời backup ⇒ mốc phiên từng người bị LÙI. Đẩy mốc
    // MỌI người để mọi thiết bị phải đăng nhập lại. Đây KHÔNG phải vá bảo mật: `User.passwordHash`
    // cũng bị lùi nên mật khẩu đời backup sống lại — chủ shop phải tự đổi mật khẩu (modal phục hồi).
    //
    // Lỗi ở bước này KHÔNG được biến lượt phục hồi thành công thành 500 (dữ liệu đã nạp xong rồi).
    //
    // FENCING (chốt 4), và từ đây CỐ Ý KHÔNG trả 409 nữa: bước nạp đã xong, dữ liệu đã bị thay — trả
    // 409 ("bận, chưa làm gì") là nói dối theo hướng nguy hiểm nhất. Mất khoá ở đây thì bỏ luôn
    // `thuHoiMoiPhienCoHan()` (một câu GHI — có thể một lượt khác đang drop + nạp chính schema đó).
    // GIA HẠN (không chỉ kiểm) trước khi bắt đầu để có trọn một cửa sổ TTL cho câu ghi đó; kiểm khoá
    // LẦN NỮA sau khi nó trả về (nó có thể treo lâu rồi mới xong).
    let canhBao: string | undefined;
    if (!giaHanKhoaPhucHoi(thePhien)) {
      console.error(
        "Lượt phục hồi nạp xong nhưng đã MẤT khoá bảo trì trước bước thu hồi phiên — nó treo quá " +
          "TTL giữa chừng nên cờ tự nhả và có thể đã sang lượt khác. Bỏ qua thu hồi phiên để không " +
          "ghi vào schema mà lượt kia đang thay. Kiểm log phía trên xem treo ở đâu.",
      );
      canhBao = CANH_BAO_MAT_KHOA_SAU_NAP;
      vet.thuHoiPhien = "MAT_KHOA";
    } else {
      try {
        await thuHoiMoiPhienCoHan();
        if (laChuKhoaPhucHoi(thePhien)) {
          vet.thuHoiPhien = "XONG";
        } else {
          canhBao = CANH_BAO_MAT_KHOA_SAU_NAP;
          vet.thuHoiPhien = "MAT_KHOA";
        }
      } catch {
        if (laChuKhoaPhucHoi(thePhien)) {
          canhBao =
            "Đã phục hồi xong nhưng KHÔNG đẩy được mốc thu hồi phiên — thiết bị khác có thể còn đăng nhập. " +
            "Khởi động lại container app rồi đổi mật khẩu ngay.";
          vet.thuHoiPhien = "LOI";
        } else {
          canhBao = CANH_BAO_MAT_KHOA_SAU_NAP;
          vet.thuHoiPhien = "MAT_KHOA";
        }
      }
    }

    return Response.json({ ok: true, format: restoredFormat, canhBao });
  } catch (err) {
    // Mất khoá ở một chốt BÊN TRONG `runRestore` = đã dừng TRƯỚC lệnh phá huỷ đầu tiên ⇒ dữ liệu còn
    // nguyên, trả 409 như các chốt kia. Rơi vào nhánh 500 bên dưới là xui chủ shop đi lùi về
    // `pre-restore-*.dump` trong khi chẳng mất gì.
    if (err instanceof LoiMatKhoaPhucHoi) return traLoiMatKhoa(err.buoc);
    if (err instanceof MatKhoaViecNang) return traLoiMatKhoaViecNang("chuẩn bị file để nạp");
    if (err instanceof MatKhoaGhiChung) return traLoiMatKhoaGhiChung(err.buoc);
    // Dump chụp trước migration phân quyền: `runRestore` từ chối TRƯỚC chốt phá huỷ ⇒ dữ liệu còn
    // nguyên. 422 kèm lối đi quy trình trên host (lớp phòng thủ thứ hai sau cổng (2b)).
    if (err instanceof LoiBackupTruocPhanQuyen) {
      return Response.json({ error: err.message }, { status: 422 });
    }

    const message = err instanceof Error ? err.message : "Phục hồi thất bại.";
    return Response.json(
      {
        error: `Phục hồi thất bại: ${message}. Dùng bản lùi pre-restore-*.dump hoặc chạy deploy/restore.sh (xem hướng dẫn deploy).`,
      },
      { status: 500 },
    );
  }
}

/**
 * Chẩn đoán khi drain quá hạn: in các phiên DB đang mở GIAO DỊCH GHI (`backend_xid` có giá trị) trên
 * DB hiện tại — chỉ để đọc log biết ai đang giữ, KHÔNG dùng làm điều kiện (phiên của tiến trình khác
 * đã bị X/cổng chặn ở lần ghi kế tiếp). Lỗi truy vấn bị nuốt.
 */
async function inGiaoDichDangMoChanDoan(): Promise<void> {
  try {
    const dong = await prisma.$queryRaw<
      { pid: number; application_name: string | null; state: string | null; backend_xid: string | null; xact_start: Date | null }[]
    >`SELECT pid, application_name, state, backend_xid::text AS backend_xid, xact_start
        FROM pg_stat_activity
       WHERE datname = current_database() AND backend_xid IS NOT NULL AND pid <> pg_backend_pid()`;
    console.error("[phuc-hoi] drain quá hạn — bộ đếm:", docBoDem(), "— phiên đang mở giao dịch ghi:", dong);
  } catch (err) {
    console.error("[phuc-hoi] drain quá hạn — không đọc được pg_stat_activity:", err);
  }
}

/** 409 chung cho mọi lối dừng TRƯỚC phá huỷ không thuộc nhóm "mất khoá": dữ liệu còn nguyên. */
function traLoiChuaDoiGi(lyDo: string): Response {
  return Response.json(
    { error: `${lyDo} Đã DỪNG trước khi thay đổi bất cứ thứ gì — dữ liệu hiện tại còn nguyên. Thử lại sau.` },
    { status: 409 },
  );
}

function traLoiLuotKhacDangChay(): Response {
  return Response.json(
    { error: "Đang có một lượt phục hồi khác chạy — chờ xong rồi thử lại." },
    { status: 409 },
  );
}

/**
 * 409 khi tiến trình CLI (script/seed) đang giữ khoá ghi chung. Kèm danh sách phiên để chủ shop biết
 * script nào còn chạy, hoặc cắt phiên mồ côi (Mac ngủ giữ khoá tới ~2h11') — `catPhienGiuKhoaChung`.
 */
function traLoiCliDangGhi(nguoiGiu: PhienGiuKhoa[]): Response {
  return Response.json(
    {
      error:
        "Đang có script chạy ngoài app giữ khoá ghi dữ liệu — chờ script xong (hoặc dừng nó) rồi thử " +
        "lại. Đã DỪNG trước khi thay đổi bất cứ thứ gì, dữ liệu hiện tại còn nguyên.",
      phienDangGiu: nguoiGiu.map((p) => ({
        pid: p.pid,
        applicationName: p.applicationName,
        backendStart: p.backendStart,
        mode: p.mode,
        // Role + "cắt được": modal chỉ hiện nút cắt cho phiên CÙNG role app (lối cắt chỉ cắt được các
        // phiên đó); phiên role khác hiện kèm câu lệnh cắt tay bằng superuser.
        usename: p.usename,
        catDuoc: p.catDuoc,
      })),
    },
    { status: 409 },
  );
}

/** Mất khoá ghi chung X ở một chốt TRƯỚC phá huỷ — CLI có thể đã giành lại; dữ liệu còn nguyên. */
function traLoiMatKhoaGhiChung(buoc: string): Response {
  console.error(
    `Lượt phục hồi MẤT khoá ghi chung (X) ở bước "${buoc}" — kết nối giữ khoá đã đứt, script ngoài app ` +
      `có thể đã giành lại. ĐÃ DỪNG trước mọi lệnh phá huỷ.`,
  );
  return traLoiChuaDoiGi("Mất khoá ghi chung giữa chừng (kết nối giữ khoá bị đứt).");
}

/**
 * Câu trả lời khi lượt này KHÔNG còn giữ khoá bảo trì giữa chừng (fencing bắt được).
 *
 * 409 vì đúng nghĩa "xung đột trạng thái", cùng mã với hai cổng bận ở trên nên UI đã xử lý sẵn
 * (`restore-dialog.tsx` hiện thẳng câu này, không gợi ý đi lùi về bản `pre-restore-*.dump` — đúng,
 * vì mọi điểm gọi hàm này đều nằm TRƯỚC lệnh nạp nên dữ liệu còn nguyên).
 *
 * Câu chữ nói rõ nguyên nhân là LƯỢT NÀY TREO chứ không phải người dùng bấm sai — chủ shop chỉ bấm
 * một nút, đổ lỗi mơ hồ sẽ khiến họ bấm lại liên tục. `buoc` chỉ vào log để biết treo ở đâu.
 */
/**
 * Gia hạn lease việc nặng, LỖI DB CŨNG COI LÀ MẤT. `giaHanKhoa` là câu ghi Prisma nên ngoài trả
 * `false` nó còn có thể NÉM (đứt kết nối, bảng đang bị khoá...). Mọi điểm gọi đều đứng TRƯỚC lệnh
 * phá huỷ, nên "không biết còn giữ hay không" phải xử y như "đã mất": dừng sạch với 409
 * dữ-liệu-còn-nguyên. Để lỗi thoát ra ngoài là thành 500 mù — đúng kiểu response xui chủ shop đi
 * lùi bản `pre-restore-*.dump` trong khi chưa mất gì.
 */
async function giaHanKhoaViecNangAnToan(the: TheKhoa): Promise<boolean> {
  try {
    return await giaHanKhoa(the);
  } catch (err) {
    console.error(
      "Không kiểm được khoá việc nặng (lỗi DB) — coi như đã mất để dừng lượt phục hồi an toàn.",
      err,
    );
    return false;
  }
}

/**
 * Câu trả lời khi lease VIỆC NẶNG của lượt phục hồi không giữ được nữa: một việc nặng khác giành
 * mất (lượt này đứng im quá hạn 5' ở một bước chờ — kể cả script CLI ngoài tiến trình app cũng
 * giành được), hoặc không kiểm được vì lỗi DB. Mọi điểm gọi đều nằm TRƯỚC lệnh phá huỷ đầu tiên ⇒
 * dữ liệu còn nguyên ⇒ 409 cùng triết lý với `traLoiMatKhoa`. Nhường bên kia chạy tiếp là ĐÚNG:
 * bên nào commit khoá trước bên đó thắng, bên thua dừng khi chưa phá gì.
 */
function traLoiMatKhoaViecNang(buoc: string): Response {
  console.error(
    `Lượt phục hồi KHÔNG GIỮ ĐƯỢC khoá việc nặng ở bước "${buoc}" — hoặc nó đứng quá hạn khoá 5' ` +
      `và một việc nặng khác đã giành được, hoặc câu kiểm khoá lỗi. ĐÃ DỪNG trước mọi lệnh phá huỷ ` +
      `(không có gì bị xoá). Kiểm log phía trên xem bước đó treo/lỗi vì sao.`,
  );
  return Response.json(
    {
      error:
        "Không giữ được khoá việc nặng (một việc khác đã giành trong lúc lượt phục hồi đứng quá " +
        "lâu, hoặc lỗi kết nối) — đã DỪNG trước khi thay đổi bất cứ thứ gì, dữ liệu hiện tại còn " +
        "nguyên. Chờ việc đang chạy xong rồi thử lại.",
    },
    { status: 409 },
  );
}

function traLoiMatKhoa(buoc: string): Response {
  console.error(
    `Lượt phục hồi MẤT khoá bảo trì ở bước "${buoc}" — nó treo quá TTL nên cờ đã tự nhả, và có thể ` +
      `một lượt phục hồi khác đang giữ. ĐÃ DỪNG trước mọi lệnh pg tiếp theo (không có gì bị xoá). ` +
      `Kiểm log phía trên xem bước đó treo vì sao.`,
  );
  return Response.json(
    {
      error:
        "Lượt phục hồi này chạy quá lâu nên khoá bảo trì đã tự nhả và có thể đã sang lượt khác — " +
        "đã DỪNG trước khi thay đổi bất cứ thứ gì, dữ liệu hiện tại còn nguyên. Chờ lượt đang chạy " +
        "xong rồi thử lại.",
    },
    { status: 409 },
  );
}

/** Giữ ~KEEP_PRE_RESTORE bản `pre-restore-*.dump` mới nhất, xoá phần cũ hơn. */
async function prunePreRestoreBackups(thuMuc: string): Promise<void> {
  try {
    const names = (await readdir(thuMuc))
      .filter((n) => n.startsWith("pre-restore-") && n.endsWith(".dump"))
      .sort(); // tên yyyyMMdd-HHmmss sort lexicographic = theo thời gian.
    const stale = names.slice(0, Math.max(0, names.length - KEEP_PRE_RESTORE));
    await Promise.all(stale.map((n) => unlink(join(thuMuc, n)).catch(() => {})));
  } catch {
    // Prune lỗi không được chặn phục hồi — bỏ qua.
  }
}
