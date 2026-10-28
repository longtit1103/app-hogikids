/**
 * Dựng Silver hoá đơn quảng cáo TikTok (`TiktokAdsHoaDon`) từ Bronze `RawTiktokBusinessInvoice` — CHỈ stream
 * `tiktokbusiness/invoice`, KHÔNG chạy full rebuild (không đụng Order/Product/Expense). Idempotent theo
 * `transactionId`: chạy lại bao nhiêu lần cũng ra cùng kết quả. Chạy MỘT lần sau `migrate deploy`; từ đó lượt kéo
 * đêm `tiktok-business-nightly` tự dựng phần mới theo từng trang.
 *
 * In tổng THEO THÁNG (giờ VN) × loại giao dịch để đối chiếu với số đo trực tiếp từ kho thô / TikTok Ads Manager.
 * Còn dòng không dựng được (`skipped`) ⇒ exit 1 — đọc cảnh báo, sửa mapping rồi chạy lại. Giành `khoaViecNang` như các
 * script dựng lại khác: không chạy chồng với xoá dữ liệu / dựng lại / phục hồi DB.
 *
 *   Trên minipc (container đã có env PROD):
 *   `docker compose run --rm app npx --no-install tsx scripts/rebuild-tiktok-ads-hoa-don.ts`
 *   Từ máy dev — Prisma 7 KHÔNG tự nạp .env, phải nạp tường minh (DATABASE_URL trong .env = PROD):
 *   `npx tsx --env-file=.env scripts/rebuild-tiktok-ads-hoa-don.ts`
 */
import { giuKhoaViecNang, taoCheckpoint, traKhoaViecNang } from "@/lib/backup/khoa-viec-nang";
import { transformFromRaw } from "@/lib/bronze/transform-from-raw";
import { prisma } from "@/lib/prisma";

type DongThang = {
  thang: string;
  transactionType: string;
  billingType: string;
  amountType: string;
  so: number;
  tong: bigint;
};

async function main(): Promise<void> {
  const khoa = await giuKhoaViecNang("dựng Silver hoá đơn TikTok (script)");
  if (!khoa.the) {
    process.exitCode = 1;
    console.error(`Đang có "${khoa.dangGiu}" chạy — chờ xong rồi chạy lại.`);
    return;
  }
  try {
    await dungVaIn(taoCheckpoint(khoa.the));
  } finally {
    await traKhoaViecNang(khoa.the);
  }
}

async function dungVaIn(checkpoint: () => Promise<void>): Promise<void> {
  const warnings: string[] = [];
  const stats = await transformFromRaw("tiktokbusiness/invoice", warnings, { checkpoint });

  console.log(`Upserted → hoá đơn: ${stats.hoaDonAdsUpserted} · skipped: ${stats.skipped}`);
  if (warnings.length) {
    console.log(`\n${warnings.length} cảnh báo (20 dòng đầu):`);
    warnings.slice(0, 20).forEach((w) => console.warn("⚠", w));
  }

  // `createTime` là timestamp KHÔNG múi (Prisma lưu UTC) ⇒ phải gắn UTC trước rồi mới đổi sang giờ VN — bỏ bước
  // gắn UTC là lùi 7 tiếng, dòng sau 17:00 VN ngày cuối tháng rơi nhầm tháng.
  const rows = await prisma.$queryRaw<DongThang[]>`
    SELECT to_char(("createTime" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM') AS thang,
           "transactionType", "billingType", "amountType",
           COUNT(*)::int AS so, COALESCE(SUM(amount), 0)::bigint AS tong
    FROM "TiktokAdsHoaDon"
    GROUP BY 1, 2, 3, 4
    ORDER BY 1, 2, 3, 4
  `;
  console.log("\n=== Σ hoá đơn theo tháng (giờ VN) × loại ===");
  console.table(
    rows.map((r) => ({
      thang: r.thang,
      loai: `${r.transactionType}|${r.billingType}|${r.amountType}`,
      so: r.so,
      tong: r.tong.toString(),
    })),
  );

  // Phần dư nợ thẻ đọc (xem `src/lib/no-phai-tra/du-no-the.ts`): BILL_PAYMENT + ADD_BALANCE, CASH.
  const [the] = await prisma.$queryRaw<{ so: number; tong: bigint }[]>`
    SELECT COUNT(*)::int AS so,
           COALESCE(SUM(CASE WHEN "amountType" = 'POSITIVE' THEN amount ELSE -amount END), 0)::bigint AS tong
    FROM "TiktokAdsHoaDon"
    WHERE "transactionType" IN ('BILL_PAYMENT', 'ADD_BALANCE') AND "billingType" = 'CASH'
  `;
  console.log(`\nΣ phần trừ phương thức thanh toán (BILL_PAYMENT|ADD_BALANCE, CASH, có dấu): ${the.tong} (${the.so} hoá đơn)`);

  if (stats.skipped > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
