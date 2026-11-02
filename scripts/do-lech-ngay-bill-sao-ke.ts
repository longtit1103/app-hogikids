/**
 * ĐO (CHỈ ĐỌC) độ lệch NGÀY giữa dòng "9PAY*TikTok Ads" trên sao kê thẻ Techcombank (file PDF) và hoá đơn TikTok trong
 * app (`TiktokAdsHoaDon.createTime`, khoá ngày giờ VN) — số liệu để chủ shop chốt có đổi luật ghép bill ↔ sao kê hay
 * không. Luật hiện tại (`doi-chieu-sao-ke-the.ts`): ĐÚNG ngày giao dịch + ĐÚNG số tiền; bill lệch ngày rơi vào "ghi sổ
 * trễ" và CỘNG thừa vào số đề xuất.
 *
 *   Máy dev:  npx tsx scripts/do-lech-ngay-bill-sao-ke.ts <sao-ke-1.pdf> [<sao-ke-2.pdf> …]
 *   minipc:   docker compose run --rm -v <thư mục chứa PDF>:/sao-ke:ro app \
 *               npx --no-install tsx scripts/do-lech-ngay-bill-sao-ke.ts /sao-ke/<file>.pdf
 *
 * CHỈ ĐỌC: không ghi DB, không ghi file, không giành khoá. `--dry-run` nhận cho rõ ý (mặc định đã chỉ đọc — script
 * KHÔNG có chế độ ghi). KHÔNG in số thẻ, tên chủ thẻ, merchant hay diễn giải: chỉ ngày, giờ, số tiền, số đếm. PDF thật
 * KHÔNG commit vào repo.
 *
 * Hoá đơn lấy ĐÚNG đường đối chiếu lúc nhập sao kê dùng (`docBillTiktokChoSaoKe`: hoá đơn trừ thẻ, đã bỏ phần ví
 * TikTok Shop trả) cho thẻ gánh TikTok Ads ngày sao kê. In mỗi sao kê:
 *  1. số dòng TikTok ghi nợ; số ghép ĐÚNG ngày + đúng tiền (luật hiện tại);
 *  2. dòng không ghép đúng ngày mà có hoá đơn cùng tiền lệch 1–2 ngày (ngày in ≠ ngày `createTime` VN) — kèm giờ
 *     `createTime` VN để thấy có phải biên nửa đêm, và số hoá đơn ứng viên ở khoảng lệch gần nhất;
 *  3. số nhóm (ngày, số tiền) có ≥ 2 dòng sao kê — nơi ghép có dung sai dễ ghép nhầm.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// Script standalone không đi qua Next auto-load .env → nạp bằng loader built-in của Node (≥20.6). Biến môi trường
// ĐÃ set (vd DATABASE_URL của container prod) được ưu tiên.
const envPath = path.resolve(process.cwd(), ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

const MOT_NGAY_MS = 24 * 3600 * 1000;
/** Khoảng lệch ngày tối đa soi (dòng sao kê ↔ hoá đơn cùng tiền). */
const LECH_SOI_TOI_DA = 2;

/** Định danh DB đích KHÔNG kèm credential: host + tên DB + schema. */
function docDbDich(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Thiếu DATABASE_URL — không biết đọc vào đâu.");
  const u = new URL(url);
  return `${u.host}/${decodeURIComponent(u.pathname.replace(/^\//, ""))} schema=${u.searchParams.get("schema") || "public"}`;
}

/** Đường dẫn PDF (đối số không mở đầu `--`). Cờ lạ ⇒ báo lỗi, không im lặng. */
function docThamSo(): string[] {
  const pdfs: string[] = [];
  for (const a of process.argv.slice(2)) {
    if (a === "--dry-run") continue;
    if (a.startsWith("--")) throw new Error(`Cờ không nhận ra: ${a}. Chỉ có --dry-run (mặc định, script chỉ đọc).`);
    pdfs.push(path.resolve(a));
  }
  if (pdfs.length === 0) throw new Error("Thiếu đường dẫn file PDF sao kê. Dùng: npx tsx scripts/do-lech-ngay-bill-sao-ke.ts <a.pdf> [b.pdf]");
  for (const p of pdfs) if (!existsSync(p)) throw new Error(`Không thấy file: ${p}`);
  return pdfs;
}

