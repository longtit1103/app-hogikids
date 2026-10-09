import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  apMigrations,
  type DbMigration,
  lechSchemaVoiDb,
  moDbMigration,
  saoThuMucMigrations,
  xoaThuMucMigrationsTam,
} from "../helpers/db-migration-dung-mot-lan";

/**
 * CHECK của "Nợ phải trả" (thẻ tín dụng + tiền hàng NCC + ví ads trả trước) chạy trên DB migration
 * dùng-một-lần: áp TOÀN BỘ migration của repo lên schema trắng rồi INSERT thẳng bằng SQL dữ liệu sai —
 * mỗi ca phải bị Postgres từ chối với ĐÚNG tên constraint (tên là hợp đồng công khai: action P3/P4 dịch
 * lỗi theo tên). Đi đường SQL thô, không qua zod/action: đây là lớp chặn CUỐI, phải tự đứng được.
 *
 * Kèm phép so schema thật ↔ `schema.prisma` (`prisma migrate diff`): migration viết tay mà lệch
 * schema là `migrate dev` lượt sau tự sinh migration "sửa" lặng lẽ.
 */

const HAN = 240_000; // `prisma migrate deploy` toàn bộ ~70 migration + `migrate diff` qua Tailscale

let db: DbMigration;
let thuMuc: string;

/** Id cố định của các hồ sơ seed sẵn — mọi ca INSERT trỏ vào đây. */
const ID = {
  loan: "np-loan-1",
  so: "np-so-1",
  the: "np-the-1",
  phieu: "np-phieu-1",
  vi: "np-vi-1",
  danhMuc: "np-dm-ads",
} as const;

let dem = 0;
const idMoi = (tienTo: string) => `${tienTo}-${++dem}`;

type DongTien = {
  kind: string;
  description?: string;
  loanId?: string | null;
  savingsId?: string | null;
  cardId?: string | null;
  phieuNhapId?: string | null;
  viAdsId?: string | null;
};

/** INSERT một dòng `CashMovement` bằng SQL thô (tham số hoá) — không qua zod, không qua Prisma ORM. */
function chenDongTien(d: DongTien): Promise<number> {
  return db.prisma.$executeRawUnsafe(
    `INSERT INTO "CashMovement" ("id", "date", "kind", "amount", "description", "loanId", "savingsId", "cardId", "phieuNhapId", "viAdsId")
     VALUES ($1, '2026-11-05T00:00:00+07:00', $2::"CashMovementKind", 1000000, $3, $4, $5, $6, $7, $8)`,
    idMoi("np-cm"),
    d.kind,
    d.description ?? "",
    d.loanId ?? null,
    d.savingsId ?? null,
    d.cardId ?? null,
    d.phieuNhapId ?? null,
    d.viAdsId ?? null,
  );
}

function chenKySaoKe(p: { soDu: number; laNeoMoSo: boolean; hanTra: string | null; ngayChot: string }): Promise<number> {
  return db.prisma.$executeRawUnsafe(
    `INSERT INTO "KySaoKeThe" ("id", "cardId", "ngayChot", "soDu", "hanTra", "laNeoMoSo")
     VALUES ($1, $2, $3::timestamp, $4, $5::timestamp, $6)`,
    idMoi("np-ky"),
    ID.the,
    p.ngayChot,
    p.soDu,
    p.hanTra,
    p.laNeoMoSo,
  );
}

function chenThe(p: { ngayChotSaoKe: number; ngayHanTra: number }): Promise<number> {
  return db.prisma.$executeRawUnsafe(
    `INSERT INTO "TheTinDung" ("id", "ten", "ngayChotSaoKe", "ngayHanTra") VALUES ($1, 'Thẻ thử', $2, $3)`,
    idMoi("np-the"),
    p.ngayChotSaoKe,
    p.ngayHanTra,
  );
}

