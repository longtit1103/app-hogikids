"use server";

import { revalidatePath } from "next/cache";

import type { ActionResult } from "@/lib/actions/action-result";
import {
  dangPhucHoi,
  LOI_DANG_PHUC_HOI,
  thuGiuKhoaDungLai,
  traKhoaDungLai,
} from "@/lib/backup/khoa-bao-tri";
import {
  giuKhoaViecNang,
  kiemGiuKhoaTrongTransaction,
  taoCheckpoint,
  traKhoaViecNang,
} from "@/lib/backup/khoa-viec-nang";
import { dongDauDaXoaTay } from "@/lib/bronze/ket-cuc-silver";
import { giuKhoaLandDon } from "@/lib/bronze/khoa-land-don";
import { dungLaiGiaoDichTuKhoTho } from "@/lib/bronze/rebuild";
import type { TransformStats } from "@/lib/bronze/transform-from-raw";
import { coLuotDangChay, withSyncLog } from "@/lib/ingest/sync-log";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

/**
 * VÙNG NGUY HIỂM — xoá VĨNH VIỄN sổ sách GIAO DỊCH: đơn + dòng hàng trong đơn,
 * chi phí (thường và định kỳ), log đồng bộ và số liệu "Tiền đã về"
 * (TikTok/Shopee). Yêu cầu gõ ĐÚNG tên shop (so khớp case-sensitive) để xác
 * nhận; sai → KHÔNG xoá gì.
 *
 * Xoá kèm: `CashMovement` (khoản tiền khác ghi tay) và `Loan` (hồ sơ khoản
 * vay) — là giao dịch, xoá cùng `Expense`. Cũng như chi phí nhập tay, kho thô
 * KHÔNG có bản gốc để dựng lại, nên dialog phải nói rõ số dòng sắp mất.
 *
 * GIỮ LẠI — cố ý, đừng "dọn" thêm:
 *  - TOÀN BỘ kho thô (Bronze): bản gốc Pancake là đường dựng lại Silver duy
 *    nhất (`dungLaiTuKhoTho`). Xoá kho thô = mất vĩnh viễn, chỉ backup mới cứu.
 *  - `Product` / `Variant`: `costPrice` và `lowStockThreshold` là APP-OWNED —
 *    đồng bộ chỉ prefill giá lúc CREATE, nên xoá đi là đốt công nhập giá vốn
 *    của chủ shop, trong khi bản thân sản phẩm thì lượt đồng bộ đêm dựng lại
 *    được.
 *  - `User`, `Channel`, `ExpenseCategory` và TOÀN BỘ `Setting`: đó là cấu hình,
 *    không phải giao dịch.
 *  - `SyncLog` kind BACKUP: đó là NGUỒN SỰ THẬT DUY NHẤT của dòng trạng thái
 *    "Sao lưu" ở màn Cài đặt (`lib/backup/trang-thai-sao-luu.ts`) — không phải
 *    sổ sách giao dịch. Quy trình đúng là "Sao lưu ngay rồi mới xoá": xoá dấu
 *    vết lượt sao lưu đi thì ngay sau lượt xoá màn Cài đặt lại kêu "Chưa sao
 *    lưu lần nào" đúng lúc nguy hiểm nhất, trong khi bản dump vừa tạo vẫn là
 *    điểm phục hồi hợp lệ. (Mốc này từng nằm ở `Setting.lastBackupAt` và cũng
 *    từng bị xoá kèm — lý do giữ y hệt, chỉ đổi nơi lưu.)
 *
 * `requireUser()` trả về userId (STRING), không phải object user → phải
 * `findUnique` để lấy `shopName`.
 */
