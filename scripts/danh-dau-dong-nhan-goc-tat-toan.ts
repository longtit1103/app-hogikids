/**
 * Gán dấu dòng nhận gốc cho sổ tiết kiệm tất toán TRƯỚC khi có cột `SoTietKiem.dongNhanGocTatToanId`.
 *
 * VÌ SAO CẦN: "Mở lại" sổ giờ chỉ xoá đúng dòng `SAVINGS_IN` mà sổ trỏ tới. Sổ đóng bởi bản cũ có cột NULL; nếu còn
 * dòng mang mẫu mô tả app sinh thì Mở lại TỪ CHỐI (không đoán — đoán sai là xoá dòng tiền thật ghi tay). Script này
 * đề xuất ứng viên để chủ shop đối chiếu sao kê, rồi chỉ gán đúng các id đã duyệt.
 *
 *   Lượt thử (MẶC ĐỊNH, chỉ đọc):  npx tsx scripts/danh-dau-dong-nhan-goc-tat-toan.ts
 *   Ghi các id đã duyệt:           npx tsx scripts/danh-dau-dong-nhan-goc-tat-toan.ts --apply --ids=a,b,c
 *   Trên minipc (không TTY):       docker compose run --rm app npx --no-install tsx \
 *                                    scripts/danh-dau-dong-nhan-goc-tat-toan.ts --apply --ids=a,b --xac-nhan-db=<tên DB>
 *
 * Ứng viên = dòng `SAVINGS_IN` của sổ đã đóng (cột NULL) khớp CẢ BA dấu: mô tả đúng khuôn tất toán ghi, ngày cùng
 * ngày VN với `closedAt`, số tiền = Σ gửi − Σ nhận khác — VÀ là ứng viên duy nhất của sổ (`chonDongNhanGocDiSan`).
 *
 * AN TOÀN: chỉ ghi CỘT TRỎ DÒNG + nhật ký thao tác (`TIET_KIEM_GAN_DAU_DONG_NHAN_GOC`), không chạm dòng tiền nào ⇒
 * quỹ, P&L, số đang gửi không đổi. `--apply` chạy MỘT transaction, khoá từng sổ FOR UPDATE, kiểm lại ba dấu sau khoá;
 * một id sai là cả lượt lùi. IDEMPOTENT: chạy lại với cùng id không đổi gì. Giành `khoaViecNang` để không chạy chồng
 * với xoá dữ liệu / dựng lại / phục hồi DB.
 *
 * ⚠️ Máy dev: `DATABASE_URL` trong `.env` trỏ THẲNG DB PROD ⇒ script in `host/db` (không credential) và đòi gõ lại tên
 * DB trước khi ghi. Không TTY ⇒ bắt buộc `--xac-nhan-db=<tên DB>` khớp đúng tên DB đích.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";

// Script standalone không đi qua Next auto-load .env → nạp bằng loader built-in của Node (≥20.6). Biến môi trường
// ĐÃ set (vd DATABASE_URL của container prod) được ưu tiên.
const envPath = path.resolve(process.cwd(), ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

/** Người thực hiện ghi vào nhật ký — script không có phiên đăng nhập. */
const ACTOR_SCRIPT = {
  id: "script:danh-dau-dong-nhan-goc-tat-toan",
  email: "script:danh-dau-dong-nhan-goc-tat-toan",
} as const;