function chenChiPhi(p: { source: string; cardId: string | null; recurringId?: string; recurringMonth?: string }): Promise<number> {
  return db.prisma.$executeRawUnsafe(
    `INSERT INTO "Expense" ("id", "date", "categoryId", "description", "amount", "source", "cardId", "recurringId", "recurringMonth")
     VALUES ($1, '2026-11-05T00:00:00+07:00', $2, 'chi thử', 500000, $3::"ExpenseSource", $4, $5, $6)`,
    idMoi("np-exp"),
    ID.danhMuc,
    p.source,
    p.cardId,
    p.recurringId ?? null,
    p.recurringMonth ?? null,
  );
}

beforeAll(async () => {
  db = await moDbMigration();
  await db.datLai();
  thuMuc = saoThuMucMigrations();
  apMigrations(db.url, thuMuc);

  // Hồ sơ cha cho mọi khoá — seed bằng SQL thô cùng lý do với các ca dưới.
  await db.prisma.$executeRawUnsafe(
    `INSERT INTO "Loan" ("id", "name", "startDate") VALUES ('${ID.loan}', 'Vay thử', '2026-09-01T00:00:00+07:00')`,
  );
  await db.prisma.$executeRawUnsafe(
    `INSERT INTO "SoTietKiem" ("id", "name", "principal", "startDate", "termMonths", "maturityDate", "annualRateBp")
     VALUES ('${ID.so}', 'Sổ thử', 100000000, '2026-09-01T00:00:00+07:00', 6, '2027-03-01T00:00:00+07:00', 500)`,
  );
  await db.prisma.$executeRawUnsafe(
    `INSERT INTO "TheTinDung" ("id", "ten", "ngayChotSaoKe", "ngayHanTra") VALUES ('${ID.the}', 'Thẻ VPBank', 25, 10)`,
  );
  await db.prisma.$executeRawUnsafe(
    `INSERT INTO "PhieuNhapNo" ("id", "refId", "shopId", "maPhieu", "ngayPhieu", "tongTien")
     VALUES ('${ID.phieu}', 'PURCHASE:714995134:1', '714995134', 'PN-1', '2026-10-20T00:00:00+07:00', 53600000)`,
  );
  await db.prisma.$executeRawUnsafe(
    `INSERT INTO "ViAdsTraTruoc" ("id", "nenTang", "soDuNeo", "ngayNeo") VALUES ('${ID.vi}', 'SHOPEE_ADS', 0, '2026-10-31T23:59:59+07:00')`,
  );
  await db.prisma.$executeRawUnsafe(`INSERT INTO "ExpenseCategory" ("id", "name") VALUES ('${ID.danhMuc}', 'Quảng cáo thử')`);
}, HAN);

afterAll(async () => {
  if (thuMuc) xoaThuMucMigrationsTam(thuMuc);
  await db?.dong();
});

describe("schema thật sau migration khớp schema.prisma", () => {
  it(
    "prisma migrate diff (DB ← schema.prisma) không ra câu nào chạm đối tượng nợ phải trả",
    () => {
      // Soi theo TÊN đối tượng của migration này thay vì đòi diff rỗng tuyệt đối: đối tượng raw SQL
      // có sẵn từ trước (index biểu thức của M1…) Prisma có thể liệt kê như lệch dù không liên quan.
      const lech = lechSchemaVoiDb(db.url, thuMuc) ?? "";
      expect(lech).not.toMatch(
        /TheTinDung|KySaoKeThe|GanNenTangThe|PhieuNhapNo|YeuCauGhi|ViAdsTraTruoc|cardId|phieuNhapId|viAdsId|yeuCauId|CashMovementKind/,
      );
    },
    HAN,
  );

  it("pg_constraint có đủ CHECK mới — và GIỮ `CashMovement_loan_savings_loai_tru` cũ (tên là hợp đồng)", async () => {
    const rows = await db.prisma.$queryRawUnsafe<{ conname: string }[]>(
      `SELECT c.conname::text AS conname FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE c.contype = 'c' AND n.nspname = 'app'`,
    );
    expect(rows.map((r) => r.conname)).toEqual(
      expect.arrayContaining([
        "CashMovement_toi_da_mot_ho_so",
        "CashMovement_kind_khoa_bat_buoc",
        "CashMovement_loan_savings_loai_tru",
        "CashMovement_loan_bat_buoc",
        "CashMovement_savings_bat_buoc",
        "CashMovement_savings_dung_cho",
        "KySaoKeThe_so_du_khong_am",
        "KySaoKeThe_neo_mo_so_khong_han",
        "KySaoKeThe_sao_ke_co_han",
        "Expense_card_chi_manual",
        "TheTinDung_ngay_1_31",
        "PhieuNhapNo_tien_khong_am",
        "KySaoKeThe_da_tra_truoc_khong_am",
        "ViAdsTraTruoc_so_du_neo_khong_am",
      ]),
    );
  });
});