export async function deleteAllData(shopNameConfirm: string): Promise<ActionResult> {
  const userId = await requireUser();

  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    return { ok: false, error: "Không tìm thấy tài khoản" };
  }
  if (shopNameConfirm !== user.shopName) {
    return { ok: false, error: "Tên shop không khớp" };
  }

  // Không được chạy CHỒNG với lượt dựng lại từ kho thô: lượt đó đang đọc/ghi đúng những dòng ta sắp
  // đóng dấu. Khoá phải nằm Ở DB — lượt dựng lại bằng script chạy ở TIẾN TRÌNH RIÊNG nên cờ trong
  // bộ nhớ của app không thấy nó, và ta sẽ xoá xong rồi bị script dựng lại ngầm.
  const khoa = await giuKhoaViecNang("xoá dữ liệu giao dịch");
  if (!khoa.the) {
    return { ok: false, error: `Đang có "${khoa.dangGiu}" chạy — thử lại sau khi việc đó xong.` };
  }

  try {
    // Con trước cha để không vỡ khoá ngoại; 1 transaction để hoặc-tất-cả-hoặc-không.
    await prisma.$transaction(async (tx) => {
      // KHOÁ LAND ĐƠN: giữ trong CHÍNH transaction này để không có dòng kho thô MỚI chen vào giữa
      // câu đóng dấu và lúc commit. Không có nó thì một trang ingest land ngay sau câu UPDATE sẽ để
      // lại dòng chưa-đóng-dấu, và lượt đối soát đêm dựng nó vào một cái Sổ vừa được xoá sạch.
      await giuKhoaLandDon(tx);

      // HÀNG RÀO TRONG TRANSACTION: kiểm TRƯỚC transaction vẫn còn khe — giữa lúc kiểm và lúc
      // commit, khoá có thể hết hạn và một lượt dựng lại giành mất, rồi nó dựng lại đúng phần ta
      // vừa xoá. `FOR UPDATE` giữ dòng khoá tới khi transaction này commit nên lượt giành mới phải
      // CHỜ, và khi chạy được thì hạn của ta đã tươi ⇒ nó không giành nổi.
      await kiemGiuKhoaTrongTransaction(tx, khoa.the);

      // THỨ TỰ CHẠM BẢNG phải KHỚP đường transform (`Order` → `OrderItem` → `RawPancakeOrder`),
      // nếu không hai transaction giữ hai đầu rồi chờ nhau và Postgres huỷ một bên: nút Xoá thất
      // bại ngẫu nhiên đúng lúc đang đồng bộ. `OrderItem` có khoá ngoại `onDelete: Cascade` nên xoá
      // `Order` trước là cuốn theo item — không cần (và không được) xoá item trước.
      await tx.order.deleteMany();
      await tx.expense.deleteMany();
      await tx.recurringExpense.deleteMany();
      // THỨ TỰ CON-TRƯỚC-CHA, KHÔNG được đảo: `ThuNhap.savingsId` và `CashMovement.savingsId` đều FK
      // `onDelete: Restrict`. Xoá `SoTietKiem` trước là Postgres từ chối ⇒ cả transaction vỡ và nút
      // "Xoá dữ liệu giao dịch" hỏng VĨNH VIỄN. Bỏ quên `ThuNhap` còn tệ hơn vì hỏng LẶNG: lãi tiết
      // kiệm sống sót và vẫn cộng vào dòng "Thu nhập tài chính" của P&L sau khi Sổ đã xoá sạch.
      await tx.thuNhap.deleteMany(); // lãi tiết kiệm — con của SoTietKiem
      await tx.cashMovement.deleteMany(); // khoản tiền khác ghi tay — con của Loan và SoTietKiem
      // Hồ sơ sổ tiết kiệm — SAU ThuNhap + CashMovement. Cũng là sổ sách nhập tay: kho thô không có
      // bản gốc nào để dựng lại.
      await tx.soTietKiem.deleteMany();
      // Hồ sơ khoản vay — SAU CashMovement (FK `onDelete: Restrict`, con trước cha). Cùng diện.
      await tx.loan.deleteMany();
      // THÙNG RÁC: ảnh chụp của đúng những bảng vừa xoá ở trên. Đây là lệnh "xoá sạch dữ liệu giao
      // dịch" nên giữ lại thùng rác là để lại một đường khôi phục đúng thứ chủ shop vừa cố ý xoá.
      // Không FK nào trỏ tới/đi ra từ bảng này ⇒ đặt đâu trong transaction cũng an toàn; đặt ở đây
      // để đứng cạnh 5 bảng nó chụp.
      await tx.banGhiDaXoa.deleteMany();
      // Bản chốt số dư cuối tháng: thước đo gắn với D0 của chính sổ vừa xoá — giữ lại là sau khi
      // nhập sổ mới, thẻ đối chiếu vẫn in chênh lệch của thế giới cũ. Không FK, đặt đâu cũng được.
      await tx.soDuChotThang.deleteMany();
      // TRỪ kind BACKUP — xem khối "GIỮ LẠI" ở đầu file: đó là nguồn trạng thái sao lưu, không phải
      // log giao dịch. Xoá cả bảng thì màn Cài đặt kêu "Chưa sao lưu lần nào" ngay sau lượt xoá.
      await tx.syncLog.deleteMany({ where: { kind: { not: "BACKUP" } } });
      // 4 bảng Silver "Tiền đã về" (/tai-chinh?tab=dong-tien) — cũng là sổ sách giao dịch,
      // bỏ sót thì màn Dòng tiền vẫn còn số trong khi đơn đã sạch.
      await tx.tiktokSettlement.deleteMany();
      await tx.tiktokAdsSettlement.deleteMany();
      await tx.tiktokPayment.deleteMany();
      await tx.shopeeSettlement.deleteMany();

      // Chốt kho thô SAU CÙNG — vẫn trong cùng transaction nên vẫn "hoặc tất cả hoặc không", mà
      // thứ tự chạm bảng thì khớp đường transform. Dòng còn dở PHẢI được chốt là "đã xoá tay":
      // không có bước này thì đúng những dòng còn dở — chính ca mà cột kết cục sinh ra để bắt — sẽ
      // được dựng lại đêm hôm sau, chủ shop thấy Sổ vừa xoá bỗng có lại một nhúm đơn lẻ.
      const daChot = await dongDauDaXoaTay(tx);
      if (daChot > 0) {
        console.info(`Xoá dữ liệu giao dịch: chốt ${daChot} dòng kho thô còn dở thành đã-xoá-tay`);
      }
    });
  } finally {
    await traKhoaViecNang(khoa.the);
  }

  revalidatePath("/", "layout");
  return { ok: true, data: undefined };
}

