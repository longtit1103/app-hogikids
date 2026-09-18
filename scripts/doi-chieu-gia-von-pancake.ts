/**
 * Đối chiếu giá vốn app ↔ giá vốn Pancake đã có trong Bronze (`RawPancakeProduct`, shop KHO).
 *
 *   npx tsx scripts/doi-chieu-gia-von-pancake.ts                    # CHỈ XEM — không ghi gì
 *   npx tsx scripts/doi-chieu-gia-von-pancake.ts --ghi               # ghi (hỏi xác nhận)
 *   npx tsx scripts/doi-chieu-gia-von-pancake.ts --ghi --yes         # ghi không hỏi (CI/container)
 *   npx tsx scripts/doi-chieu-gia-von-pancake.ts --ghi --theo-pancake # ghi đè — LUÔN phải bấm y
 *
 * Mặc định chỉ đụng biến thể app còn để TRỐNG giá vốn. Thêm `--theo-pancake` để lấy Pancake làm
 * chuẩn cho MỌI dòng lệch, kể cả dòng app đã có số — chỉ dùng khi chủ shop vừa chỉnh giá nhập bên
 * Pancake và xác nhận số bên đó mới đúng (nếu không, cờ này sẽ đè mất giá chủ shop nhập tay).
 * Chính vì đè được số nhập tay, `--theo-pancake` TỪ CHỐI đi cùng `--yes`: lập luận "không phá bất
 * biến #5" của công cụ này đứng được là nhờ CÓ NGƯỜI xem danh sách rồi bấm y. Bỏ người ra khỏi
 * vòng lặp là mất chỗ dựa đó, nên chế độ đè luôn đòi phiên tương tác.
 *
 * Vì sao cần: `Variant.costPrice` là APP-OWNED — ingest CHỈ prefill lúc CREATE, lượt sync sau
 * TUYỆT ĐỐI không ghi đè (giữ số chủ shop sửa tay). Nên biến thể nào lúc tạo chưa có giá vốn thì
 * sẽ ở lại 0 vĩnh viễn dù Pancake về sau đã có giá. Script này là đường NHẬP TAY HÀNG LOẠT có
 * người duyệt — không phải ingest tự động, nên không phá bất biến #5.
 *
 * An toàn khi ghi: mỗi lệnh update kèm điều kiện giá vốn PHẢI CÒN ĐÚNG số đã đọc lúc xem ⇒ nếu chủ
 * shop vừa nhập tay dòng đó trong lúc script chạy thì dòng đó không khớp điều kiện nữa, số của chủ
 * shop THẮNG, không bị đè. (Chế độ mặc định số đó luôn là 0; `--theo-pancake` thì là số app đang giữ.)
 *
 * Mọi lượt ghi đều tự chụp backup giá cũ TRƯỚC khi chạm DB, và từ chối chạy nếu bản chụp không
 * ghi/đọc lại được (xem `lib/ghi-gia-von-theo-pancake.ts`).
 *
 * ⚠️ Trên máy dev, `DATABASE_URL` trỏ THẲNG DB PROD → in DB đích + hỏi xác nhận trước khi ghi.
 *
 * Ghi DƯỚI KHOÁ VIỆC NẶNG (lease trong bảng `Setting`, `src/lib/backup/khoa-viec-nang.ts` — cùng
 * khoá mà lượt phục hồi trong app, lượt xoá dữ liệu và `rebuild-from-raw.ts` giành). Script là tiến
 * trình RIÊNG nối thẳng DB nên không thấy cờ khoá bảo trì trong tiến trình app; lease trong DB là thứ
 * mọi tiến trình cùng thấy. Đang có lượt phục hồi (hay việc nặng khác) ⇒ script TỪ CHỐI ghi, in tên
 * việc đó; script đang ghi ⇒ `POST /api/restore` nhận 409. Chi tiết: `lib/ghi-gia-von-theo-pancake.ts`.
 *
 * ⚠️ VẪN PHẢI KIỂM TAY với phục hồi TRÊN HOST: `deploy/restore.sh` / DR (`deploy/runbook-dr-cai-lai-minipc.md`)
 * drop schema bằng `supabase_admin` mà KHÔNG giành lease ⇒ script không thể thấy. Đang chạy DR trên
 * host thì TUYỆT ĐỐI KHÔNG chạy `--ghi`.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import { ghiGiaVonDuoiKhoaViecNang, LoiDungGiuaChung } from "@/lib/gia-von/ghi-gia-von-theo-pancake";

const envPath = path.resolve(process.cwd(), ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

function moTaDbDich(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Thiếu DATABASE_URL — không biết đọc/ghi ở đâu.");
  const u = new URL(url);
  return `${u.host}${u.pathname} schema=${u.searchParams.get("schema") || "public"}`;
}

async function xacNhanGhi(soDong: number, moTaTong: string, cheDoDe: boolean): Promise<boolean> {
  // `--theo-pancake` cố ý KHÔNG chấp nhận `--yes` — xem ghi chú đầu file.
  if (!cheDoDe && process.argv.includes("--yes")) return true;
  if (!process.stdin.isTTY) {
    process.exitCode = 1;
    console.error(
      cheDoDe
        ? "Không phải TTY (container/CI) — `--theo-pancake` đè số chủ shop nhập tay nên BẮT BUỘC chạy trong phiên tương tác để bấm y."
        : "Không phải TTY (container/CI) — chạy lại kèm cờ --yes để xác nhận.",
    );
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const dap = await rl.question(`Ghi giá vốn cho ${soDong} biến thể (${moTaTong})? (y/N) `);
    return dap.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

function vnd(n: number): string {
  return `${n.toLocaleString("vi-VN")} ₫`;
}

/** `plans/reports/backup-gia-von-<yymmdd-hhmm>-<chế độ>.json` — dấu vết bền, cùng chỗ với báo cáo. */
function duongDanBackup(moc: Date, cheDo: string): string {
  const hai = (n: number) => String(n).padStart(2, "0");
  const ten =
    `backup-gia-von-${String(moc.getFullYear()).slice(2)}${hai(moc.getMonth() + 1)}${hai(moc.getDate())}` +
    `-${hai(moc.getHours())}${hai(moc.getMinutes())}-${cheDo}.json`;
  return path.resolve(process.cwd(), "plans", "reports", ten);
}

