/**
 * Nạp bù kho mẫu webhook Pancake vào bảng `RawPancakeWebhookEvent` (hộp thư thô).
 *
 *   npx tsx scripts/nap-kho-mau-webhook.ts --file-mau <thư-mục-webhook-samples> [--bang-cu <file.copy>] [--yes]
 *
 * Hai nguồn, chạy được riêng hoặc chung:
 *   --file-mau  thư mục n8n ghi ra từ pha 1 (`<shop>/<yyyyLLdd-HHmmss>-<id>.json`)   → source=`file`
 *   --bang-cu   khối COPY bảng `webhook_raw_events` hệ cũ (dump 2026-06-18)           → source=`db-cu`
 *
 * CHẠY LẠI ĐƯỢC: khoá (shopId, receivedAt, payloadHash) chặn nhân bản, dòng trùng chỉ đếm "bỏ qua".
 * KHÔNG transform, KHÔNG đụng Silver — chỉ thêm dòng vào hộp thư.
 *
 * ⚠️ Trên máy dev, `DATABASE_URL` trỏ THẲNG DB PROD → in DB đích + hỏi xác nhận trước khi ghi.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import { docKhoiCopyBangCu, docThuMucFileMau, type SuKienMau } from "./lib/doc-mau-webhook-pancake";

const envPath = path.resolve(process.cwd(), ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

function docCo(ten: string): string | undefined {
  const i = process.argv.indexOf(ten);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function moTaDbDich(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Thiếu DATABASE_URL — không biết ghi vào đâu.");
  const u = new URL(url);
  return `${u.host}${u.pathname} schema=${u.searchParams.get("schema") || "public"}`;
}

async function xacNhanGhi(soSuKien: number): Promise<boolean> {
  if (process.argv.includes("--yes")) return true;
  if (!process.stdin.isTTY) {
    process.exitCode = 1;
    console.error("Không phải TTY (container/CI) — chạy lại kèm cờ --yes để xác nhận.");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`Nạp ${soSuKien} sự kiện vào DB này? (y/N) `)).trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const thuMucFileMau = docCo("--file-mau");
  const fileBangCu = docCo("--bang-cu");
  if (!thuMucFileMau && !fileBangCu) {
    console.error("Cần ít nhất một nguồn: --file-mau <thư mục> và/hoặc --bang-cu <file .copy>");
    process.exitCode = 1;
    return;
  }

  const suKien: SuKienMau[] = [];
  const nguonCuaSuKien: ("file" | "db-cu")[] = [];

  if (thuMucFileMau) {
    const doc = docThuMucFileMau(path.resolve(thuMucFileMau));
    doc.forEach((s) => {
      suKien.push(s);
      nguonCuaSuKien.push("file");
    });
    console.log(`File mẫu pha 1: đọc được ${doc.length} sự kiện`);
  }

  if (fileBangCu) {
    const { suKien: cu, boQua } = docKhoiCopyBangCu(path.resolve(fileBangCu));
    cu.forEach((s) => {
      suKien.push(s);
      nguonCuaSuKien.push("db-cu");
    });
    console.log(`Bảng webhook_raw_events cũ: đọc được ${cu.length} sự kiện` + (boQua.length ? `, bỏ qua ${boQua.length}` : ""));
    boQua.slice(0, 5).forEach((b) => console.log("   - bỏ qua:", b));
  }

  console.log("DB đích:", moTaDbDich());
  if (!(await xacNhanGhi(suKien.length))) {
    console.log("Đã huỷ — không ghi gì.");
    return;
  }

  const { luuSuKienWebhook, laShopSlug, shopIdTheoSlug } = await import("@/lib/ingest/webhook-inbox");
  const { prisma } = await import("@/lib/prisma");

  let them = 0;
  let trung = 0;
  const shopLa = new Set<string>();
  try {
    for (const [i, s] of suKien.entries()) {
      if (!laShopSlug(s.shopSlug)) {
        shopLa.add(s.shopSlug);
        continue;
      }
      const shopId = await shopIdTheoSlug(s.shopSlug);
      const luu = await luuSuKienWebhook({
        shopId,
        payload: s.payload,
        receivedAt: s.receivedAt,
        source: nguonCuaSuKien[i],
      });
      luu.daGhi ? them++ : trung++;
    }
    console.log(`\nXong: thêm ${them} dòng, bỏ qua ${trung} dòng trùng.`);
    if (shopLa.size) console.log("Shop không nhận diện được (bỏ qua):", [...shopLa].join(", "));

    const tong = await prisma.rawPancakeWebhookEvent.groupBy({
      by: ["shopId", "source"],
      _count: { _all: true },
      _min: { receivedAt: true },
      _max: { receivedAt: true },
    });
    console.table(
      tong.map((t) => ({
        shopId: t.shopId,
        nguon: t.source,
        so_dong: t._count._all,
        som_nhat: t._min.receivedAt?.toISOString(),
        moi_nhat: t._max.receivedAt?.toISOString(),
      }))
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