/**
 * Có gì cho nút "Xóa dữ liệu giao dịch" xoá không.
 *
 * Phải đếm ĐÚNG những bảng lượt xoá đụng tới: thiếu bảng nào thì dialog báo "Không có dữ liệu để
 * xóa" trong khi màn Dòng tiền vẫn còn số. KHÔNG đếm `Product`/`Variant` — lượt xoá không còn chạm
 * tới chúng nữa.
 */
export async function coDuLieuGiaoDich(): Promise<boolean> {
  await requireUser();

  const dem = await Promise.all([
    prisma.order.count(),
    prisma.expense.count(),
    prisma.recurringExpense.count(),
    prisma.cashMovement.count(),
    prisma.loan.count(),
    // Sổ tiết kiệm + lãi đã ghi: thiếu hai bảng này thì dialog báo "Không có dữ liệu để xóa" trong
    // khi khối Sổ tiết kiệm ở tab Dòng tiền vẫn còn số.
    prisma.soTietKiem.count(),
    prisma.thuNhap.count(),
    // Thùng rác cũng nằm trong danh sách xoá ở trên ⇒ phải đếm, nếu không dialog báo "Không có dữ
    // liệu để xóa" rồi lượt xoá vẫn âm thầm dọn sạch thùng rác.
    prisma.banGhiDaXoa.count(),
    prisma.tiktokSettlement.count(),
    prisma.tiktokAdsSettlement.count(),
    prisma.tiktokPayment.count(),
    prisma.shopeeSettlement.count(),
  ]);
  return dem.some((n) => n > 0);
}

