/**
 * Dựng lại Silver từ Bronze — KHÔNG fetch lại Pancake.
 * Dùng sau khi sửa mapping / luật lọc mirror / thêm field.
 *
 * Prod:  docker compose run --rm app npx tsx scripts/rebuild-from-raw.ts --yes
 * Local: npx tsx scripts/rebuild-from-raw.ts        (hỏi y/N trước khi ghi)
 *
 * AN TOÀN: KHÔNG đụng Variant.costPrice / lowStockThreshold, cũng KHÔNG đụng chi phí chủ shop NHẬP
 * TAY (`Expense` source MANUAL/RECURRING/IMPORT) — những thứ đó không có nguồn nào để dựng lại.
 * Phần `Expense` DUY NHẤT lượt này ghi là chi tiêu quảng cáo (`source=ADS_API`), dựng lại từ bản gốc
 * báo cáo Meta/TikTok trong kho thô theo đúng khoá `refId` nên chạy lại không nhân bản chi phí.
 *
 * ⚠️ Trên máy dev, `DATABASE_URL` trỏ THẲNG vào DB PROD (chỉ có 1 DB thật) → script LUÔN in DB
 * đích và hỏi xác nhận trước khi ghi. Không TTY (container/CI) thì bắt buộc truyền `--yes`.
 *
 * CỔNG CHẶN: lệnh này từ chối chạy khi nhật ký còn một lượt PANCAKE `RUNNING` chưa quá 15 phút, và
 * tự cắm cờ `RUNNING` suốt lượt chạy để các đường ghi khác trong app tránh đường.
 *
 * EXIT CODE: `1` khi lượt dựng lại LỖI, và cũng `1` khi cờ backlog VẪN BẬT sau lượt chạy — cờ còn bật
 * nghĩa là việc chưa xong dù lệnh chạy trót lọt. Hai ngả dẫn tới đó in ra HAI thông báo khác nhau vì
 * cách xử lý khác nhau: còn record kẹt (phải sửa mapping) vs cờ bị bật lại giữa chừng (chỉ cần chạy lại).
 *
 * ⚠️ KHÔNG chặn được: lượt PHỤC HỒI DB đang chạy trong app. Khoá bảo trì là cờ trong RAM của tiến
 * trình app (`src/lib/backup/khoa-bao-tri.ts`), còn lệnh này chạy ở container riêng nên không đọc
 * được. Đang phục hồi mà chạy lệnh này = ghi vào schema sắp bị xoá. Tự kiểm trước khi chạy.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";

// PHẢI là `import type`: import GIÁ TRỊ bị hoist lên TRƯỚC `loadEnvFile` dưới đây (xem lý do đầy
// đủ ở comment trên `main`), còn `import type` bị xoá lúc biên dịch nên không nạp module runtime.
import type { TransformStats } from "@/lib/bronze/transform-from-raw";

// Script standalone không đi qua Next auto-load .env → nạp bằng loader built-in của Node
// (≥20.6). Biến môi trường ĐÃ set (vd DATABASE_URL của container prod) được ưu tiên.
const envPath = path.resolve(process.cwd(), ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

/**
 * In DB đích KHÔNG kèm credential (URL chứa user:password — chỉ lấy host + tên DB).
 * Kèm `?schema=` vì sau khi gộp app+test chung 1 DB `postgres`, tên DB không còn phân biệt
 * được prod/test — chỉ `schema` mới nói lên đích thật (vd `schema=app` vs `schema=public`).
 */
function describeTargetDb(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Thiếu DATABASE_URL — không biết ghi vào đâu.");
  const u = new URL(url);
  const schema = u.searchParams.get("schema") || "public";
  return `${u.host}${u.pathname} schema=${schema}`;
}