/** Định danh DB đích KHÔNG kèm credential: host + tên DB (+ schema, vì app/test chung DB `postgres`). */
function docDbDich(): { moTa: string; tenDb: string } {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Thiếu DATABASE_URL — không biết đọc/ghi vào đâu.");
  const u = new URL(url);
  const tenDb = decodeURIComponent(u.pathname.replace(/^\//, ""));
  const schema = u.searchParams.get("schema") || "public";
  return { moTa: `${u.host}/${tenDb} schema=${schema}`, tenDb };
}

type ThamSo = { apply: boolean; ids: string[]; xacNhanDb: string | undefined };

/** Cờ gõ sai mà im lặng thành lượt thử = người chạy tưởng đã ghi ⇒ báo lỗi cờ lạ. */
function docThamSo(): ThamSo {
  let apply = false;
  let ids: string[] = [];
  let xacNhanDb: string | undefined;
  for (const a of process.argv.slice(2)) {
    if (a === "--dry-run") continue;
    if (a === "--apply") apply = true;
    else if (a.startsWith("--ids=")) {
      ids = a
        .slice("--ids=".length)
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } else if (a.startsWith("--xac-nhan-db=")) xacNhanDb = a.slice("--xac-nhan-db=".length);
    else throw new Error(`Cờ không nhận ra: ${a}. Chỉ có --dry-run · --apply · --ids=a,b,c · --xac-nhan-db=<tên DB>`);
  }
  if (process.argv.includes("--dry-run") && apply) throw new Error("--dry-run và --apply loại trừ nhau.");
  if (apply && ids.length === 0) throw new Error("--apply cần --ids=a,b,c (id dòng lấy từ bảng lượt thử).");
  if (!apply && ids.length > 0) throw new Error("--ids chỉ dùng cùng --apply.");
  return { apply, ids, xacNhanDb };
}

/** Đòi gõ lại ĐÚNG tên DB đích. Không TTY ⇒ phải truyền `--xac-nhan-db`. */
async function xacNhanTenDb(tenDb: string, xacNhanDb: string | undefined): Promise<boolean> {
  if (xacNhanDb !== undefined) return xacNhanDb === tenDb;
  if (!process.stdin.isTTY) {
    console.error("Không phải TTY (container/CI) — chạy lại kèm --xac-nhan-db=<tên DB đích>.");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const tl = await rl.question(`Gõ lại tên DB đích ("${tenDb}") để xác nhận ghi: `);
    return tl.trim() === tenDb;
  } finally {
    rl.close();
  }
}

// import ĐỘNG: `src/lib/prisma.ts` đọc `DATABASE_URL` ngay lúc nạp module, import static bị hoist TRƯỚC
// `loadEnvFile` ở trên → client nối sai DB.
async function main(): Promise<void> {
  const thamSo = docThamSo();
  const db = docDbDich();
  console.log("DB đích:", db.moTa);

  const { prisma } = await import("@/lib/prisma");
  const { giuKhoaViecNang, traKhoaViecNang } = await import("@/lib/backup/khoa-viec-nang");
  const { ganDauDongNhanGoc, khaoSatSoCanGanDau } = await import("@/lib/tiet-kiem/gan-dau-dong-nhan-goc-tat-toan");

  try {
    const ks = await khaoSatSoCanGanDau();
    console.log(`\n${ks.length} sổ đã tất toán đang bị chặn Mở lại (chưa gán dấu dòng nhận gốc):`);
    if (ks.length > 0) {
      console.table(
        ks.map((x) => ({
          so: x.tenSo,
          soId: x.soId,
          ngayTatToan: x.ngayTatToan,
          soDongNhan: x.soDongNhan,
          dongDeXuat: x.dongId ?? "—",
          soTien: x.soTien ?? "—",
          lyDo: x.lyDo ?? "",
        }))
      );
    }
    const deXuat = ks.flatMap((x) => (x.dongId !== null ? [x.dongId] : []));

    if (!thamSo.apply) {
      console.log("\nLƯỢT THỬ — KHÔNG ghi gì. Đối chiếu từng dòng đề xuất với sao kê ngân hàng rồi chạy:");
      console.log(
        deXuat.length > 0
          ? `  --apply --ids=${deXuat.join(",")}`
          : "  (không có dòng đề xuất — sổ có lý do cần đối chiếu tay, không gán được bằng script)"
      );
      return;
    }

    console.log(`\nSẽ gán dấu ${thamSo.ids.length} dòng: ${thamSo.ids.join(", ")}`);
    if (!(await xacNhanTenDb(db.tenDb, thamSo.xacNhanDb))) {
      process.exitCode = 1;
      console.error("Tên DB không khớp — KHÔNG ghi gì.");
      return;
    }

    const khoa = await giuKhoaViecNang("gán dấu dòng nhận gốc tất toán (script)");
    if (!khoa.the) {
      process.exitCode = 1;
      console.error(`Đang có "${khoa.dangGiu}" chạy — chờ xong rồi chạy lại.`);
      return;
    }
    try {
      const kq = await ganDauDongNhanGoc(thamSo.ids, ACTOR_SCRIPT);
      console.log(`Đã gán: ${kq.daGan.length} (${kq.daGan.join(", ") || "—"})`);
      console.log(`Đã có sẵn, bỏ qua: ${kq.daCoSan.length} (${kq.daCoSan.join(", ") || "—"})`);
    } finally {
      await traKhoaViecNang(khoa.the);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
