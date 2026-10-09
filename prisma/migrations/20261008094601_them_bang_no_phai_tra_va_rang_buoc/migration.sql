-- Nợ phải trả: 6 bảng mới (TheTinDung, KySaoKeThe, GanNenTangThe, PhieuNhapNo, YeuCauGhi,
-- ViAdsTraTruoc) + cột "cardId"/"phieuNhapId"/"viAdsId"/"yeuCauId" trên CashMovement + "cardId" trên
-- Expense + toàn bộ CHECK.
--
-- TÁCH khỏi file …_them_loai_dong_tien_no_phai_tra vì Postgres cấm dùng giá trị enum mới trong chính
-- transaction đã `ALTER TYPE … ADD VALUE` ra nó (55P04) — xem chú thích đầu file đó.
--
-- CHỈ THÊM (bảng mới, cột nullable mới) — không sửa, không xoá dòng nào đang có ⇒ migrate deploy prod
-- KHÔNG cần tiền kiểm. Mọi CHECK trên "CashMovement"/"Expense" thoả với MỌI dòng prod hiện có: bốn
-- cột khoá mới vừa thêm nên toàn NULL, và chưa dòng nào mang sáu kind mới. Công tắc
-- `Setting.noPhaiTraTuNgay` chưa có ⇒ không đường ghi nào dùng tới các bảng này cho tới bước bật.

-- AlterTable
ALTER TABLE "Expense" ADD COLUMN     "cardId" TEXT;

-- AlterTable
ALTER TABLE "CashMovement" ADD COLUMN     "cardId" TEXT,
ADD COLUMN     "phieuNhapId" TEXT,
ADD COLUMN     "viAdsId" TEXT,
ADD COLUMN     "yeuCauId" TEXT;