export type ChiPhiKhongDungLai = {
  /** Số dòng `Expense` NHẬP TAY — KHÔNG gồm chi tiêu quảng cáo (`source=ADS_API`, dựng lại được). */
  soChiPhi: number;
  /** Σ `Expense.amount` của đúng nhóm chi phí nhập tay đó. */
  tongChiPhi: number;
  /** Số mẫu chi phí định kỳ. KHÔNG cộng vào `tongChiPhi` vì đó là số tiền mỗi THÁNG. */
  soDinhKy: number;
  /** Số dòng `CashMovement` (khoản tiền khác ghi tay: vay/góp/rút vốn, trả nợ, bán trực tiếp) — cùng diện "mất là mất". */
  soKhoanTienKhac: number;
  /** Σ `CashMovement.amount` (độ lớn, không phân chiều — chỉ để nói "sắp mất bao nhiêu dòng tiền đã ghi"). */
  tongKhoanTienKhac: number;
  /** Số hồ sơ `Loan` (lãi suất, kỳ hạn, dư nợ mở sổ) — nhập tay 100%, lượt dựng lại KHÔNG đụng tới. */
  soKhoanVay: number;
  /** Số hồ sơ `SoTietKiem` (kỳ hạn, lãi suất, ngày đáo hạn) — cùng diện `Loan`. */
  soSoTietKiem: number;
  /** Σ `ThuNhap.amount` — lãi tiết kiệm đã ghi, là số ĐÃ VÀO P&L nên mất là lệch lãi ròng kỳ cũ. */
  tongThuNhap: number;
};

/**
 * Đếm phần chi phí mà "Dựng lại từ kho thô" KHÔNG BAO GIỜ lấy lại được.
 *
 * PHẠM VI HẸP LẠI: chỉ chi phí chủ shop NHẬP TAY (`source ≠ ADS_API`) — không có bản gốc nào ngoài
 * app để chép lại, xoá đi là mất nhiều tháng chi phí ⇒ lãi ròng mọi kỳ quá khứ bị thổi phồng, chỉ
 * phục hồi bản sao lưu mới cứu. Chi tiêu quảng cáo thì kho thô CÓ giữ bản gốc báo cáo Meta/TikTok
 * nên dựng lại được đúng từng đồng ⇒ không thuộc diện cảnh báo này nữa; đếm nó vào đây sẽ thổi
 * phồng con số trên dialog và làm chủ shop sợ một khoản mất không có thật.
 *
 * `CashMovement` (khoản tiền khác ghi tay) và `Loan` (hồ sơ khoản vay: lãi suất, kỳ hạn, dư nợ mở
 * sổ, con dấu kỳ đã duyệt) nằm CÙNG diện: nhập tay 100%, kho thô không có bản gốc, lượt dựng lại
 * KHÔNG đụng tới ⇒ xoá đi là mất hẳn, chỉ bản sao lưu mới cứu.
 *
 * Đếm động để dialog nói được ĐỘ LỚN của khoản mất, thay vì một câu cảnh báo chung chung.
 */
export async function demChiPhiKhongDungLai(): Promise<ChiPhiKhongDungLai> {
  await requireUser();

  const [chiPhi, soDinhKy, khoanTienKhac, soKhoanVay, soSoTietKiem, thuNhap] = await Promise.all([
    prisma.expense.aggregate({
      where: { source: { not: "ADS_API" } },
      _count: { _all: true },
      _sum: { amount: true },
    }),
    prisma.recurringExpense.count(),
    prisma.cashMovement.aggregate({ _count: { _all: true }, _sum: { amount: true } }),
    prisma.loan.count(),
    prisma.soTietKiem.count(),
    prisma.thuNhap.aggregate({ _sum: { amount: true } }),
  ]);
  return {
    soChiPhi: chiPhi._count._all,
    tongChiPhi: chiPhi._sum.amount ?? 0,
    soDinhKy,
    soKhoanTienKhac: khoanTienKhac._count._all,
    tongKhoanTienKhac: khoanTienKhac._sum.amount ?? 0,
    soKhoanVay,
    soSoTietKiem,
    tongThuNhap: thuNhap._sum.amount ?? 0,
  };
}