describe("CashMovement — kind mới ↔ khoá hồ sơ", () => {
  const KIND = /CashMovement_kind_khoa_bat_buoc/;

  it("đối chứng: dòng ĐÚNG của từng kind mới ghi được", async () => {
    await expect(chenDongTien({ kind: "CARD_PAY", cardId: ID.the })).resolves.toBe(1);
    await expect(chenDongTien({ kind: "SUPPLIER_PAY", phieuNhapId: ID.phieu })).resolves.toBe(1);
    await expect(chenDongTien({ kind: "SUPPLIER_REFUND", phieuNhapId: ID.phieu })).resolves.toBe(1);
    await expect(chenDongTien({ kind: "CUTOVER_ADJ_IN", description: "Điều chỉnh mở sổ nợ" })).resolves.toBe(1);
    await expect(chenDongTien({ kind: "CUTOVER_ADJ_OUT", description: "Điều chỉnh mở sổ nợ" })).resolves.toBe(1);
    await expect(chenDongTien({ kind: "ADS_TOPUP", viAdsId: ID.vi })).resolves.toBe(1);
    // Kind cũ không khoá vẫn ghi được — CHECK mới không được làm vỡ dòng hiện có.
    await expect(chenDongTien({ kind: "CAPITAL_IN" })).resolves.toBe(1);
    await expect(chenDongTien({ kind: "LOAN_IN", loanId: ID.loan })).resolves.toBe(1);
    await expect(chenDongTien({ kind: "SAVINGS_OUT", savingsId: ID.so })).resolves.toBe(1);
  });

  it("CARD_PAY thiếu cardId bị từ chối", async () => {
    await expect(chenDongTien({ kind: "CARD_PAY" })).rejects.toThrow(KIND);
  });

  it("SUPPLIER_PAY / SUPPLIER_REFUND thiếu phieuNhapId bị từ chối", async () => {
    await expect(chenDongTien({ kind: "SUPPLIER_PAY" })).rejects.toThrow(KIND);
    await expect(chenDongTien({ kind: "SUPPLIER_REFUND" })).rejects.toThrow(KIND);
  });

  it("CUTOVER mang cardId bị từ chối", async () => {
    await expect(chenDongTien({ kind: "CUTOVER_ADJ_IN", description: "x", cardId: ID.the })).rejects.toThrow(KIND);
  });

  it("CUTOVER mang loanId bị từ chối", async () => {
    await expect(chenDongTien({ kind: "CUTOVER_ADJ_OUT", description: "x", loanId: ID.loan })).rejects.toThrow(KIND);
  });

  it("CUTOVER mang savingsId bị từ chối", async () => {
    // `CashMovement_savings_dung_cho` cũng đỏ — Postgres báo constraint đầu tiên theo thứ tự tên.
    await expect(chenDongTien({ kind: "CUTOVER_ADJ_IN", description: "x", savingsId: ID.so })).rejects.toThrow(
      /CashMovement_kind_khoa_bat_buoc|CashMovement_savings_dung_cho/,
    );
  });

  it("CUTOVER mang phieuNhapId / viAdsId bị từ chối", async () => {
    await expect(chenDongTien({ kind: "CUTOVER_ADJ_IN", description: "x", phieuNhapId: ID.phieu })).rejects.toThrow(KIND);
    await expect(chenDongTien({ kind: "CUTOVER_ADJ_OUT", description: "x", viAdsId: ID.vi })).rejects.toThrow(KIND);
  });

  it("CUTOVER mô tả rỗng (hoặc toàn khoảng trắng) bị từ chối", async () => {
    await expect(chenDongTien({ kind: "CUTOVER_ADJ_IN", description: "" })).rejects.toThrow(KIND);
    await expect(chenDongTien({ kind: "CUTOVER_ADJ_OUT", description: "   " })).rejects.toThrow(KIND);
  });

  it("kind cũ mang cardId / phieuNhapId / viAdsId bị từ chối", async () => {
    await expect(chenDongTien({ kind: "CAPITAL_OUT", cardId: ID.the })).rejects.toThrow(KIND);
    await expect(chenDongTien({ kind: "OTHER_IN", phieuNhapId: ID.phieu })).rejects.toThrow(KIND);
    await expect(chenDongTien({ kind: "OTHER_IN", viAdsId: ID.vi })).rejects.toThrow(KIND);
  });

  it("dòng mang cả loanId lẫn cardId bị từ chối (tối đa MỘT hồ sơ)", async () => {
    // CARD_PAY có cardId nên `kind_khoa_bat_buoc` qua — chỉ còn luật "tối đa một hồ sơ" bắt.
    await expect(chenDongTien({ kind: "CARD_PAY", cardId: ID.the, loanId: ID.loan })).rejects.toThrow(
      /CashMovement_toi_da_mot_ho_so/,
    );
    await expect(chenDongTien({ kind: "SUPPLIER_PAY", phieuNhapId: ID.phieu, cardId: ID.the })).rejects.toThrow(
      /CashMovement_toi_da_mot_ho_so/,
    );
  });

  it("loanId + savingsId vẫn bị từ chối bởi constraint CŨ (tên giữ nguyên)", async () => {
    await expect(chenDongTien({ kind: "SAVINGS_OUT", savingsId: ID.so, loanId: ID.loan })).rejects.toThrow(
      /CashMovement_loan_savings_loai_tru/,
    );
  });
});

