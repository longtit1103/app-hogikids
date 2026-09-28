/**
 * Backfill kết cục Silver cho kho dữ liệu cũ (`RawPancakeOrder.silverOutcome = 'LEGACY'`).
 *
 * Thử (KHÔNG ghi gì):  npx tsx scripts/backfill-ket-cuc-legacy.ts
 * Ghi thật (prod):     docker compose run --rm app npx tsx scripts/backfill-ket-cuc-legacy.ts --ghi --yes
 * Ghi thật (local):    npx tsx scripts/backfill-ket-cuc-legacy.ts --ghi     (hỏi y/N trước khi ghi)
 *
 * MẶC ĐỊNH LÀ LƯỢT THỬ. Không có `--ghi` thì script chỉ ĐỌC và in ra sẽ làm gì — chạy nhầm trên
 * prod cũng không đổi một dòng nào.
 *
 * VÌ SAO CẦN: migration `20260811110000` đặt nhãn `LEGACY` cho mọi dòng có trước nó — nghĩa là
 * "chưa ai kiểm", không phải một kết cục. Lượt đối soát đêm CỐ Ý không đụng tới chúng, nên chừng
 * nào còn `LEGACY` thì câu hỏi "có đơn nào kẹt Bronze không" vẫn chưa có lời đáp cho phần lịch sử.
 *
 * AN TOÀN: chỉ dựng ĐƠN (không products/tồn kho/chi phí quảng cáo như lượt "Dựng lại từ kho thô"),
 * bằng chính `transformFromRaw("orders")` nên cùng luật mirror và cùng CAS mốc nguồn. Chạy lại lần
 * hai là no-op: hết `LEGACY` thì không còn việc.
 *
 * ⚠️ Trên máy dev, `DATABASE_URL` trỏ THẲNG vào DB PROD (chỉ có 1 DB thật) → script LUÔN in DB đích
 * và hỏi xác nhận trước khi ghi. Không TTY (container/CI) thì bắt buộc truyền `--yes`.
 *
 * CỔNG CHẶN (chỉ ở chế độ ghi): từ chối khi nhật ký còn một lượt PANCAKE `RUNNING` chưa quá 15
 * phút; giành `khoaViecNang` để không chạy song song với xoá dữ liệu / dựng lại / phục hồi DB, giữ
 * khoá tươi bằng checkpoint tiến độ thật, và trả khoá trong `finally`.
 *
 * EXIT CODE: `1` khi lượt ghi LỖI, hoặc khi sau lượt ghi vẫn CHƯA SẠCH (còn `LEGACY`, còn đơn dở
 * quá hạn, hoặc còn đơn cần người xem). Ba ngả in ba thông báo khác nhau vì cách xử khác nhau.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import type {
  KetQuaBackfillLegacy,
  KhaoSatLegacy,
} from "@/lib/bronze/backfill-ket-cuc-legacy";

// Script standalone không đi qua Next auto-load .env → nạp bằng loader built-in của Node (≥20.6).
// Biến môi trường ĐÃ set (vd DATABASE_URL của container prod) được ưu tiên.
const envPath = path.resolve(process.cwd(), ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

/**
 * In DB đích KHÔNG kèm credential (URL chứa user:password — chỉ lấy host + tên DB). Kèm `?schema=`
 * vì sau khi gộp app+test chung 1 DB `postgres`, chỉ `schema` mới nói lên đích thật.
 */
function moTaDbDich(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Thiếu DATABASE_URL — không biết đọc/ghi vào đâu.");
  const u = new URL(url);
  const schema = u.searchParams.get("schema") || "public";
  return `${u.host}${u.pathname} schema=${schema}`;
}

