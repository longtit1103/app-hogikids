import type { CashMovement, Prisma } from "@/generated/prisma/client";
import { format } from "date-fns";

import { KIND_LAI_NHAP_GOC } from "@/lib/cash-movements/cash-movement-kinds";
import { khoaNgayVn } from "@/lib/so-quy/dong-chay-so-quy";

/**
 * CẶP KỲ LÃI NHẬP GỐC — dòng `Expense` lãi kỳ (`refId` `LOAN:{loanId}:{yyyy-MM-dd}`) và dòng `CashMovement`
 * `LAI_NHAP_GOC` cùng số, cùng ngày kỳ, gắn cùng khoản vay. Duyệt kỳ ghi cả hai trong MỘT transaction
 * (`chayGhiKy`); sửa số tiền / xoá / khôi phục dòng lãi phải kéo theo dòng nhập gốc — lệch một vế là quỹ
 * lệch đúng số lãi (dòng `Expense` trừ quỹ, dòng nhập gốc cộng lại) hoặc dư nợ lệch khỏi lãi đã vào P&L.
 *
 * KHOÁ CẶP = (loanId, ngày kỳ VN) suy từ `refId` của dòng lãi — không cần cột nối riêng: `Expense.refId`
 * unique + index duy nhất `CashMovement_lai_nhap_goc_mot_ky` (loanId, date) WHERE kind = LAI_NHAP_GOC giữ
 * mỗi khoá đúng một dòng mỗi bên. Module chỉ ĐỌC; câu ghi nằm ở chính các action (lưới AST dòng tiền đòi
 * cổng + khoá trong cùng hàm ghi).
 */

/** Tiền tố `refId` của dòng lãi do duyệt kỳ trả nợ / tất toán thấu chi sinh ra. */
const TIEN_TO_REF_LAI_KY = "LOAN:";

/** `refId` của dòng lãi kỳ: `LOAN:{loanId}:{yyyy-MM-dd}` (ngày theo TZ tiến trình — neo giờ VN). */
export function refLaiKy(loanId: string, ngayKy: Date): string {
  return `${TIEN_TO_REF_LAI_KY}${loanId}:${format(ngayKy, "yyyy-MM-dd")}`;
}

/** Tách `refId` dòng lãi kỳ ⇒ khoá cặp; `refId` khác dạng (chi phí thường, ads…) ⇒ null. */
export function tachRefLaiKy(refId: string | null | undefined): { loanId: string; khoaNgay: string } | null {
  if (refId == null || !refId.startsWith(TIEN_TO_REF_LAI_KY)) return null;
  const m = /^LOAN:(.+):(\d{4}-\d{2}-\d{2})$/.exec(refId);
  return m === null ? null : { loanId: m[1], khoaNgay: m[2] };
}

const MOT_NGAY_MS = 86_400_000;

/**
 * Dòng `LAI_NHAP_GOC` đi cặp với dòng lãi có `refId` này, hoặc null (dòng lãi thường / khoản không nhập
 * gốc / kỳ duyệt trước khi bật cờ). So theo NGÀY VN của khoá, không so timestamp: quỹ và dư nợ tính theo ngày.
 * Gọi trong transaction SAU khi đã khoá dòng `Loan` thì kết quả đứng yên tới lúc commit.
 */
export async function docDongLaiNhapGoc(
  db: Pick<Prisma.TransactionClient, "cashMovement">,
  refId: string | null | undefined
): Promise<CashMovement | null> {
  const khoa = tachRefLaiKy(refId);
  if (khoa === null) return null;
  const dau = new Date(`${khoa.khoaNgay}T00:00:00+07:00`);
  return db.cashMovement.findFirst({
    where: {
      loanId: khoa.loanId,
      kind: KIND_LAI_NHAP_GOC,
      date: { gte: dau, lt: new Date(dau.getTime() + MOT_NGAY_MS) },
    },
  });
}

/** Lượt sửa/xoá dòng lãi kỳ bị từ chối vì dòng nhập gốc đi cặp — NÉM trong transaction (return = COMMIT). */
export class LoiCapLaiNhapGoc extends Error {
  constructor(
    message: string,
    public readonly code: "KHOAN_VAY_DA_TAT_TOAN" | "KHONG_CO_QUYEN" | "CAP_DA_DOI"
  ) {
    super(message);
    this.name = "LoiCapLaiNhapGoc";
  }
}