async function main(): Promise<void> {
  const ghi = process.argv.includes("--ghi");
  const cheDo = process.argv.includes("--theo-pancake") ? "theo-pancake" : "chi-thieu";

  if (cheDo === "theo-pancake" && process.argv.includes("--yes")) {
    process.exitCode = 1;
    console.error(
      "TỪ CHỐI: `--theo-pancake` không đi cùng `--yes`.\n" +
        "Chế độ này ĐÈ giá vốn chủ shop đã nhập tay, nên bắt buộc có người xem danh sách rồi bấm y.\n" +
        "Bỏ `--yes` và chạy lại trong phiên tương tác.",
    );
    return;
  }
  const { prisma } = await import("@/lib/prisma");
  const { docDeXuatGiaVon } = await import("@/lib/gia-von/doc-de-xuat-gia-von");

  console.log("DB đích:", moTaDbDich());
  console.log(
    "Chế độ:",
    cheDo === "theo-pancake"
      ? "--theo-pancake — Pancake là chuẩn cho MỌI dòng lệch (kể cả dòng app đã có số)"
      : "mặc định — chỉ điền dòng app còn để trống",
  );

  try {
    // Truy vấn nằm ở `@/lib/gia-von/doc-de-xuat-gia-von` — DÙNG CHUNG với màn duyệt trong app.
    // Hai bên tự viết truy vấn riêng là mở đường cho màn hình hứa một đằng, lượt ghi làm một nẻo.
    const { deXuat, soBienTheApp, soBienTheKho, conPhaiNhapTay } = await docDeXuatGiaVon(cheDo);

    console.log(`\nBiến thể app: ${soBienTheApp} · biến thể kho đọc được từ Bronze: ${soBienTheKho}`);
    console.log(`→ Cần sửa theo Pancake: ${deXuat.length} biến thể\n`);

    if (deXuat.length === 0) {
      console.log("Không có gì để sửa — app đã khớp giá vốn Pancake (hoặc Bronze chưa có giá).");
      return;
    }

    console.table(
      deXuat.map((d) => ({
        sku: d.sku,
        ten: d.ten.slice(0, 40),
        app_hien_tai: d.giaHienTai === 0 ? "(trống)" : vnd(d.giaHienTai),
        gia_de_xuat: vnd(d.giaDeXuat),
        chenh: vnd(d.giaDeXuat - d.giaHienTai),
        nguon: d.nguon === "trung-binh" ? "TB Pancake" : "nhập lần cuối",
      })),
    );

    if (conPhaiNhapTay > 0) {
      console.log(
        `\n${conPhaiNhapTay} biến thể vẫn PHẢI nhập tay ở màn Sản phẩm — Pancake cũng chưa có giá vốn cho chúng.`,
      );
    }

    if (!ghi) {
      console.log("\n(chế độ XEM — chưa ghi gì. Thêm cờ `--ghi` để áp dụng.)");
      return;
    }

    const tongChenh = deXuat.reduce((s, d) => s + (d.giaDeXuat - d.giaHienTai), 0);
    const moTaTong =
      cheDo === "theo-pancake"
        ? `tổng chênh ${vnd(tongChenh)}/đơn vị · ${deXuat.filter((d) => d.giaHienTai > 0).length} dòng ĐÈ số app đang có`
        : `tổng ${vnd(tongChenh)}/đơn vị`;
    if (!(await xacNhanGhi(deXuat.length, moTaTong, cheDo === "theo-pancake"))) {
      console.log("Đã huỷ — không ghi gì.");
      return;
    }

    // Thứ tự trong module: giành lease việc nặng → backup (CỔNG CHẶN: chụp giá cũ rồi đọc lại xác
    // minh TRƯỚC khi chạm dòng DB đầu tiên) → UPDATE từng dòng với guard "giá vốn vẫn đúng như lúc
    // xem" nằm trong chính câu lệnh, checkpoint gia hạn lease mỗi 25 dòng → trả lease.
    // Nạp module lease ở đây (sau `.env`) vì nó kéo theo `PrismaClient` — cùng lý do với `prisma`.
    const khoa = await import("@/lib/backup/khoa-viec-nang");
    const moc = new Date();
    const kq = await ghiGiaVonDuoiKhoaViecNang(prisma, khoa, deXuat, {
      duongDanBackup: duongDanBackup(moc, cheDo),
      cheDo,
      ghiLuc: moc,
    });

    if ("tuChoi" in kq) {
      process.exitCode = 1;
      console.error(
        `TỪ CHỐI ghi: đang có việc nặng "${kq.tuChoi}" giữ DB — nếu đó là lượt phục hồi thì schema ` +
          "đang bị thay sạch, ghi lúc này là số vừa ghi bị bản backup nuốt. Chờ việc đó xong rồi chạy " +
          "lại. (Khoá của một việc đã chết tự hết hạn trong tối đa 5 phút.)",
      );
      return;
    }

    console.log(`\nBackup giá cũ: ${path.relative(process.cwd(), kq.duongDanBackup)}`);
    if (kq.daGhi === 0) {
      // Không dòng nào còn khớp giá lúc xem: KHÔNG phải "đã khớp Pancake" — dữ liệu có thể vừa bị
      // thay dưới chân (phục hồi/dựng lại, bảng còn trống giữa lượt nạp) hoặc chủ shop vừa sửa tay
      // toàn bộ. In "Xong" ở đây là mời người vận hành kết luận sai và không chạy lại.
      process.exitCode = 1;
      console.error(
        `KHÔNG ghi được dòng nào (${kq.boQua}/${deXuat.length} dòng không còn khớp giá lúc xem) — dữ ` +
          "liệu có thể vừa bị thay (phục hồi/dựng lại, bảng còn trống giữa lượt nạp) hoặc chủ shop vừa " +
          "sửa tay. Chạy lại lượt XEM (không cờ) để kiểm trước khi kết luận.",
      );
      return;
    }
    console.log(
      `Xong: ghi ${kq.daGhi} biến thể` +
        (kq.boQua > 0
          ? ` · ${kq.boQua} dòng bỏ qua vì không còn khớp giá lúc xem (chủ shop vừa nhập tay, hoặc dữ ` +
            "liệu vừa được phục hồi/dựng lại) — không đè."
          : "."),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  // Bảng không tồn tại = schema đang bị thay sạch (lượt phục hồi đang nạp). Nhánh này CỐ Ý là
  // fail-closed (chưa ghi dòng nào) — nói thẳng để người vận hành không tưởng app hỏng.
  // Loại `LoiDungGiuaChung`: nó NHÚNG message của lỗi gốc, mà bảng bị drop GIỮA vòng ghi thì đã có
  // k dòng vào DB — câu "chưa ghi dòng nào" lúc đó là nói dối đúng lúc cần con số k nhất.
  if (!(e instanceof LoiDungGiuaChung) && /does not exist/.test(String(e))) {
    console.error(
      "Bảng dữ liệu không tồn tại — hệ có thể ĐANG PHỤC HỒI (schema đang bị thay). Chưa ghi dòng nào. " +
        "Chờ phục hồi xong rồi chạy lại.",
    );
  }
  console.error(e);
  process.exitCode = 1;
});