export type DonMoCoi = {
  /** Số đơn Silver không tìm thấy bản gốc nào trong kho thô — MỌI trạng thái. */
  soDon: number;
  /** Σ `itemsTotal` của ĐÚNG nhóm đơn đó: giá trị hàng, KHÔNG phải doanh thu. */
  tongTien: number;
};

/**
 * Đếm đơn MỒ CÔI: có trong Silver nhưng kho thô KHÔNG còn bản gốc (đơn cũ hơn cửa sổ giữ Bronze).
 *
 * Ý nghĩa với nút xoá: nhóm đơn này là phần "Dựng lại từ kho thô" KHÔNG lấy lại được — xoá xong chỉ
 * phục hồi backup mới cứu. Đếm động mỗi lần mở dialog thay vì tin số đo của một ngày cụ thể (độ phủ
 * kho thô không được bảo đảm vĩnh viễn).
 *
 * PHẠM VI HẸP — chữ trên dialog phải nói đúng chừng này: chỉ bắt loại "Silver có, kho thô KHÔNG có
 * dòng nào". Loại thứ hai mà cảnh báo cuối mỗi lượt dựng lại nói tới — CÓ bản gốc nhưng luật hiện
 * tại loại (mirror / hỏng shape) — không đếm được ở đây, vì chỉ biết sau khi thực sự chạy transform.
 *
 * `soDon` và `tongTien` dùng CÙNG một tập đơn (không lọc trạng thái): lọc bỏ đơn hoàn/huỷ khỏi tiền
 * mà vẫn đếm chúng vào số đơn sẽ in ra những câu tự đá nhau như "37 đơn (0 đ)". Đơn hoàn/huỷ cũng là
 * mất dữ liệu thật (phí sàn `returnedFee` của chúng vẫn trừ vào lãi ròng), nên giữ trong số đếm.
 */
export async function demDonMoCoi(): Promise<DonMoCoi> {
  await requireUser();

  const [row] = await prisma.$queryRaw<{ soDon: number; tongTien: bigint }[]>`
    SELECT
      COUNT(*)::int AS "soDon",
      COALESCE(SUM(o."itemsTotal"), 0)::bigint AS "tongTien"
    FROM "Order" o
    WHERE NOT EXISTS (
      SELECT 1 FROM "RawPancakeOrder" r WHERE r."externalId" = o."pancakeId"
    )
  `;

  return { soDon: row?.soDon ?? 0, tongTien: Number(row?.tongTien ?? 0) };
}

export type AdsMoCoi = {
  /** Số dòng chi tiêu quảng cáo không tìm thấy bản gốc báo cáo nào trong kho thô. */
  soDong: number;
  /** Σ `Expense.amount` của đúng nhóm đó. */
  tongTien: number;
};

/**
 * Đếm chi tiêu quảng cáo MỒ CÔI: có dòng `Expense` (`source=ADS_API`) nhưng kho thô KHÔNG còn bản
 * gốc báo cáo tương ứng ⇒ lượt "Dựng lại từ kho thô" KHÔNG lấy lại được đúng nhóm này.
 *
 * Vì sao phải đo thay vì tin: trong CẢ HAI workflow n8n, bước land bản gốc là BEST-EFFORT (`landRaw`
 * bắt lỗi rồi log "CẢNH BÁO: land raw hỏng" và đi tiếp) còn bước `POST /api/ingest/ads` mới bắt
 * buộc. Đêm nào Bronze hỏng riêng thì sinh ra đúng loại dòng này: sổ có số, kho thô không có gốc.
 * Dialog xoá khẳng định "chi tiêu quảng cáo dựng lại được" nên lời khẳng định đó phải có số đỡ.
 *
 * Khoá đối chiếu dựng NGƯỢC từ `refId` về `externalId` của bảng raw (`streams.ts` sinh xuôi):
 *   `META:<ngày>:<campaign>`               → `<campaign>:<ngày>`
 *   `TIKTOK_ADS:<ngày>:<campaign>`         → `<campaign>:<ngày>`         (GMV Max)
 *   `TIKTOK_ADS:auction:<ngày>:<campaign>` → `auction:<campaign>:<ngày>` (auction)
 * Đổi format `refId` mà quên chỗ này thì con số nhảy vọt — đó là dấu hiệu, không phải nhiễu.
 */