-- CreateTable
CREATE TABLE "TheTinDung" (
    "id" TEXT NOT NULL,
    "ten" TEXT NOT NULL,
    "nganHang" TEXT NOT NULL DEFAULT '',
    "ngayChotSaoKe" INTEGER NOT NULL,
    "ngayHanTra" INTEGER NOT NULL,
    "closedAt" TIMESTAMP(3),
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TheTinDung_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KySaoKeThe" (
    "id" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "ngayChot" TIMESTAMP(3) NOT NULL,
    "soDu" INTEGER NOT NULL,
    "hanTra" TIMESTAMP(3),
    "daTraTruocMoSo" INTEGER NOT NULL DEFAULT 0,
    "laNeoMoSo" BOOLEAN NOT NULL DEFAULT false,
    "uocTinhLucChot" INTEGER,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KySaoKeThe_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GanNenTangThe" (
    "id" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "nenTang" TEXT NOT NULL,
    "tuNgay" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GanNenTangThe_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhieuNhapNo" (
    "id" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "maPhieu" TEXT NOT NULL,
    "ngayPhieu" TIMESTAMP(3) NOT NULL,
    "tongTien" INTEGER NOT NULL,
    "daTraTruoc" INTEGER NOT NULL DEFAULT 0,
    "daHuy" BOOLEAN NOT NULL DEFAULT false,
    "lechDaGiaiThich" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PhieuNhapNo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "YeuCauGhi" (
    "id" TEXT NOT NULL,
    "loai" TEXT NOT NULL,
    "bamNoiDung" TEXT NOT NULL,
    "ketQua" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "YeuCauGhi_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ViAdsTraTruoc" (
    "id" TEXT NOT NULL,
    "nenTang" TEXT NOT NULL,
    "soDuNeo" INTEGER NOT NULL,
    "ngayNeo" TIMESTAMP(3) NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ViAdsTraTruoc_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "KySaoKeThe_cardId_ngayChot_key" ON "KySaoKeThe"("cardId", "ngayChot");

-- CreateIndex
CREATE INDEX "GanNenTangThe_cardId_idx" ON "GanNenTangThe"("cardId");

-- CreateIndex
CREATE UNIQUE INDEX "GanNenTangThe_nenTang_tuNgay_key" ON "GanNenTangThe"("nenTang", "tuNgay");

-- CreateIndex
CREATE UNIQUE INDEX "PhieuNhapNo_refId_key" ON "PhieuNhapNo"("refId");

-- CreateIndex
CREATE INDEX "PhieuNhapNo_ngayPhieu_idx" ON "PhieuNhapNo"("ngayPhieu");

-- CreateIndex
CREATE UNIQUE INDEX "ViAdsTraTruoc_nenTang_key" ON "ViAdsTraTruoc"("nenTang");

-- CreateIndex
CREATE INDEX "Expense_cardId_idx" ON "Expense"("cardId");

-- CreateIndex
CREATE INDEX "CashMovement_cardId_idx" ON "CashMovement"("cardId");

-- CreateIndex
CREATE INDEX "CashMovement_phieuNhapId_idx" ON "CashMovement"("phieuNhapId");

-- CreateIndex
CREATE INDEX "CashMovement_viAdsId_idx" ON "CashMovement"("viAdsId");

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "TheTinDung"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "TheTinDung"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_phieuNhapId_fkey" FOREIGN KEY ("phieuNhapId") REFERENCES "PhieuNhapNo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_viAdsId_fkey" FOREIGN KEY ("viAdsId") REFERENCES "ViAdsTraTruoc"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KySaoKeThe" ADD CONSTRAINT "KySaoKeThe_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "TheTinDung"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GanNenTangThe" ADD CONSTRAINT "GanNenTangThe_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "TheTinDung"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── CHECK viết tay ───────────────────────────────────────────────────────────
-- Prisma KHÔNG quản CHECK và KHÔNG báo drift (tiền lệ "CashMovement_amount_duong", migration
-- 20260902130946). Tên constraint là HỢP ĐỒNG CÔNG KHAI: test tích hợp và thông báo lỗi của action
-- khoá theo tên — đổi tên là phá hợp đồng.

-- Một dòng tiền thuộc TỐI ĐA MỘT hồ sơ: khoản vay · sổ tiết kiệm · thẻ · phiếu nhập · ví ads. Dính hai
-- hồ sơ thì mỗi trục số dư/dư nợ đều cộng nhầm đúng số tiền đó. Ngoại lệ DUY NHẤT: `ADS_TOPUP` nạp ví
-- BẰNG THẺ mang cả "viAdsId" lẫn "cardId" (dòng nối ví ↔ thẻ, không chạm quỹ) — luật kind↔khoá bên
-- dưới bảo đảm hai khoá đó là đúng "viAdsId" + "cardId", không phải cặp nào khác.
--
-- GIỮ NGUYÊN "CashMovement_loan_savings_loai_tru" (file 20260916044938) dù constraint này đã bao trùm:
-- tên cũ là hợp đồng công khai (test tích hợp sổ tiết kiệm + chú thích action khoá theo tên). Hai
-- constraint cùng đỏ với dòng loanId+savingsId; Postgres báo tên đầu theo thứ tự chữ cái (tên cũ).
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_toi_da_mot_ho_so" CHECK (
  (("loanId" IS NOT NULL)::int + ("savingsId" IS NOT NULL)::int + ("cardId" IS NOT NULL)::int
    + ("phieuNhapId" IS NOT NULL)::int + ("viAdsId" IS NOT NULL)::int)
  <= CASE WHEN "kind" = 'ADS_TOPUP' THEN 2 ELSE 1 END
);

-- Kind ↔ khoá bắt buộc / bị cấm của sáu kind mới (kind cũ giữ luật của "CashMovement_loan_bat_buoc",
-- "CashMovement_savings_bat_buoc", "CashMovement_savings_dung_cho"):
--  - CARD_PAY phải gắn thẻ; SUPPLIER_* phải gắn phiếu — thiếu là tiền "mồ côi", không trừ được vào nợ nào.
--  - CUTOVER_* KHÔNG gắn hồ sơ nào (cả 5 khoá NULL) và mô tả bắt buộc (không tính khoảng trắng): đó là
--    điều chỉnh quỹ một lần tại mốc M, người đọc sổ phải biết vì sao có nó.
--  - ADS_TOPUP phải gắn ví; được thêm "cardId" (nạp bằng thẻ); cấm khoản vay/sổ/phiếu.
--  - Kind KHÁC (10 kind cũ) cấm "cardId"/"phieuNhapId"/"viAdsId": dòng "Rút vốn" lỡ mang cardId sẽ âm
--    thầm nằm trong dư nợ thẻ.
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_kind_khoa_bat_buoc" CHECK (
  CASE "kind"
    WHEN 'CARD_PAY' THEN "cardId" IS NOT NULL AND "viAdsId" IS NULL
    WHEN 'SUPPLIER_PAY' THEN "phieuNhapId" IS NOT NULL AND "viAdsId" IS NULL
    WHEN 'SUPPLIER_REFUND' THEN "phieuNhapId" IS NOT NULL AND "viAdsId" IS NULL
    WHEN 'CUTOVER_ADJ_IN' THEN "loanId" IS NULL AND "savingsId" IS NULL AND "cardId" IS NULL
      AND "phieuNhapId" IS NULL AND "viAdsId" IS NULL AND btrim("description") <> ''
    WHEN 'CUTOVER_ADJ_OUT' THEN "loanId" IS NULL AND "savingsId" IS NULL AND "cardId" IS NULL
      AND "phieuNhapId" IS NULL AND "viAdsId" IS NULL AND btrim("description") <> ''
    WHEN 'ADS_TOPUP' THEN "viAdsId" IS NOT NULL AND "loanId" IS NULL AND "savingsId" IS NULL
      AND "phieuNhapId" IS NULL
    ELSE "cardId" IS NULL AND "phieuNhapId" IS NULL AND "viAdsId" IS NULL
  END
);

-- Dư nợ thẻ tại neo không âm (thẻ trả thừa thì ngân hàng ghi có, dư nợ 0 — phần thừa không phải nợ).
ALTER TABLE "KySaoKeThe" ADD CONSTRAINT "KySaoKeThe_so_du_khong_am" CHECK ("soDu" >= 0);
-- Neo mở sổ (M−1) không phải một kỳ sao kê nên không có hạn trả.
ALTER TABLE "KySaoKeThe" ADD CONSTRAINT "KySaoKeThe_neo_mo_so_khong_han" CHECK (NOT "laNeoMoSo" OR "hanTra" IS NULL);
-- Sao kê thật luôn có hạn trả — thiếu thì không biết kỳ nào quá hạn.
ALTER TABLE "KySaoKeThe" ADD CONSTRAINT "KySaoKeThe_sao_ke_co_han" CHECK ("laNeoMoSo" OR "hanTra" IS NOT NULL);

-- Chỉ chi phí NHẬP TAY được gắn thẻ: ads ADS_API/IMPORT suy thẻ từ "GanNenTangThe" (gắn tay thêm là
-- một dòng hai thẻ), định kỳ (RECURRING) chưa hỗ trợ thẻ.
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_card_chi_manual" CHECK ("cardId" IS NULL OR "source" = 'MANUAL');

-- Ngày chốt / hạn trả là NGÀY TRONG THÁNG; tháng thiếu ngày đó thì app lấy ngày cuối tháng.
ALTER TABLE "TheTinDung" ADD CONSTRAINT "TheTinDung_ngay_1_31" CHECK (
  "ngayChotSaoKe" BETWEEN 1 AND 31 AND "ngayHanTra" BETWEEN 1 AND 31
);

-- Tiền không âm: tổng phiếu nợ, phần đã trả trước M, phần kỳ sao kê đã trả trước M, số dư ví neo.
-- Số âm ở đây là nợ/quỹ lệch dấu lặng lẽ — zod ở action chặn trước, CHECK là lớp chặn cuối.
ALTER TABLE "PhieuNhapNo" ADD CONSTRAINT "PhieuNhapNo_tien_khong_am" CHECK ("tongTien" >= 0 AND "daTraTruoc" >= 0);
ALTER TABLE "KySaoKeThe" ADD CONSTRAINT "KySaoKeThe_da_tra_truoc_khong_am" CHECK ("daTraTruocMoSo" >= 0);
ALTER TABLE "ViAdsTraTruoc" ADD CONSTRAINT "ViAdsTraTruoc_so_du_neo_khong_am" CHECK ("soDuNeo" >= 0);
-- Mỗi thẻ đúng MỘT neo mở sổ (M−1): hai neo là hai điểm xuất phát dư nợ, công thức chọn neo nào cũng sai.
-- Partial unique — Prisma không biểu diễn được, nằm ngoài schema.prisma (tiền lệ `User_owner_duy_nhat`).
CREATE UNIQUE INDEX "KySaoKeThe_mot_neo_mo_so_moi_the" ON "KySaoKeThe" ("cardId") WHERE "laNeoMoSo";