describe("CashMovement — ADS_TOPUP (ví ads trả trước, S1)", () => {
  it("ADS_TOPUP thiếu viAdsId bị từ chối", async () => {
    await expect(chenDongTien({ kind: "ADS_TOPUP" })).rejects.toThrow(/CashMovement_kind_khoa_bat_buoc/);
    await expect(chenDongTien({ kind: "ADS_TOPUP", cardId: ID.the })).rejects.toThrow(/CashMovement_kind_khoa_bat_buoc/);
  });

  it("CARD_PAY mang viAdsId bị từ chối", async () => {
    await expect(chenDongTien({ kind: "CARD_PAY", cardId: ID.the, viAdsId: ID.vi })).rejects.toThrow(
      /CashMovement_kind_khoa_bat_buoc/,
    );
  });

  it("ADS_TOPUP + cardId + viAdsId ⇒ OK (nạp ví từ thẻ: hai khoá được phép)", async () => {
    await expect(chenDongTien({ kind: "ADS_TOPUP", viAdsId: ID.vi, cardId: ID.the })).resolves.toBe(1);
  });

  it("ADS_TOPUP mang loanId / savingsId / phieuNhapId bị từ chối", async () => {
    await expect(chenDongTien({ kind: "ADS_TOPUP", viAdsId: ID.vi, loanId: ID.loan })).rejects.toThrow(
      /CashMovement_kind_khoa_bat_buoc/,
    );
    await expect(chenDongTien({ kind: "ADS_TOPUP", viAdsId: ID.vi, phieuNhapId: ID.phieu })).rejects.toThrow(
      /CashMovement_kind_khoa_bat_buoc/,
    );
    await expect(chenDongTien({ kind: "ADS_TOPUP", viAdsId: ID.vi, savingsId: ID.so })).rejects.toThrow(
      /CashMovement_kind_khoa_bat_buoc|CashMovement_savings_dung_cho/,
    );
  });
});