const congNgay = (khoa: string, n: number): string =>
  new Date(Date.parse(`${khoa}T00:00:00Z`) + n * MOT_NGAY_MS).toISOString().slice(0, 10);
const lechNgay = (a: string, b: string): number => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / MOT_NGAY_MS);
/** Giờ VN `HH:mm:ss` của một thời điểm. */
const gioVn = (d: Date): string => new Date(d.getTime() + 7 * 3600 * 1000).toISOString().slice(11, 19);

type DongTiktok = { ngay: string; soTien: number };
type Bill = { id: string; ngay: string; soTien: number; createTime: Date };

type CaLech = { ngayIn: string; ngayBill: string; gioBillVn: string; soTien: number; lech: number; soUngVien: number };

/**
 * Ghép đúng luật hiện tại (multiset theo ngày + tiền), rồi soi phần dư: mỗi dòng còn lại lấy hoá đơn còn lại cùng tiền
 * lệch nhỏ nhất (≤ `LECH_SOI_TOI_DA`), hoà thì hoá đơn sớm hơn. Chỉ để ĐẾM — không phải luật ghép mới.
 */
function doLech(dongs: DongTiktok[], bills: Bill[]) {
  const kho = new Map<string, Bill[]>();
  for (const b of [...bills].sort((x, y) => x.createTime.getTime() - y.createTime.getTime())) {
    const k = `${b.ngay}|${b.soTien}`;
    kho.set(k, [...(kho.get(k) ?? []), b]);
  }
  let dungNgay = 0;
  const dongDu: DongTiktok[] = [];
  for (const d of dongs) {
    if (kho.get(`${d.ngay}|${d.soTien}`)?.shift()) dungNgay += 1;
    else dongDu.push(d);
  }
  const billDu = [...kho.values()].flat();
  const daDung = new Set<string>();
  const caLech: CaLech[] = [];
  let khongUngVien = 0;
  for (const d of [...dongDu].sort((x, y) => x.ngay.localeCompare(y.ngay))) {
    const ungVien = billDu
      .filter((b) => !daDung.has(b.id) && b.soTien === d.soTien)
      .map((b) => ({ b, l: Math.abs(lechNgay(d.ngay, b.ngay)) }))
      .filter((x) => x.l >= 1 && x.l <= LECH_SOI_TOI_DA)
      .sort((x, y) => x.l - y.l || x.b.createTime.getTime() - y.b.createTime.getTime());
    if (ungVien.length === 0) {
      khongUngVien += 1;
      continue;
    }
    const { b } = ungVien[0];
    daDung.add(b.id);
    caLech.push({
      ngayIn: d.ngay,
      ngayBill: b.ngay,
      gioBillVn: gioVn(b.createTime),
      soTien: d.soTien,
      lech: lechNgay(d.ngay, b.ngay),
      soUngVien: ungVien.filter((x) => x.l === ungVien[0].l).length,
    });
  }

  const demNhom = new Map<string, number>();
  for (const d of dongs) demNhom.set(`${d.ngay}|${d.soTien}`, (demNhom.get(`${d.ngay}|${d.soTien}`) ?? 0) + 1);
  const nhomTrung = [...demNhom.values()].filter((n) => n >= 2);

  return {
    dungNgay,
    caLech,
    khongUngVien,
    billKhongDong: billDu.length - daDung.size,
    soNhomTrung: nhomTrung.length,
    soDongTrongNhomTrung: nhomTrung.reduce((s, n) => s + n, 0),
  };
}

