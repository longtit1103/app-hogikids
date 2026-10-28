/**
 * Tính lại "trả chưa lên sao kê" (`KySaoKeThe.saoKeTraChuaLen`) cho kỳ sao kê thẻ nhập từ PDF đã chốt TRƯỚC khi có cột.
 *
 * VÌ SAO: kỳ PDF có lần trả thẻ ngày ≤ ngày chốt mà ngân hàng ghi sổ sau ngày chốt (P) thì neo `soDu` đã trừ P nhưng số
 * sao kê vẫn gồm P ⇒ ngân hàng chỉ còn đòi `saoKeSoDu − P`. Cột NULL ⇒ app vẫn đòi theo neo (thừa đúng phần P khi kỳ có
 * cả bill ghi sổ trễ), số đó chảy vào dự báo quỹ "trả thẻ" và lý do không cho đóng thẻ. Migration KHÔNG điền số cho kỳ
 * cũ (không đoán); script này tính lại bằng ĐÚNG luật ghép lúc chốt (`ghepChiTraVoiSaoKe`, dòng sao kê đã lưu +
 * `CARD_PAY` của thẻ) để chủ shop duyệt từng kỳ.
 *
 * MẶC ĐỊNH LÀ XEM TRƯỚC — chỉ ĐỌC, in bảng kỳ PDF cột NULL + P tính lại + chi tiết từng lần trả:
 *   `npx tsx --env-file=.env scripts/tinh-lai-sao-ke-tra-chua-len.ts`            (máy dev — DATABASE_URL trong .env = PROD)
 *   `docker compose run --rm app npx --no-install tsx scripts/tinh-lai-sao-ke-tra-chua-len.ts`   (minipc)
 * Ghi thật — CHỈ các id đã duyệt, một transaction, khoá thẻ, nhật ký từng kỳ, không bao giờ ghi đè số đã có:
 *   `… scripts/tinh-lai-sao-ke-tra-chua-len.ts --apply --ids=<kyId>,<kyId> [--db=<tên DB>]`
 * Trước khi ghi script in DB đích (host/tên DB/schema, KHÔNG in mật khẩu) và đòi gõ lại TÊN DB; không có TTY (container)
 * thì bắt buộc `--db=<tên DB>` khớp đúng. Nhật ký ghi dưới tên chủ shop (tài khoản OWNER đang hoạt động, sớm nhất).
 *
 * Giành `khoaViecNang` khi ghi: không chạy chồng với xoá dữ liệu / dựng lại / phục hồi DB.
 * KHÔNG đụng neo, quỹ, P&L, dòng tiền — chỉ một cột của kỳ.
 */
import { createInterface } from "node:readline/promises";

import { giuKhoaViecNang, traKhoaViecNang } from "@/lib/backup/khoa-viec-nang";
import { formatVnd } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import {
  ghiTraChuaLenChoCacKy,
  lietKeKyCanTinhLai,
  type KetQuaTinhLai,
} from "@/lib/sao-ke-the/tinh-lai-tra-chua-len-sao-ke";

const CO_HOP_LE = ["--apply"];
const TIEN_TO_THAM_SO = ["--ids=", "--db="];

function docThamSo(ten: string): string | undefined {
  const tienTo = `--${ten}=`;
  return process.argv.find((a) => a.startsWith(tienTo))?.slice(tienTo.length);
}

/** Cờ gõ sai (`--aply`, `--ids a,b`) mà im lặng thành xem trước = người chạy tưởng đã ghi. */
function kiemCoDongLenh(): void {
  const la = process.argv.slice(2).filter((a) => !CO_HOP_LE.includes(a) && !TIEN_TO_THAM_SO.some((t) => a.startsWith(t)));
  if (la.length > 0) throw new Error(`Cờ không nhận ra: ${la.join(" ")}. Chỉ có --apply · --ids=a,b · --db=<tên DB>`);
}