describe("KySaoKeThe", () => {
  it("đối chứng: neo mở sổ (không hạn) và sao kê thật (có hạn) ghi được; soDu 0 hợp lệ", async () => {
    await expect(chenKySaoKe({ soDu: 0, laNeoMoSo: true, hanTra: null, ngayChot: "2026-10-31" })).resolves.toBe(1);
    await expect(
      chenKySaoKe({ soDu: 12_000_000, laNeoMoSo: false, hanTra: "2026-11-10", ngayChot: "2026-10-25" }),
    ).resolves.toBe(1);
  });

  it("soDu −1 bị từ chối", async () => {
    await expect(chenKySaoKe({ soDu: -1, laNeoMoSo: true, hanTra: null, ngayChot: "2026-09-30" })).rejects.toThrow(
      /KySaoKeThe_so_du_khong_am/,
    );
  });

  it("neo mở sổ mà có hanTra bị từ chối", async () => {
    await expect(
      chenKySaoKe({ soDu: 1, laNeoMoSo: true, hanTra: "2026-11-10", ngayChot: "2026-09-29" }),
    ).rejects.toThrow(/KySaoKeThe_neo_mo_so_khong_han/);
  });

  it("sao kê thật thiếu hanTra bị từ chối", async () => {
    await expect(chenKySaoKe({ soDu: 1, laNeoMoSo: false, hanTra: null, ngayChot: "2026-09-28" })).rejects.toThrow(
      /KySaoKeThe_sao_ke_co_han/,
    );
  });

  it("daTraTruocMoSo −1 bị từ chối", async () => {
    await expect(
      db.prisma.$executeRawUnsafe(
        `INSERT INTO "KySaoKeThe" ("id", "cardId", "ngayChot", "soDu", "hanTra", "daTraTruocMoSo")
         VALUES ($1, $2, '2026-09-25'::timestamp, 1, '2026-10-10'::timestamp, -1)`,
        idMoi("np-ky"),
        ID.the,
      ),
    ).rejects.toThrow(/KySaoKeThe_da_tra_truoc_khong_am/);
  });

  it("neo mở sổ THỨ HAI của cùng thẻ bị từ chối (một neo mở sổ mỗi thẻ); thẻ khác vẫn có neo riêng", async () => {
    // Ca đối chứng đầu describe đã ghi neo mở sổ 31/10 cho `ID.the`.
    await expect(chenKySaoKe({ soDu: 5, laNeoMoSo: true, hanTra: null, ngayChot: "2026-09-27" })).rejects.toThrow(
      /KySaoKeThe_mot_neo_mo_so_moi_the/,
    );
    const theKhac = idMoi("np-the");
    await db.prisma.$executeRawUnsafe(
      `INSERT INTO "TheTinDung" ("id", "ten", "ngayChotSaoKe", "ngayHanTra") VALUES ($1, 'Thẻ thứ hai', 20, 5)`,
      theKhac,
    );
    await expect(
      db.prisma.$executeRawUnsafe(
        `INSERT INTO "KySaoKeThe" ("id", "cardId", "ngayChot", "soDu", "laNeoMoSo") VALUES ($1, $2, '2026-10-31'::timestamp, 0, true)`,
        idMoi("np-ky"),
        theKhac,
      ),
    ).resolves.toBe(1);
  });
});

