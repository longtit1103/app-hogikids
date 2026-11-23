/**
 * BƯỚC KIỂM CHỈ-ĐỌC quanh migration `20261106150000_raw_pancake_order_land_seq` (số land `landSeq`): đếm đơn Silver
 * KHỚP / MƠ HỒ / KHÔNG KHỚP dòng kho thô theo đúng câu backfill của migration, phân loại đơn nghi lệch, chụp ẢNH NHÓM DI
 * SẢN, và (sau migrate) số đơn đã điền `rawLandSeq` + LỆCH CẶP / LỆCH NỘI DUNG. Chạy TRƯỚC và SAU migrate (runbook triển
 * khai mục ③a-6). Không ghi gì vào DB: MỘT transaction `REPEATABLE READ, READ ONLY`, trần 10 phút, câu lệnh 120 s, chờ
 * khoá 5 s.
 *
 * Prod:  docker compose run --rm -T app npx --no-install tsx scripts/dem-khop-moc-land-don-pancake.ts [cờ]
 * Local: npx tsx scripts/dem-khop-moc-land-don-pancake.ts [cờ]
 * Cờ:
 *  - `--ghi-anh`        : in ẢNH nhóm di sản (JSON, kèm nguồn DB/schema/cluster + giai đoạn + thời điểm) ra STDOUT, mọi
 *                         dòng báo cáo sang STDERR — CHỈ khi TRƯỚC migrate và cổng ĐẠT (`lyDoKhongXuatAnh`); ngoài ra
 *                         stdout RỖNG, thoát khác 0. Shell vẫn tạo file đích khi lỗi ⇒ luôn kiểm mã thoát trước khi dùng
 *                         file (runbook ③a-6 ghi ra file tạm, chỉ đổi tên khi mã 0).
 *  - `--so-anh <tệp|->` : so ảnh hiện tại với ảnh đã lưu (`-` = đọc từ stdin: `… --so-anh - < anh-truoc.json`). Ảnh
 *                         rỗng / hỏng ⇒ báo rõ, thoát 1; ảnh khác nguồn hoặc không chụp TRƯỚC migrate ⇒ KHÔNG so, ĐỎ;
 *                         ảnh khác ⇒ ĐỎ. SAU migrate còn TỰ so tổng đơn, `da_dien` = `khop` trước migrate và 16 chỉ
 *                         số tiền (`deploy/tien-16-chi-so.sql`) với ảnh (phiên bản 3) — thiếu ảnh / thiếu kết quả / lệch
 *                         ⇒ ĐỎ (dừng trước khi mở ghi).
 *  - `--liet-ke-mo-ho`  : sau migrate vẫn in ứng viên mơ hồ (trước migrate tự in khi có).
 *  - `--gioi-han <n>`, `--sau <pancakeId>`, `--sau-kdcc <pancakeId>`: phân trang ứng viên mơ hồ / danh sách KHÔNG ĐỦ CĂN
 *    CỨ (sắp `pancakeId` so theo byte; con trỏ in ở cuối trang).
 * Cờ lạ / dạng `--co=giá-trị` / đối số thừa / cờ lặp / thiếu giá trị / `--ghi-anh` cùng `--so-anh` ⇒ TỪ CHỐI, thoát 1,
 * stdout rỗng (`co-cli-kiem-moc-land-don.ts`).
 *
 * Mã thoát (`cong-kiem-moc-land-don.ts`): 0 ĐẠT · 1 KHÔNG ĐẠT · 2 KHÔNG ĐỦ CĂN CỨ · 3 KHÔNG HOÀN THÀNH (hết thời hạn).
 * Giành khoá ghi chung CLI/restore như mọi CLI (`SET TRANSACTION …` đi qua `$executeRaw`): đang phục hồi DB ⇒ từ chối
 * `LoiCliDangPhucHoi`, thoát 1 — trong cửa sổ migration landSeq: không chạy lại, không dùng lại ảnh sau phục hồi;
 * trước lần migrate đầu tiên bỏ cuộc cửa sổ; từ lần migrate đầu tiên ((b) chạy lại sau migration lỗi, KIỂM SAU) giữ
 * dừng và báo chủ shop (runbook ③a-6). Không chọn bản, không xoá kho thô, không gán `rawLandSeq`, không in payload / dữ liệu khách.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// Module thuần, không đọc env ⇒ import tĩnh được (trước dòng nạp .env).
import { type CoCliKiemMocLandDon, docCoCli, LoiCoCli } from "@/lib/bronze/co-cli-kiem-moc-land-don";

// Script standalone không đi qua Next auto-load .env (cùng lý do ở scripts/rebuild-from-raw.ts). Import giá trị phải
// đi SAU dòng nạp này ⇒ import động bên dưới.
const envPath = path.resolve(process.cwd(), ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

// Cờ sai / lạ / trùng / xung đột ⇒ TỪ CHỐI trước mọi việc (stdout rỗng, thoát 1) — không lặng lẽ bỏ qua `--so-anh`.
let co: CoCliKiemMocLandDon;
try {
  co = docCoCli(process.argv.slice(2));
} catch (e) {
  if (!(e instanceof LoiCoCli)) throw e;
  console.error(`TỪ CHỐI — cờ không hợp lệ: ${e.message} — không chạy kiểm, KHÔNG tính đạt`);
  process.exit(1);
}
const ghiAnh = co.ghiAnh;
// Có `--ghi-anh` thì STDOUT dành riêng cho JSON ảnh ⇒ mọi dòng báo cáo sang STDERR.
const bao = (dong: string) => (ghiAnh ? console.error(dong) : console.log(dong));

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Thiếu DATABASE_URL — không biết đếm DB nào.");
  const u = new URL(url);
  bao(`DB: ${u.host}${u.pathname} schema=${u.searchParams.get("schema") || "public"}`);
  // Đọc ảnh lần trước TRƯỚC khi mở transaction (transaction không bao giờ chờ người nhập / chờ stdin).
  const nguonAnh = co.soAnh;
  const { docAnhDiSan, kiemNguonAnh, LoiAnhDiSan, lyDoKhongXuatAnh, soAnhDiSan, soSoLieuTruocSau } = await import(
    "@/lib/bronze/anh-di-san-moc-land-don"
  );
  let anhTruoc = null;
  if (nguonAnh !== undefined) {
    try {
      let tho: string;
      try {
        tho = readFileSync(nguonAnh === "-" ? 0 : nguonAnh, "utf8");
      } catch (e) {
        throw new LoiAnhDiSan(`không đọc được ảnh "${nguonAnh}" (${e instanceof Error ? e.message : String(e)})`);
      }
      anhTruoc = docAnhDiSan(tho);
    } catch (e) {
      if (!(e instanceof LoiAnhDiSan)) throw e;
      bao(`KHÔNG ĐẠT — ${e.message} — KHÔNG so, KHÔNG tính đạt`);
      process.exitCode = 1;
      return;
    }
  }

  const { prisma } = await import("@/lib/prisma");
  const { demKhopMocLandDon, GIOI_HAN_UNG_VIEN, LoiKiemKhongHoanThanh } = await import("@/lib/bronze/dem-khop-moc-land-don");
  const { quyetDinhCong } = await import("@/lib/bronze/cong-kiem-moc-land-don");
  try {
    const sauDon = co.sau;
    const gioiHan = co.gioiHan;
    let kq;
    try {
      kq = await demKhopMocLandDon(prisma, { sauDon, sauDonKhongDuCanCu: co.sauKdcc, gioiHan });
    } catch (e) {
      if (e instanceof LoiKiemKhongHoanThanh) {
        bao(
          `KHÔNG HOÀN THÀNH — ${e.message} — KHÔNG tính đạt. TRƯỚC lần migrate đầu tiên (bước (a)/(b)) hoặc KIỂM SAU: ` +
            `chỉ chạy lại đúng lệnh này MỘT lần khi đủ điều kiện mục "LỖI TẠM" runbook ③a-6 (nguyên nhân đã xác định và ` +
            `đã hết, nguồn ghi vẫn dừng liên tục, không ghi/phục hồi/đổi schema; (b) và KIỂM SAU dùng CÙNG ảnh) — tra ` +
            `bằng KIỂM PHIÊN + CHI TIẾT phiên, KHÔNG tự huỷ phiên; tái diễn ⇒ dừng và báo, KHÔNG lặp để kiếm mã 0. (b) chạy lại SAU ` +
            `migration lỗi: KHÔNG chạy lại — GIỮ app + nguồn ghi DỪNG, giữ nguyên ảnh/log, báo chủ shop.`,
        );
        process.exitCode = 3;
        return;
      }
      throw e;
    }
    bao(`ảnh dữ liệu: ${kq.anhDuLieu.mucCoLap}, read_only=${kq.anhDuLieu.chiDoc}`);
    const ng = kq.anhDiSan.nguon;
    bao(
      `nguồn: db=${ng.db} oid=${ng.dbOid} schema=${ng.schema} cluster=${ng.cluster ?? "KHÔNG LẤY ĐƯỢC (thiếu quyền)"} ` +
        `giai_doan=${kq.anhDiSan.giaiDoan} luc=${kq.anhDiSan.luc}`,
    );
    bao(`tong_don=${kq.tongDon} khop=${kq.khop} mo_ho=${kq.moHo} khong_khop=${kq.khongKhop}`);
    bao(`tien16=${kq.anhDiSan.tien16} (deploy/tien-16-chi-so.sql, cùng ảnh dữ liệu)`);
    const khongKho = kq.anhDiSan.diSan.filter((d) => d.lyDo === "khong-co-kho-tho").length;
    bao(
      `di_san=${kq.anhDiSan.diSan.length} (khong_co_kho_tho=${khongKho} khong_co_moc_nguon=${kq.anhDiSan.diSan.length - khongKho}) ` +
        `— KHÔNG coi là đã xác minh; chỉ chấp nhận khi ảnh không đổi trước ↔ sau migrate`,
    );
    bao(
      `khong_doi_chieu_duoc=${kq.khongDoiChieuDuoc} (Order.raw không bằng CHÍNH XÁC payload nào); đơn nghi lệch phân ` +
        `loại theo cách đường ghi đọc dữ liệu: giai_thich_duoc=${kq.giaiThichDuoc} lech_ban_khac=${kq.lechBanKhac} ` +
        `khong_du_can_cu=${kq.khongDuCanCu}`,
    );
    if (kq.daDien === null) bao("Order.rawLandSeq: CHƯA có cột (trước migrate)");
    else bao(`Order.rawLandSeq: da_dien=${kq.daDien} lech_cap=${kq.lechCap} lech_noi_dung=${kq.lechNoiDung}`);
    if (kq.donKhongDuCanCu.length > 0) {
      bao(`ĐƠN KHÔNG ĐỦ CĂN CỨ — trang này ${kq.donKhongDuCanCu.length}/${kq.khongDuCanCu}:`);
      for (const d of kq.donKhongDuCanCu) bao(`  don=${d.pancakeId} ly_do=${d.lyDo}`);
      if (kq.donKhongDuCanCuTrangSau !== null) bao(`  … còn trang sau: chạy lại kèm \`--sau-kdcc ${kq.donKhongDuCanCuTrangSau}\``);
    }
    // Danh sách ỨNG VIÊN mơ hồ — để LẬP BÁO CÁO + phương án riêng (runbook ③a-6), không chọn bản.
    const inUngVien = kq.daDien === null ? kq.moHo > 0 : co.lietKeMoHo;
    if (inUngVien && kq.ungVienMoHo.length > 0) {
      bao(
        `ỨNG VIÊN MƠ HỒ — trang ${sauDon === undefined ? "đầu" : `sau don=${sauDon}`}: ${kq.ungVienMoHo.length} đơn ` +
          `(tổng mơ hồ ${kq.moHo}; mỗi trang tối đa ${gioiHan ?? GIOI_HAN_UNG_VIEN}):`,
      );
      for (const uv of kq.ungVienMoHo) {
        bao(`  don=${uv.pancakeId} rawFetchedAt=${uv.rawFetchedAt}`);
        for (const d of uv.dong) {
          bao(
            `    raw_id=${d.id} payloadHash=${d.payloadHash} status=${d.status ?? "-"} updated_at=${d.updatedAt ?? "-"} ` +
              `silverOutcome=${d.silverOutcome ?? "NULL"}`,
          );
        }
      }
      if (kq.ungVienTrangSau !== null) bao(`  … còn trang sau: chạy lại kèm \`--sau ${kq.ungVienTrangSau}\``);
    }
    // Ảnh sai nguồn / sai giai đoạn ⇒ KHÔNG so (so là vô nghĩa), cổng đỏ vì chính lý do đó.
    const loiNguon = anhTruoc === null ? [] : kiemNguonAnh(anhTruoc, kq.anhDiSan);
    const khacBiet = anhTruoc === null || loiNguon.length > 0 ? null : soAnhDiSan(anhTruoc, kq.anhDiSan);
    if (anhTruoc !== null) {
      bao(
        `ảnh đưa vào: chụp ${anhTruoc.luc} giai_doan=${anhTruoc.giaiDoan} tong_don=${anhTruoc.tongDon} ` +
          `khop=${anhTruoc.khop} tien16=${anhTruoc.tien16}`,
      );
    }
    if (khacBiet !== null) {
      bao(`so ảnh di sản với lần trước: ${khacBiet.length === 0 ? "KHỚP" : `${khacBiet.length} khác biệt`}`);
      for (const k of khacBiet.slice(0, GIOI_HAN_UNG_VIEN)) bao(`  ${k.loai} don=${k.pancakeId}`);
    }
    // Sau migrate: TỰ so tổng đơn, da_dien = khop trước migrate, 16 chỉ số tiền với ảnh trước migrate (không để mắt người so).
    const loiSoLieu = kq.daDien !== null && anhTruoc !== null && khacBiet !== null
      ? soSoLieuTruocSau(anhTruoc, { tongDon: kq.tongDon, daDien: kq.daDien, tien16: kq.anhDiSan.tien16 })
      : null;
    if (loiSoLieu !== null) {
      bao(`so số liệu trước ↔ sau migrate (tong_don, da_dien = khop trước, tien16): ${loiSoLieu.length === 0 ? "KHỚP" : "LỆCH"}`);
      for (const l of loiSoLieu) bao(`  ${l}`);
    }
    const cong = quyetDinhCong(kq, khacBiet, loiNguon, loiSoLieu);
    bao(cong.thongDiep);
    process.exitCode = cong.ma;
    if (ghiAnh) {
      const lyDo = lyDoKhongXuatAnh(kq.anhDiSan, cong.ma);
      if (lyDo === null) {
        process.stdout.write(`${JSON.stringify(kq.anhDiSan)}\n`);
      } else {
        bao(`TỪ CHỐI --ghi-anh: ${lyDo} — stdout KHÔNG có ảnh`);
        process.exitCode = cong.ma === 0 ? 1 : cong.ma;
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  // Đang phục hồi DB giữa cửa sổ migration landSeq ⇒ KHÔNG chạy lại, KHÔNG dùng lại ảnh: TRƯỚC lần migrate đầu tiên bỏ
  // cuộc cửa sổ; từ lần migrate đầu tiên ((b) chạy lại sau migration lỗi, KIỂM SAU) giữ dừng + báo chủ shop (runbook
  // ③a-6). KHÔNG in câu "chạy lại sau khi phục hồi xong" của lớp CLI dùng chung (đúng cho CLI khác, SAI ở đây: ảnh chụp trước phục hồi không còn là baseline).
  if (e instanceof Error && e.name === "LoiCliDangPhucHoi") {
    bao(
      "KHÔNG ĐẠT — đang phục hồi DB (khoá ghi chung bị giữ độc quyền); KHÔNG chạy lại, KHÔNG dùng lại ảnh sau phục " +
        "hồi (runbook ③a-6). TRƯỚC lần migrate đầu tiên (bước (a)/(b)): BỎ CUỘC cửa sổ theo mục \"BỎ CUỘC TRƯỚC " +
        "MIGRATE\" — giữ ảnh + nguồn ghi dừng, báo chủ shop; cất ảnh và quay về container cũ CHỈ theo duyệt; chỉ mở cửa " +
        "sổ mới từ PREFLIGHT khi cửa sổ này đã khép và trạng thái DB đã được xác nhận. TỪ lần migrate đầu tiên ((b) " +
        "chạy lại sau migration lỗi, " +
        "KIỂM SAU): GIỮ app + nguồn ghi DỪNG, KHÔNG `up -d`, giữ nguyên ảnh/log, báo chủ shop — KHÔNG quay lại bước " +
        "chụp ảnh, KHÔNG dùng bảng xử lý trước migrate.",
    );
    process.exitCode = 1;
    return;
  }
  console.error(e);
  process.exitCode = 1;
});