/** DB đích KHÔNG kèm credential: host + tên DB + schema (sau gộp DB, chỉ `schema` nói lên đích thật). */
function dbDich(): { moTa: string; tenDb: string } {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Thiếu DATABASE_URL — không biết đọc/ghi vào đâu.");
  const u = new URL(url);
  const tenDb = decodeURIComponent(u.pathname.replace(/^\//, ""));
  const schema = u.searchParams.get("schema") || "public";
  return { moTa: `${u.host}/${tenDb} schema=${schema}`, tenDb };
}

function inBang(ds: readonly KetQuaTinhLai[]): void {
  console.table(
    ds.map((k) => ({
      kyId: k.kyId,
      the: k.cardId,
      ngayChot: k.ngayChot,
      saoKe: k.saoKeSoDu,
      billGhiSoTre: k.saoKeTongBillGhiSoTre,
      neo: k.soDu,
      "neo−saoKe−bill": k.neoTruSaoKeVaBill,
      traChuaLen: k.tong,
      nghiaVuMoi: Math.max(0, Math.min(k.saoKeSoDu - k.tong, k.soDu)),
      nghiaVuCu: Math.min(k.saoKeSoDu, k.soDu),
    })),
  );
  for (const k of ds) {
    if (k.traChuaLen.length === 0) continue;
    console.log(`Kỳ ${k.kyId} (${k.ngayChot}) — lần trả chưa lên sao kê:`);
    for (const g of k.traChuaLen) console.log(`  · CARD_PAY ${g.id} ngày ${g.ngay} ${formatVnd(g.soTien)}`);
  }
}

/** Gõ lại tên DB (TTY) hoặc `--db=` (không TTY) — chặn lỡ tay ghi nhầm DB. */
async function xacNhanTenDb(tenDb: string): Promise<boolean> {
  const coDb = docThamSo("db");
  if (coDb !== undefined) return coDb === tenDb;
  if (!process.stdin.isTTY) {
    console.error("Không phải TTY (container/CI) — chạy lại kèm --db=<tên DB> để xác nhận.");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`Gõ lại TÊN DB để ghi (${tenDb}): `)).trim() === tenDb;
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  kiemCoDongLenh();
  const { moTa, tenDb } = dbDich();
  console.log("DB đích:", moTa);

  const ghi = process.argv.includes("--apply");
  if (!ghi) {
    const ds = await lietKeKyCanTinhLai(prisma);
    console.log(`\n=== XEM TRƯỚC — KHÔNG ghi gì: ${ds.length} kỳ sao kê PDF chưa có "trả chưa lên sao kê" ===`);
    if (ds.length === 0) return;
    inBang(ds);
    console.log(
      '\n"neo−saoKe−bill" = chi thẻ chưa lên − trả chưa lên lúc chốt (khi không sửa số chốt) — đối chiếu với traChuaLen.' +
        "\nDuyệt xong, ghi đúng các kỳ đã duyệt: --apply --ids=<kyId>,<kyId>",
    );
    return;
  }

  const ids = (docThamSo("ids") ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (ids.length === 0) throw new Error("--apply cần --ids=<kyId>,<kyId> (danh sách kỳ chủ shop đã duyệt ở lượt xem trước).");

  const chu = await prisma.user.findFirst({
    where: { role: "OWNER", isActive: true },
    orderBy: { createdAt: "asc" },
    select: { id: true, email: true },
  });
  if (!chu) throw new Error("Không có tài khoản chủ shop (OWNER) đang hoạt động để đứng tên nhật ký.");

  console.log(`Sẽ ghi ${ids.length} kỳ: ${ids.join(", ")} · nhật ký đứng tên ${chu.email}`);
  if (!(await xacNhanTenDb(tenDb))) {
    process.exitCode = 1;
    console.error("Tên DB không khớp — KHÔNG ghi gì.");
    return;
  }

  const khoa = await giuKhoaViecNang("tính lại trả chưa lên sao kê (script)");
  if (!khoa.the) {
    process.exitCode = 1;
    console.error(`Đang có "${khoa.dangGiu}" chạy — chờ xong rồi chạy lại.`);
    return;
  }
  try {
    const kq = await ghiTraChuaLenChoCacKy(prisma, ids, chu);
    console.log(`\n=== ĐÃ GHI ${kq.ghi.length} kỳ ===`);
    if (kq.ghi.length > 0) inBang(kq.ghi);
    if (kq.boQua.length > 0) {
      console.warn(`\n${kq.boQua.length} kỳ bỏ qua:`);
      for (const b of kq.boQua) console.warn(`  ⚠ ${b.kyId}: ${b.lyDo}`);
      // Chạy lại kỳ đã ghi là no-op hợp lệ; id sai / không phải kỳ PDF thì báo lỗi qua exit code.
      if (kq.boQua.some((b) => !b.lyDo.startsWith("đã có số"))) process.exitCode = 1;
    }
  } finally {
    await traKhoaViecNang(khoa.the);
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