describe("tiền không âm — phiếu nhập nợ, ví ads trả trước", () => {
  it("PhieuNhapNo tongTien −1 / daTraTruoc −1 bị từ chối; 0 hợp lệ", async () => {
    const chenPhieu = (tongTien: number, daTraTruoc: number) =>
      db.prisma.$executeRawUnsafe(
        `INSERT INTO "PhieuNhapNo" ("id", "refId", "shopId", "maPhieu", "ngayPhieu", "tongTien", "daTraTruoc")
         VALUES ($1, $2, '714995134', 'PN-am', '2026-10-20T00:00:00+07:00', $3, $4)`,
        idMoi("np-phieu"),
        idMoi("PURCHASE:714995134"),
        tongTien,
        daTraTruoc,
      );
    await expect(chenPhieu(-1, 0)).rejects.toThrow(/PhieuNhapNo_tien_khong_am/);
    await expect(chenPhieu(1_000_000, -1)).rejects.toThrow(/PhieuNhapNo_tien_khong_am/);
    await expect(chenPhieu(0, 0)).resolves.toBe(1);
  });

  it("ViAdsTraTruoc soDuNeo −1 bị từ chối", async () => {
    await expect(
      db.prisma.$executeRawUnsafe(
        `INSERT INTO "ViAdsTraTruoc" ("id", "nenTang", "soDuNeo", "ngayNeo") VALUES ($1, 'META_AM', -1, '2026-10-31T23:59:59+07:00')`,
        idMoi("np-vi"),
      ),
    ).rejects.toThrow(/ViAdsTraTruoc_so_du_neo_khong_am/);
  });
});

describe("Expense.cardId chỉ cho dòng nhập tay", () => {
  it("đối chứng: MANUAL + cardId ghi được", async () => {
    await expect(chenChiPhi({ source: "MANUAL", cardId: ID.the })).resolves.toBe(1);
  });

  it("ADS_API + cardId bị từ chối", async () => {
    await expect(chenChiPhi({ source: "ADS_API", cardId: ID.the })).rejects.toThrow(/Expense_card_chi_manual/);
  });

  it("IMPORT + cardId bị từ chối", async () => {
    await expect(chenChiPhi({ source: "IMPORT", cardId: ID.the })).rejects.toThrow(/Expense_card_chi_manual/);
  });

  it("RECURRING + cardId bị từ chối (định kỳ chưa hỗ trợ thẻ)", async () => {
    await expect(
      chenChiPhi({ source: "RECURRING", cardId: ID.the, recurringId: "np-mau-1", recurringMonth: "2026-11" }),
    ).rejects.toThrow(/Expense_card_chi_manual/);
  });
});

describe("TheTinDung — ngày chốt / hạn trả 1..31", () => {
  it("đối chứng: 1 và 31 ghi được", async () => {
    await expect(chenThe({ ngayChotSaoKe: 1, ngayHanTra: 31 })).resolves.toBe(1);
  });

  it("ngayChotSaoKe 0 và 32 bị từ chối", async () => {
    await expect(chenThe({ ngayChotSaoKe: 0, ngayHanTra: 10 })).rejects.toThrow(/TheTinDung_ngay_1_31/);
    await expect(chenThe({ ngayChotSaoKe: 32, ngayHanTra: 10 })).rejects.toThrow(/TheTinDung_ngay_1_31/);
  });

  it("ngayHanTra 0 và 32 bị từ chối", async () => {
    await expect(chenThe({ ngayChotSaoKe: 25, ngayHanTra: 0 })).rejects.toThrow(/TheTinDung_ngay_1_31/);
    await expect(chenThe({ ngayChotSaoKe: 25, ngayHanTra: 32 })).rejects.toThrow(/TheTinDung_ngay_1_31/);
  });
});

describe("khoá ngoại Restrict — hồ sơ còn dòng tiền thì không xoá được", () => {
  it("xoá thẻ / phiếu / ví đang có dòng tiền trỏ tới bị từ chối", async () => {
    await expect(db.prisma.$executeRawUnsafe(`DELETE FROM "TheTinDung" WHERE "id" = '${ID.the}'`)).rejects.toThrow(
      /foreign key|23503/i,
    );
    await expect(db.prisma.$executeRawUnsafe(`DELETE FROM "PhieuNhapNo" WHERE "id" = '${ID.phieu}'`)).rejects.toThrow(
      /foreign key|23503/i,
    );
    await expect(db.prisma.$executeRawUnsafe(`DELETE FROM "ViAdsTraTruoc" WHERE "id" = '${ID.vi}'`)).rejects.toThrow(
      /foreign key|23503/i,
    );
  });
});