/** Chặn lỡ tay ghi lên DB PROD từ máy dev. `--yes` để chạy không tương tác. */
async function xacNhanGhi(ks: KhaoSatLegacy): Promise<boolean> {
  if (!process.stdin.isTTY) {
    // Không hỏi được ⇒ lỗi cấu hình, không phải "người dùng từ chối" → báo qua exit code.
    process.exitCode = 1;
    console.error("Không phải TTY (container/CI) — chạy lại kèm cờ --yes để xác nhận.");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const tl = await rl.question(
      `Backfill ${ks.legacyMoiNhat} đơn LEGACY (ghi đè Order/OrderItem) trên DB này? Sổ đang có ` +
        `${ks.tienSo.soDon} đơn.\nChỉ gõ y khi ĐÃ có bản backup tươi đã verify, và CHẮC CHẮN không ` +
        "có lượt phục hồi dữ liệu nào đang chạy trong app. (y/N) ",
    );
    return tl.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

/** Cờ hợp lệ. Gõ sai (`--ghi=1`, `-ghi`) mà im lặng thành lượt thử = người chạy tưởng đã ghi. */
const CO_HOP_LE = ["--ghi", "--yes"];
function kiemCoDongLenh(): void {
  const la = process.argv
    .slice(2)
    .filter((a) => !CO_HOP_LE.includes(a) && !a.startsWith("--lo="));
  if (la.length) throw new Error(`Cờ không nhận ra: ${la.join(" ")}. Chỉ có --ghi · --yes · --lo=N`);
}

function inKhaoSat(nhan: string, ks: KhaoSatLegacy): void {
  console.log(`\n=== ${nhan} ===`);
  console.log("Kết cục theo ĐƠN (bản mới nhất mỗi đơn):");
  console.table(ks.theoDonMoiNhat);
  console.log("Kết cục theo DÒNG (cả bản cũ):");
  console.table(ks.theoDong);
  console.log(
    `LEGACY: ${ks.legacyMoiNhat} đơn (bản mới nhất) · ${ks.legacyBanCu} bản cũ sẽ đóng SUPERSEDED · ` +
      `${ks.legacyTongDong} dòng tổng`,
  );
  console.log(
    `Đơn chưa đóng dấu: ${ks.nullMoiNhat} (quá hạn: ${ks.nullQuaHan}) · cần người xem: ${ks.canXem}`,
  );
  console.log("Tiền trong Sổ:");
  console.table(ks.tienSo);
  if (ks.legacyTheoShop.length) {
    console.log("LEGACY theo shop:");
    console.table(ks.legacyTheoShop);
  }
}

/** Đọc `--lo=N`. Giá trị rác phải KÊU TO — nuốt im lặng rồi chạy bằng mặc định là đánh lừa người chạy. */
function docCoLo(): number | undefined {
  const tho = process.argv.find((a) => a.startsWith("--lo="))?.slice("--lo=".length);
  if (tho === undefined) return undefined;
  const n = Number(tho);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--lo="${tho}" không phải số nguyên dương.`);
  return n;
}

// import ĐỘNG (không static): `src/lib/prisma.ts` đọc `process.env.DATABASE_URL` ngay lúc nạp
// module, mà import static bị hoist lên TRƯỚC `loadEnvFile` ở trên → client nối sai DB. Nạp .env
// xong mới import.
async function main(): Promise<void> {
  kiemCoDongLenh();
  console.log("DB đích:", moTaDbDich());

  const { khaoSatLegacy } = await import("@/lib/bronze/backfill-ket-cuc-legacy");
  const { prisma } = await import("@/lib/prisma");

  try {
    const truoc = await khaoSatLegacy();
    const ghi = process.argv.includes("--ghi");

    if (!ghi) {
      inKhaoSat("LƯỢT THỬ — KHÔNG ghi gì", truoc);
      console.log(
        `\nSẽ transform ${truoc.legacyMoiNhat} đơn (theo lô, gom theo shop) rồi đóng ` +
          `${truoc.legacyBanCu} bản cũ thành SUPERSEDED.\nChạy lại kèm --ghi để thực hiện.`,
      );
      return;
    }

    if (truoc.hetLegacy) {
      inKhaoSat("Không còn việc", truoc);
      console.log("\nKhông còn dòng LEGACY nào — không có gì để backfill.");
      if (truoc.canXem > 0) {
        console.warn(
          `Vẫn còn ${truoc.canXem} đơn cần người xem (từ trước lượt này) — xem panel ở /cai-dat.`,
        );
      }
      return;
    }

    const { coLuotDangChay, withSyncLog } = await import("@/lib/ingest/sync-log");

    // Cổng chặn TRƯỚC khi hỏi: đừng bắt người ta gõ y rồi mới báo là không chạy được.
    if (await coLuotDangChay("PANCAKE")) {
      process.exitCode = 1;
      console.error(
        "Đang có lượt đồng bộ / dựng lại khác chạy (SyncLog PANCAKE còn RUNNING) — chờ xong rồi " +
          "chạy lại. Log treo quá 15 phút tự bị chuyển ERROR nên không cần gỡ tay.",
      );
      return;
    }

    inKhaoSat("TRƯỚC lượt ghi", truoc);
    if (!process.argv.includes("--yes") && !(await xacNhanGhi(truoc))) {
      console.log("Đã huỷ — không ghi gì.");
      return;
    }

    // GIÀNH KHOÁ SAU khi người dùng xác nhận, và giành NGUYÊN TỬ ở DB — `coLuotDangChay` phía trên
    // chỉ là phép KIỂM, giữa lúc kiểm và lúc chạy còn cả quãng chờ người gõ "y".
    const { giuKhoaViecNang, traKhoaViecNang, taoCheckpoint } = await import(
      "@/lib/backup/khoa-viec-nang"
    );
    const khoa = await giuKhoaViecNang("backfill kết cục LEGACY (script)");
    if (!khoa.the) {
      process.exitCode = 1;
      console.error(`Đang có "${khoa.dangGiu}" chạy — chờ xong rồi chạy lại.`);
      return;
    }
    // Khoá có HẠN để một tiến trình chết không khoá vĩnh viễn ⇒ chủ khoá phải tự gia hạn, và gia
    // hạn bằng CHECKPOINT gắn với tiến độ thật chứ không phải timer nền (timer sống độc lập với
    // công việc: việc treo cứng mà timer vẫn chạy sẽ giữ khoá vô hạn).
    const the = khoa.the;
    const checkpoint = taoCheckpoint(the);

    try {
      const { chayBackfillLegacy, tienDaDoi } = await import(
        "@/lib/bronze/backfill-ket-cuc-legacy"
      );
      let canhBao: string[] = [];
      let kq: KetQuaBackfillLegacy | undefined;
      const t0 = Date.now();
      const lo = docCoLo();

      // Bọc `withSyncLog` để chính lượt này cắm cờ RUNNING cho những đường CÓ soi cờ (nút "Dựng lại
      // từ kho thô", cổng 409 của lượt phục hồi), và để cảnh báo được LƯU vào nhật ký đồng bộ thay
      // vì chỉ in ra rồi mất theo phiên ssh.
      const res = await withSyncLog("PANCAKE", async (warnings) => {
        kq = await chayBackfillLegacy(warnings, { checkpoint, ...(lo ? { lo } : {}) });
        // GÁN chứ không `push(...)`: lượt 1299 đơn đẻ hàng nghìn cảnh báo (mỗi item không khớp
        // variant một dòng), spread quá ~65k phần tử là `RangeError` — hỏng đúng lượt đang chạy.
        canhBao = warnings;
        return {
          nguon: "script-backfill-legacy",
          soLo: kq.soLo,
          banCuDaDong: kq.banCuDaDong,
          ketCucDaThu: kq.ketCucDaThu,
          mirrorConTrongSo: kq.mirrorConTrongSo,
          legacyTruoc: kq.truoc.legacyTongDong,
          legacyConLai: kq.sau.legacyTongDong,
          tienTruoc: kq.truoc.tienSo,
          tienSau: kq.sau.tienSo,
          donKet: kq.donKet.map((d) => `${d.shopId}/${d.externalId}`),
          hetLegacy: kq.sau.hetLegacy,
        };
      });

      // `withSyncLog` viết cho route handler nên trả `Response` và BẮT lỗi thay vì ném ⇒ phải đọc
      // body rồi tự đặt exit code. Thiếu đoạn này thì lượt hỏng vẫn exit 0.
      const body = (await res.json()) as
        | { ok: true; stats: Record<string, unknown> }
        | { ok: false; error: string; stats?: { warnings?: string[] } };
      if (!body.ok) {
        process.exitCode = 1;
        console.error("Backfill LỖI:", body.error);
        // Lượt HỎNG mới đúng là lượt cần chẩn đoán nhất — `withSyncLog` giữ cảnh báo lại ở nhánh
        // lỗi chính vì thế; vứt chúng đi ở tầng CLI là tái lập đúng lỗ đó.
        const wLoi = body.stats?.warnings ?? [];
        if (wLoi.length) {
          console.error(`${wLoi.length} cảnh báo trước khi hỏng:`);
          wLoi.slice(0, 20).forEach((w) => console.error("  -", w));
        }
        return;
      }

      // Đọc từ CHÍNH ảnh chụp lượt chạy, không khảo sát lại: hai lần đo là hai thời điểm, in cạnh
      // nhau mà lệch thì người đọc không biết tin bảng nào.
      if (!kq) throw new Error("Lượt chạy báo ok nhưng không trả kết quả — không thể nghiệm thu.");
      const ketQua = kq;
      console.log("\nXong sau", ((Date.now() - t0) / 1000).toFixed(1), "giây");
      inKhaoSat("SAU lượt ghi", ketQua.sau);
      console.log("\nSố liệu lượt chạy:");
      console.table({
        soLo: ketQua.soLo,
        banCuDaDong: ketQua.banCuDaDong,
        legacyTruoc: ketQua.truoc.legacyTongDong,
        legacyConLai: ketQua.sau.legacyTongDong,
      });
      console.log("Kết cục các đơn đã thử:");
      console.table(ketQua.ketCucDaThu);
      console.log("Tiền TRƯỚC / SAU (bằng chứng lượt này chỉ dán nhãn):");
      console.table(
        (["soDon", "itemsTotal", "discount", "platformFeeEst", "returnedFee"] as const).map((k) => ({
          truong: k,
          truoc: ketQua.truoc.tienSo[k],
          sau: ketQua.sau.tienSo[k],
          delta: ketQua.sau.tienSo[k] - ketQua.truoc.tienSo[k],
        })),
      );

      // Mỗi ngả "chưa xong" có một cách xử KHÁC NHAU — đừng gộp thành một câu chung chung.
      if (!ketQua.sau.hetLegacy) {
        process.exitCode = 1;
        console.error(
          `\nCÒN ${ketQua.sau.legacyTongDong} dòng LEGACY — lượt này không dựng nổi chúng. Xem cảnh ` +
            `báo bên dưới, sửa mapping rồi chạy lại. Mẫu: ${ketQua.donKet
              .slice(0, 5)
              .map((d) => `${d.shopId}/${d.externalId}`)
              .join(", ")}`,
        );
      }
      // Tiền ĐƯỢC PHÉP đổi đúng một ngả: backfill dựng lại đơn từng KẸT ngoài Sổ — chính là việc
      // D-01 sinh ra để làm. Ngả còn lại (số đơn y nguyên mà tiền vẫn đổi) nghĩa là mapping hiện
      // hành cho ra số KHÁC payload cũ trên đơn đã có — đó mới là thứ phải dừng lại mà truy.
      // Hạn chế đã biết: một lượt vừa dựng đơn mới vừa đổi số đơn cũ thì hai chiều bù nhau và chỉ
      // nhìn được qua bảng TRƯỚC/SAU ở trên, không tự bắt được.
      const donMoi = ketQua.sau.tienSo.soDon - ketQua.truoc.tienSo.soDon;
      if (tienDaDoi(ketQua.truoc.tienSo, ketQua.sau.tienSo)) {
        if (donMoi > 0) {
          console.warn(
            `\nTiền trong Sổ ĐỔI vì lượt này dựng lại ${donMoi} đơn từng kẹt ngoài Sổ (đúng việc của ` +
              "D-01). Đối chiếu bảng TRƯỚC/SAU ở trên với số đơn cứu được.",
          );
        } else {
          process.exitCode = 1;
          console.error(
            "\nTIỀN TRONG SỔ ĐÃ ĐỔI mà KHÔNG có đơn nào được dựng thêm — tức mapping hiện hành cho " +
              "ra số khác payload cũ trên đơn ĐÃ CÓ. Dừng lại và truy trước khi đi tiếp.",
          );
        }
      }
      // Chỉ tính phần lượt NÀY sinh ra. Tồn đọng có sẵn là việc của lượt đối soát đêm — bắt lượt
      // backfill thoát mã lỗi vì nó là bắt oan, và người vận hành sẽ quen tay bỏ qua exit 1.
      if (ketQua.sau.canXem > ketQua.truoc.canXem) {
        process.exitCode = 1;
        console.error(
          `\n${ketQua.sau.canXem - ketQua.truoc.canXem} đơn MỚI mang kết cục CẦN NGƯỜI XEM (payload ` +
            "không map được) — xem panel ở /cai-dat, sửa mapping rồi dựng lại từ kho thô.",
        );
      } else if (ketQua.sau.canXem > 0) {
        console.warn(
          `\nCó sẵn ${ketQua.sau.canXem} đơn cần người xem từ trước lượt này — không phải do backfill.`,
        );
      }
      if (ketQua.sau.nullQuaHan > 0) {
        console.warn(
          `\n${ketQua.sau.nullQuaHan} đơn chưa đóng dấu và đã quá hạn — việc của lượt đối soát ĐÊM, ` +
            "không phải của backfill. Kiểm lượt nightly gần nhất.",
        );
      }
      if (ketQua.mirrorConTrongSo > 0) {
        process.exitCode = 1;
        console.error(
          `\n${ketQua.mirrorConTrongSo} đơn bị luật loại nhưng VẪN nằm trong Sổ — doanh thu có thể ` +
            "đếm 2 lần. Phải xoá tay (đơn bù từ bản sao kho đã được trừ ra khỏi phép đếm này).",
        );
      }
      if (process.exitCode !== 1) {
        console.log(
          donMoi > 0
            ? `\nSẠCH: hết dòng LEGACY; Sổ nhận thêm ${donMoi} đơn từng kẹt.`
            : "\nSẠCH: hết dòng LEGACY, tiền trong Sổ không đổi một đồng.",
        );
      }

      if (canhBao.length) {
        console.log(`\n${canhBao.length} cảnh báo:`);
        canhBao.slice(0, 20).forEach((w) => console.log("  -", w));
      }
    } finally {
      await traKhoaViecNang(the);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("Backfill LỖI:", e);
  process.exit(1);
});