export async function demAdsMoCoi(): Promise<AdsMoCoi> {
  await requireUser();

  // Khoá đối chiếu gộp `nguồn|externalId` để so bằng MỘT phép bằng — Postgres gom được thành
  // hash anti-join. Tách thành 2 điều kiện NOT EXISTS có kèm `nguon = '...'` thì nó phải dò lại
  // bảng raw cho TỪNG dòng chi phí (index raw dẫn đầu bằng `shopId` nên không tra thẳng
  // `externalId` được) — hơn 13.000 dòng × quét cả bảng raw, mỗi lần mở dialog xoá.
  const [row] = await prisma.$queryRaw<{ soDong: number; tongTien: bigint }[]>`
    WITH ads AS (
      SELECT
        e.amount,
        CASE WHEN e."refId" LIKE 'TIKTOK_ADS:auction:%'
          THEN 'TIKTOK_ADS|auction:' || split_part(e."refId", ':', 4) || ':' || split_part(e."refId", ':', 3)
          ELSE split_part(e."refId", ':', 1) || '|' || split_part(e."refId", ':', 3) || ':' || split_part(e."refId", ':', 2)
        END AS khoa
      FROM "Expense" e
      WHERE e.source = 'ADS_API' AND e."refId" IS NOT NULL
    ),
    goc AS (
      SELECT 'META|' || "externalId" AS khoa FROM "RawMetaAdsReport"
      UNION ALL
      SELECT 'TIKTOK_ADS|' || "externalId" FROM "RawTiktokBusinessReport"
    )
    SELECT
      COUNT(*)::int AS "soDong",
      COALESCE(SUM(a.amount), 0)::bigint AS "tongTien"
    FROM ads a
    WHERE NOT EXISTS (SELECT 1 FROM goc g WHERE g.khoa = a.khoa)
  `;

  return { soDong: row?.soDong ?? 0, tongTien: Number(row?.tongTien ?? 0) };
}

export type KetQuaDungLai = {
  ordersUpserted: number;
  /** 4 bộ đếm "Tiền đã về" — bỏ sót thì thông báo im lặng về nửa việc vừa làm. */
  settlementsUpserted: number;
  adsUpserted: number;
  paymentsUpserted: number;
  shopeeUpserted: number;
  /** Số dòng chi tiêu quảng cáo (`Expense` source=ADS_API) dựng lại từ báo cáo trong kho thô. */
  adsExpensesUpserted: number;
  /** Tổng số cảnh báo của lượt dựng lại (danh sách đầy đủ nằm trong nhật ký đồng bộ). */
  soCanhBao: number;
  /** Vài cảnh báo đầu để hiện toast — danh sách đầy đủ có thể rất dài. */
  canhBao: string[];
};

/** Số cảnh báo tối đa trả về client (toast không đọc nổi danh sách dài). */
const SO_CANH_BAO_HIEN = 3;

/**
 * Dựng lại đơn hàng + số liệu "Tiền đã về" TỪ KHO THÔ — đường phục hồi sau khi xoá dữ liệu giao
 * dịch, và cũng là cách chữa "số liệu thiếu". CHỈ upsert theo khoá gốc, KHÔNG xoá gì, chạy bao nhiêu
 * lần cũng ra cùng kết quả nên không cần gõ tên shop.
 *
 * KHÔNG đụng dữ liệu APP-OWNED (`Variant.costPrice`, `lowStockThreshold`, chi phí NHẬP TAY) và cũng
 * KHÔNG đụng sản phẩm/tồn kho — bảo đảm nằm ở `dungLaiGiaoDichTuKhoTho`. Riêng chi tiêu quảng cáo
 * (`Expense` source=ADS_API) thì CÓ dựng lại: kho thô giữ bản gốc báo cáo Meta/TikTok.
 *
 * KHOÁ 1 LƯỢT bằng `SyncLog` RUNNING. Lượt quét cả bảng chạy lâu; qua ~100s Cloudflare cắt kết nối
 * nên client rơi vào nhánh lỗi dù server vẫn đang chạy — chủ shop bấm lại là có 2 lượt chạy song
 * song, mà upsert đơn xoá rồi tạo lại dòng hàng trong cùng transaction ⇒ có thể nhân đôi dòng hàng,
 * COGS gấp đôi, lãi gộp sai âm thầm.
 *
 * Bọc `withSyncLog` để (1) cảnh báo được LƯU vào nhật ký đồng bộ thay vì mất theo toast, (2) nút
 * "Đồng bộ ngay" cũng bị khoá trong lúc dựng lại.
 *
 * BRONZE_ONLY: CỐ Ý không chặn. Công tắc đó bắt Silver đứng yên cho tới khi có một lượt dựng lại
 * TAY — đây chính là lượt đó (UI nói rõ điều này); chặn thì khoá luôn đường phục hồi sau khi xoá.
 */