/**
 * Khoản đã tất toán là khoản đã chốt dư nợ về 0 — kéo dòng nhập gốc ra/vào là làm dư nợ của nó khác 0
 * (cùng luật `kiemKhoanConHieuLuc` của dòng tiền gắn khoản vay). Gọi SAU khi đã khoá dòng `Loan`.
 */
export async function chanKhoanVayDaTatToan(
  db: Pick<Prisma.TransactionClient, "loan">,
  loanId: string
): Promise<void> {
  const loan = await db.loan.findUnique({ where: { id: loanId }, select: { closedAt: true } });
  if (loan !== null && loan.closedAt === null) return;
  throw new LoiCapLaiNhapGoc(
    "Khoản thấu chi này đã tất toán — dòng lãi đi cặp với lãi nhập gốc vào dư nợ, không sửa số / xoá được nữa",
    "KHOAN_VAY_DA_TAT_TOAN"
  );
}

/** Dòng lãi kỳ của khoản đang "lãi nhập gốc" mà KHÔNG có dòng `LAI_NHAP_GOC` đi cặp. */
export type LaiKyChuaCapNhapGoc = { loanId: string; ten: string; khoaNgayKy: string; amount: number };

/**
 * Dòng lãi kỳ (`refId` `LOAN:{loanId}:…`) ngày ∈ [ngày mở sổ `d0`, `mocM`) của khoản thấu chi CÒN MỞ đang bật
 * "lãi nhập gốc" mà thiếu dòng `LAI_NHAP_GOC` cùng (loanId, ngày VN) — tức kỳ duyệt kiểu cũ (lãi trừ tài khoản)
 * trước khi bật cờ. Khoản đã tất toán không xét: dư nợ đã chốt về 0, không còn đường nào ghi cặp vào nữa.
 * `d0` null ⇒ rỗng (chưa mở sổ thì chưa có quỹ để lệch). Khớp cặp theo khoá ngày trong `refId`, cùng luật
 * `docDongLaiNhapGoc`. Chỉ đọc; `db` = `tx` khi chạy trong transaction bước bật.
 */
export async function dsLaiKyChuaCapNhapGocTruocM(
  p: { mocM: Date; d0: Date | null },
  db: Pick<Prisma.TransactionClient, "loan" | "expense" | "cashMovement">
): Promise<LaiKyChuaCapNhapGoc[]> {
  if (p.d0 === null) return [];
  const loans = await db.loan.findMany({
    where: { laiNhapGoc: true, closedAt: null },
    select: { id: true, name: true },
    orderBy: [{ startDate: "asc" }, { id: "asc" }],
  });
  if (loans.length === 0) return [];
  const dauD0 = new Date(`${khoaNgayVn(p.d0)}T00:00:00+07:00`);
  const dauM = new Date(`${khoaNgayVn(p.mocM)}T00:00:00+07:00`);
  const [dongLai, dongNhap] = await Promise.all([
    db.expense.findMany({
      where: {
        date: { gte: dauD0, lt: dauM },
        OR: loans.map((l) => ({ refId: { startsWith: `${TIEN_TO_REF_LAI_KY}${l.id}:` } })),
      },
      select: { refId: true, amount: true },
    }),
    db.cashMovement.findMany({
      where: { kind: KIND_LAI_NHAP_GOC, loanId: { in: loans.map((l) => l.id) } },
      select: { loanId: true, date: true },
    }),
  ]);
  const daCap = new Set(dongNhap.map((c) => `${c.loanId}|${khoaNgayVn(c.date)}`));
  const tenTheo = new Map(loans.map((l) => [l.id, l.name]));
  const thuTu = new Map(loans.map((l, i) => [l.id, i]));
  return dongLai
    .flatMap((e) => {
      const khoa = tachRefLaiKy(e.refId);
      if (khoa === null || daCap.has(`${khoa.loanId}|${khoa.khoaNgay}`)) return [];
      return [{ loanId: khoa.loanId, ten: tenTheo.get(khoa.loanId) ?? "", khoaNgayKy: khoa.khoaNgay, amount: e.amount }];
    })
    .sort(
      (a, b) =>
        (thuTu.get(a.loanId) ?? 0) - (thuTu.get(b.loanId) ?? 0) || a.khoaNgayKy.localeCompare(b.khoaNgayKy)
    );
}