// import ĐỘNG: `src/lib/prisma.ts` đọc `DATABASE_URL` ngay lúc nạp module, import static bị hoist TRƯỚC
// `loadEnvFile` ở trên → client nối sai DB.
async function main(): Promise<void> {
  const pdfs = docThamSo();
  console.log("CHỈ ĐỌC — DB:", docDbDich());

  const { prisma } = await import("@/lib/prisma");
  const { docTextPdf } = await import("@/lib/sao-ke-the/doc-text-pdf");
  const { parseSaoKeTechcombank } = await import("@/lib/sao-ke-the/techcombank-sao-ke-parser");
  const { docNguCanhLoc } = await import("@/lib/no-phai-tra/doc-ngu-canh-loc");
  const { docBillTiktokChoSaoKe, theGanhHoaDonTiktok } = await import("@/lib/no-phai-tra/doi-chieu-sao-ke-voi-app");

  try {
    const ctx = await docNguCanhLoc();
    for (const [i, p] of pdfs.entries()) {
      const nhan = `Sao kê #${i + 1}`;
      const kq = parseSaoKeTechcombank(await docTextPdf(new Uint8Array(readFileSync(p))));
      if (!kq.ok) {
        process.exitCode = 1;
        // Lỗi parser có thể trích nguyên dòng sao kê (kèm merchant) trong ngoặc kép ⇒ che phần trích.
        console.error(`${nhan}: không tách được — ${kq.loi.replace(/"[^"]*"/g, '"…"')}`);
        continue;
      }
      const sk = kq.saoKe;
      const cardId = theGanhHoaDonTiktok(ctx, new Date(`${sk.ngaySaoKe}T23:59:59+07:00`));
      if (cardId === null) {
        process.exitCode = 1;
        console.error(`${nhan} (${sk.ngaySaoKe}): không có thẻ gánh TikTok Ads (chưa bật Nợ phải trả / chưa gắn thẻ) — bỏ qua.`);
        continue;
      }
      const dongs: DongTiktok[] = sk.dong
        .filter((d) => d.laTiktok && d.ghiNo > 0)
        .map((d) => ({ ngay: d.ngayGiaoDich, soTien: d.ghiNo }));
      const tu = congNgay(
        dongs.reduce((m, d) => (d.ngay < m ? d.ngay : m), sk.ngaySaoKe),
        -LECH_SOI_TOI_DA
      );
      const { bills, viTraDaBo } = await docBillTiktokChoSaoKe(prisma, cardId, tu, congNgay(sk.ngaySaoKe, 1), ctx);
      const thoiDiem = new Map(
        (
          await prisma.tiktokAdsHoaDon.findMany({
            where: { id: { in: bills.map((b) => b.id) } },
            select: { id: true, createTime: true },
          })
        ).map((h) => [h.id, h.createTime])
      );
      const r = doLech(
        dongs,
        bills.flatMap((b) => {
          const createTime = thoiDiem.get(b.id);
          return createTime === undefined ? [] : [{ ...b, createTime }];
        })
      );

      console.log(`\n=== ${nhan}: ngày sao kê ${sk.ngaySaoKe}, hoá đơn app ${tu} → ${congNgay(sk.ngaySaoKe, 1)} ===`);
      console.log(`Dòng TikTok ghi nợ trên sao kê: ${dongs.length}`);
      console.log(`Ghép ĐÚNG ngày + đúng tiền (luật hiện tại): ${r.dungNgay}`);
      console.log(`Dòng lệch ngày (có hoá đơn cùng tiền lệch 1–${LECH_SOI_TOI_DA} ngày): ${r.caLech.length}`);
      console.log(`  trong đó có ≥ 2 hoá đơn ứng viên cùng khoảng lệch (dễ ghép nhầm): ${r.caLech.filter((c) => c.soUngVien >= 2).length}`);
      console.log(`Dòng không có hoá đơn nào (kể cả lệch ≤ ${LECH_SOI_TOI_DA} ngày): ${r.khongUngVien}`);
      console.log(`Hoá đơn app không ứng dòng nào (thường: ghi sổ sau ngày sao kê / kỳ sau): ${r.billKhongDong}`);
      console.log(`Hoá đơn ví TikTok Shop trả đã bỏ (không lên sao kê): ${viTraDaBo.soLan}`);
      console.log(`Nhóm (ngày, số tiền) có ≥ 2 dòng sao kê: ${r.soNhomTrung} nhóm / ${r.soDongTrongNhomTrung} dòng`);
      if (r.caLech.length > 0) console.table(r.caLech);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