export async function dungLaiTuKhoTho(): Promise<ActionResult<KetQuaDungLai>> {
  await requireUser();

  if (dangPhucHoi()) return { ok: false, error: LOI_DANG_PHUC_HOI };

  if (await coLuotDangChay("PANCAKE")) {
    return { ok: false, error: "Đang có lượt đồng bộ / dựng lại chạy — chờ xong rồi bấm lại" };
  }

  // Cờ trong-tiến-trình, HẸP hơn `SyncLog` ở trên: chỉ để lượt import file chi phí ads biết mà
  // tránh đường (nó ghi cùng nhóm dòng `Expense` với lượt này) — xem `khoa-bao-tri.ts`.
  if (!thuGiuKhoaDungLai()) {
    return { ok: false, error: "Đang có lượt dựng lại chạy — chờ xong rồi bấm lại" };
  }

  // Khoá Ở DB: loại trừ lẫn nhau với lượt XOÁ dữ liệu và với script dựng lại chạy ở tiến trình
  // riêng. Cờ trong bộ nhớ phía trên không thấy được hai đường đó.
  const khoaDb = await giuKhoaViecNang("dựng lại từ kho thô");
  if (!khoaDb.the) {
    traKhoaDungLai();
    return { ok: false, error: `Đang có "${khoaDb.dangGiu}" chạy — chờ xong rồi bấm lại` };
  }

  const canhBao: string[] = [];
  try {
    const res = await withSyncLog("PANCAKE", async (warnings) => {
      const stats = await dungLaiGiaoDichTuKhoTho(warnings, taoCheckpoint(khoaDb.the));
      canhBao.push(...warnings);
      // `nguon` để đọc nhật ký biết dòng này là lượt bấm tay. KHÔNG ghi khoá `stream`: cổng
      // "lượt kéo API còn sống" của lượt vá tồn kho soi đúng khoá đó, lượt này không được tự
      // chứng nhận cho nó.
      return { nguon: "dung-lai-tay", ...stats };
    });

    // `withSyncLog` viết cho route handler nên trả `Response` — đọc lại body để lấy số liệu.
    const body = (await res.json()) as
      | { ok: true; stats: TransformStats }
      | { ok: false; error: string };
    if (!body.ok) {
      return { ok: false, error: `Dựng lại thất bại: ${body.error}` };
    }

    revalidatePath("/", "layout");
    return {
      ok: true,
      data: {
        ordersUpserted: body.stats.ordersUpserted,
        settlementsUpserted: body.stats.settlementsUpserted,
        adsUpserted: body.stats.adsUpserted,
        paymentsUpserted: body.stats.paymentsUpserted,
        shopeeUpserted: body.stats.shopeeUpserted,
        adsExpensesUpserted: body.stats.adsExpensesUpserted,
        soCanhBao: canhBao.length,
        canhBao: canhBao.slice(0, SO_CANH_BAO_HIEN),
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? `Dựng lại thất bại: ${err.message}` : "Dựng lại thất bại",
    };
  } finally {
    await traKhoaViecNang(khoaDb.the);
    traKhoaDungLai();
  }
}