/** Chặn lỡ tay ghi đè Silver của DB PROD từ máy dev. `--yes` để chạy không tương tác. */
async function confirmWrite(): Promise<boolean> {
  if (!process.stdin.isTTY) {
    // Không hỏi được ⇒ lỗi cấu hình, không phải "user từ chối" → báo qua exit code.
    process.exitCode = 1;
    console.error(
      "Không phải TTY (container/CI) — chạy lại kèm cờ --yes để xác nhận.",
    );
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      "Dựng lại TOÀN BỘ Silver trên DB này? Chỉ gõ y khi CHẮC CHẮN không có lượt phục hồi dữ liệu " +
        "nào đang chạy trong app. (y/N) ",
    );
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

// import ĐỘNG (không static): `src/lib/prisma.ts` đọc process.env.DATABASE_URL ngay lúc nạp
// module, mà import static bị hoist lên TRƯỚC loadEnvFile ở trên → client sẽ nối sai DB / không có
// URL. Nạp .env xong mới import.
async function main(): Promise<void> {
  console.log("DB đích:", describeTargetDb());

  const { hasBronzeBacklog } = await import("@/lib/bronze/bronze-only");
  const { rebuildFromRaw } = await import("@/lib/bronze/rebuild");
  const { coLuotDangChay, withSyncLog } = await import("@/lib/ingest/sync-log");
  const { prisma } = await import("@/lib/prisma");

  try {
    // Cổng chặn TRƯỚC khi hỏi: đừng bắt người ta gõ y rồi mới báo là không chạy được.
    // Cùng điều kiện nút "Dựng lại từ kho thô" trong app dùng — dấu hiệu nằm trong DB nên tiến
    // trình khác (lệnh này chạy ở container riêng) cũng đọc được.
    if (await coLuotDangChay("PANCAKE")) {
      process.exitCode = 1;
      console.error(
        "Đang có lượt đồng bộ / dựng lại khác chạy (SyncLog PANCAKE còn RUNNING) — chờ xong rồi " +
          "chạy lại. Log treo quá 15 phút tự bị chuyển ERROR nên không cần gỡ tay.",
      );
      return;
    }

    if (!process.argv.includes("--yes") && !(await confirmWrite())) {
      console.log("Đã huỷ — không ghi gì.");
      return;
    }

    // GIÀNH KHOÁ SAU khi người dùng xác nhận, và giành NGUYÊN TỬ ở DB — cổng `coLuotDangChay` phía
    // trên chỉ là phép KIỂM, giữa lúc kiểm và lúc chạy còn cả quãng chờ người gõ "y". Không có khoá
    // này thì chủ shop bấm "Xóa dữ liệu giao dịch" trong quãng đó: lượt xoá chốt kho thô rồi xoá Sổ,
    // xong lệnh này dựng dữ liệu trở lại bằng quyền ghi đè của lượt tay — nút xoá báo thành công
    // nhưng bị hoàn tác ngầm.
    const { giuKhoaViecNang, traKhoaViecNang, taoCheckpoint } =
      await import("@/lib/backup/khoa-viec-nang");
    const khoa = await giuKhoaViecNang("dựng lại từ kho thô (script)");
    if (!khoa.the) {
      process.exitCode = 1;
      console.error(`Đang có "${khoa.dangGiu}" chạy — chờ xong rồi chạy lại.`);
      return;
    }
    // Khoá có HẠN để một tiến trình chết không khoá vĩnh viễn ⇒ chủ khoá phải tự gia hạn. Gia hạn
    // bằng CHECKPOINT gắn với tiến độ thật, KHÔNG bằng timer nền: timer sống độc lập với công việc
    // nên việc treo cứng mà timer vẫn chạy sẽ giữ khoá vô hạn — mất đúng cái mà hạn bảo vệ.
    const the = khoa.the;
    const checkpoint = taoCheckpoint(the);

    try {
      const canhBao: string[] = [];
      const t0 = Date.now();

      // Bọc `withSyncLog` để CHÍNH lượt này cắm cờ RUNNING, cho những đường CÓ soi cờ nhìn thấy nó:
      // nút "Dựng lại từ kho thô" và cổng 409 của lượt phục hồi. Các trang ingest của n8n và nút
      // "Đồng bộ ngay" KHÔNG soi cờ này (cố ý — chặn chúng nghĩa là n8n gặp lỗi mỗi lần có lượt dựng
      // lại), nên cờ chỉ chặn được MỘT CHIỀU: nó ngăn người khác khởi động lượt mới đè lên lệnh này,
      // chứ không ngăn được lượt ingest đang chạy dở. Đổi lại cảnh báo được LƯU vào nhật ký đồng bộ
      // thay vì chỉ in ra rồi mất theo phiên ssh.
      // `nguon` để đọc nhật ký biết dòng này là lệnh chạy tay ngoài app. KHÔNG ghi khoá `stream`:
      // cổng "lượt kéo API còn sống" của lượt vá tồn kho soi đúng khoá đó, mà lệnh này dựng products
      // từ ẢNH trong kho thô chứ không gọi API — không được tự chứng nhận cho nó.
      const res = await withSyncLog("PANCAKE", async (warnings) => {
        const stats = await rebuildFromRaw(warnings, checkpoint);
        canhBao.push(...warnings);
        return { nguon: "script-dung-lai", ...stats };
      });

      // `withSyncLog` viết cho route handler nên trả `Response`, và BẮT lỗi thay vì ném ⇒ phải đọc
      // body rồi tự đặt exit code. Thiếu đoạn này thì lượt dựng lại thất bại vẫn exit 0 — runbook
      // deploy đọc exit code sẽ tưởng đã xong.
      const body = (await res.json()) as
        | { ok: true; stats: TransformStats & { warnings: string[] } }
        | { ok: false; error: string };
      if (!body.ok) {
        process.exitCode = 1;
        console.error("Dựng lại LỖI:", body.error);
        return;
      }

      // Còn record kẹt ⇒ `rebuildFromRaw` GIỮ cờ backlog (banner đỏ vẫn bật). Lệnh phải báo hỏng để
      // runbook deploy / người chạy tay không đọc thành "đã dựng xong hết": chính lệnh này là đường
      // banner chỉ tới, im lặng exit 0 là bảo họ đã chữa xong trong khi số vẫn thiếu. Đọc `skipped`
      // của cùng bảng số liệu mà `rebuildFromRaw` dùng làm điều kiện hạ cờ — một con số, không chép lại.
      if (body.stats.skipped > 0) {
        process.exitCode = 1;
        console.error(
          `${body.stats.skipped} record trong kho thô KHÔNG dựng được sang Silver — GIỮ cờ backlog ` +
            "(banner đỏ trong app vẫn bật). Xem cảnh báo bên dưới, sửa mapping rồi chạy lại lệnh này.",
        );
      } else if (await hasBronzeBacklog()) {
        // Kết cục KHÁC HẲN ca trên, người vận hành phải phân biệt được: lượt này dựng SẠCH, không có
        // mapping nào hỏng để sửa. Cờ còn bật vì có dòng MỚI tới trong lúc lệnh chạy mà không lên được
        // Silver (webhook / `/api/ingest/raw` không bị chặn suốt lượt), và `rebuildFromRaw` CỐ Ý không
        // hạ cờ của một cảnh báo nó chưa hề chữa (xem `haCoBacklogNeuChuaBiBatLai`). Chạy lại lệnh này
        // là xong. Vẫn exit 1 vì banner đỏ trong app còn bật ⇒ việc chưa xong.
        process.exitCode = 1;
        console.error(
          "Lượt này dựng SẠCH nhưng cờ backlog VẪN BẬT: có dòng mới tới trong lúc lệnh chạy mà không " +
            "lên được Silver (banner đỏ trong app vẫn bật). Không cần sửa mapping — chạy lại lệnh này " +
            "để dựng nốt dòng vừa tới.",
        );
      }

      console.log(
        "Dựng lại xong sau",
        ((Date.now() - t0) / 1000).toFixed(1),
        "giây",
      );
      // Tách `warnings` ra khỏi bảng số liệu: `withSyncLog` nhồi nó vào `stats`, để nguyên thì
      // `console.table` thêm một hàng mảng vô nghĩa. In tổng theo `canhBao` (bản đầy đủ) vì bản trong
      // `stats` đã bị cắt còn 50 dòng + 1 dòng tóm tắt.
      const { warnings: canhBaoDaLuu, ...soLieu } = body.stats;
      console.table(soLieu);
      if (canhBao.length) {
        console.log(
          `\n${canhBao.length} cảnh báo (nhật ký đồng bộ giữ ${canhBaoDaLuu.length} dòng):`,
        );
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
  console.error("Rebuild LỖI:", e);
  process.exit(1);
});
