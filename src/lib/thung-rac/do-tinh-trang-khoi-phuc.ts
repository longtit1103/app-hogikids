import type { Prisma } from "@prisma/client";
import { endOfMonth, startOfMonth } from "date-fns";

import type { CashMovementKind } from "@/lib/cash-movements/cash-movement-kinds";
import { duNoSauKhiGhi, tienGuiDangGiu } from "@/lib/so-quy/vi-tu-du-no";
import { soDuDangGui } from "@/lib/tiet-kiem/vi-tu-so-tiet-kiem";
import {
  doiNguocBanGhi,
  type AnhBanGhi,
  type BangThungRac,
} from "@/lib/thung-rac/chup-anh-ban-ghi";
import type {
  ChaDaMat,
  ChaDaTatToan,
  TinhTrangKhoiPhuc,
  TrucSoDuAm,
} from "@/lib/thung-rac/ly-do-khong-khoi-phuc";

/**
 * DÒ TRẠNG THÁI của một mục thùng rác: tách ảnh chụp thành các bản ghi cần dựng, rồi trả về đủ dữ
 * kiện cho vị từ thuần `lyDoKhongKhoiPhuc`.
 *
 * Tách khỏi `khoi-phuc-ban-ghi.ts` (đường GHI) vì hai lý do: file kia đã quá dài, và chính màn thùng
 * rác (`thung-rac-queries.ts`, đọc bằng `prisma` thường) cũng gọi `doTinhTrang` để dựng cột "Trạng
 * thái". Kết quả liệt kê và kết quả lúc bấm Khôi phục PHẢI cùng MỘT đường tính ra, nếu không bảng in
 * "Khôi phục được" rồi bấm vào mới báo lỗi.
 *
 * Mọi phép dò ở đây chỉ ĐỌC. Đường ghi còn giành khoá `FOR UPDATE` trên các dòng cha trước khi gọi
 * hàm này, và còn HẬU KIỂM sau câu ghi — dò trước là để nói thật trên bảng, không phải để thay cổng.
 */

/** Một bản ghi cần dựng lại — đã đổi ngược chuỗi ISO về `Date`. */
export type BanGhiCanDung = { bang: BangThungRac; data: Record<string, unknown> };

/**
 * Tách ảnh chụp thành danh sách bản ghi theo ĐÚNG thứ tự ghi (cha → dòng tiền → thu nhập).
 *
 * `thung-rac-queries.ts` dùng LẠI hàm này khi dựng cột "Trạng thái" — tự tách ảnh riêng ở tầng đọc
 * là hai nơi có thể lệch thứ tự/shape khi ảnh chụp đổi version.
 */
export function tachAnh(bang: BangThungRac, anh: AnhBanGhi): BanGhiCanDung[] {
  return [
    { bang, data: doiNguocBanGhi(bang, anh.chinh) },
    ...anh.cashMovements.map((m) => ({
      bang: "CashMovement" as const,
      data: doiNguocBanGhi("CashMovement", m),
    })),
    ...anh.thuNhap.map((t) => ({
      bang: "ThuNhap" as const,
      data: doiNguocBanGhi("ThuNhap", t),
    })),
  ];
}

async function coBanGhi(
  tx: Prisma.TransactionClient,
  bang: BangThungRac,
  id: string
): Promise<boolean> {
  switch (bang) {
    case "Expense":
      return (await tx.expense.count({ where: { id } })) > 0;
    case "CashMovement":
      return (await tx.cashMovement.count({ where: { id } })) > 0;
    case "ThuNhap":
      return (await tx.thuNhap.count({ where: { id } })) > 0;
    case "Loan":
      return (await tx.loan.count({ where: { id } })) > 0;
    case "SoTietKiem":
      return (await tx.soTietKiem.count({ where: { id } })) > 0;
  }
}

/** Id của dòng SỐNG đang giữ `refId` này, hoặc null. Chỉ `Expense` và `ThuNhap` có cột đó. */
async function chuCuaRefId(
  tx: Prisma.TransactionClient,
  bang: BangThungRac,
  refId: string
): Promise<string | null> {
  if (bang === "Expense") {
    return (await tx.expense.findUnique({ where: { refId }, select: { id: true } }))?.id ?? null;
  }
  if (bang === "ThuNhap") {
    return (await tx.thuNhap.findUnique({ where: { refId }, select: { id: true } }))?.id ?? null;
  }
  return null;
}

/** Đọc một trường chuỗi của ảnh chụp; kiểu nào khác (null, số…) đều coi như không có. */
function chuoi(data: Record<string, unknown>, truong: string): string | null {
  return typeof data[truong] === "string" ? (data[truong] as string) : null;
}

/** Khoá ngoại BẮT BUỘC phải còn sống thì bản ghi mới dựng lại được. */
function chaCuaBanGhi({ bang, data }: BanGhiCanDung): { loai: ChaDaMat; id: string }[] {
  const ra: { loai: ChaDaMat; id: string }[] = [];

  if (bang === "Expense") {
    const categoryId = chuoi(data, "categoryId");
    if (categoryId !== null) ra.push({ loai: "category", id: categoryId });
    const channelId = chuoi(data, "channelId");
    if (channelId !== null) ra.push({ loai: "channel", id: channelId });
  }
  if (bang === "CashMovement" || bang === "SoTietKiem") {
    const loanId = chuoi(data, "loanId");
    if (loanId !== null) ra.push({ loai: "loan", id: loanId });
  }
  if (bang === "CashMovement" || bang === "ThuNhap") {
    const savingsId = chuoi(data, "savingsId");
    if (savingsId !== null) ra.push({ loai: "savings", id: savingsId });
  }
  return ra;
}

/**
 * Mọi khoản vay / sổ tiết kiệm mà cụm khôi phục CHẠM tới — đường ghi giành khoá `FOR UPDATE` trên
 * đúng danh sách này trước khi dò, và chạy hậu kiểm số dư trên đúng danh sách này sau khi ghi.
 *
 * Kể cả cha đang nằm TRONG cụm (khoản vay của chính các dòng tiền kèm theo): dòng đó chưa tồn tại
 * nên `FOR UPDATE` khoá 0 hàng — vô hại, và đổi lại không ai phải nhớ một ngoại lệ.
 */
export function chaCanKhoa(canDung: BanGhiCanDung[]): {
  loanIds: string[];
  savingsIds: string[];
} {
  const loanIds = new Set<string>();
  const savingsIds = new Set<string>();
  for (const banGhi of canDung) {
    for (const cha of chaCuaBanGhi(banGhi)) {
      if (cha.loai === "loan") loanIds.add(cha.id);
      if (cha.loai === "savings") savingsIds.add(cha.id);
    }
  }
  return { loanIds: [...loanIds], savingsIds: [...savingsIds] };
}

/** Ba trạng thái của một dòng cha. `da_tat_toan` chỉ có ở `Loan`/`SoTietKiem` (cột `closedAt`). */
type TrangThaiCha = "khong_co" | "da_tat_toan" | "con_hieu_luc";

async function trangThaiCha(
  tx: Prisma.TransactionClient,
  cha: { loai: ChaDaMat; id: string }
): Promise<TrangThaiCha> {
  switch (cha.loai) {
    case "category":
      return (await tx.expenseCategory.count({ where: { id: cha.id } })) > 0
        ? "con_hieu_luc"
        : "khong_co";
    case "channel":
      return (await tx.channel.count({ where: { id: cha.id } })) > 0 ? "con_hieu_luc" : "khong_co";
    case "loan": {
      const loan = await tx.loan.findUnique({
        where: { id: cha.id },
        select: { closedAt: true },
      });
      if (!loan) return "khong_co";
      return loan.closedAt !== null ? "da_tat_toan" : "con_hieu_luc";
    }
    case "savings": {
      const so = await tx.soTietKiem.findUnique({
        where: { id: cha.id },
        select: { closedAt: true },
      });
      if (!so) return "khong_co";
      return so.closedAt !== null ? "da_tat_toan" : "con_hieu_luc";
    }
  }
}

/**
 * DẤU của từng loại dòng tiền trên 3 trục số dư.
 *
 * Phép CỘNG từ DB vẫn gọi thẳng `duNoSauKhiGhi` / `tienGuiDangGiu` / `soDuDangGui` — ở đây chỉ khai
 * dấu, vì phần cụm khôi phục CHƯA nằm trong DB nên không hàm nào cộng hộ được. Loại không có trong
 * bảng này (góp vốn, bán trực tiếp…) không đụng trục nào nên bỏ qua.
 *
 * Thêm `kind` mới mà quên khai ở đây thì cột "Trạng thái" bỏ sót một ca; hậu kiểm SAU câu ghi
 * (`chanDuNoAm`…) vẫn chặn được — hai lớp, không một lớp.
 */
const DAU_THEO_KIND: Partial<Record<CashMovementKind, { truc: TrucSoDuAm; dau: 1 | -1 }>> = {
  LOAN_IN: { truc: "duNo", dau: 1 },
  LOAN_REPAY: { truc: "duNo", dau: -1 },
  DEPOSIT_OUT: { truc: "tienGui", dau: 1 },
  DEPOSIT_IN: { truc: "tienGui", dau: -1 },
  SAVINGS_OUT: { truc: "soDuTietKiem", dau: 1 },
  SAVINGS_IN: { truc: "soDuTietKiem", dau: -1 },
};

/** Tổng tiền mà cụm khôi phục CỘNG THÊM vào từng trục, gom theo id cha. */
function deltaSoDu(canDung: BanGhiCanDung[]): Record<TrucSoDuAm, Map<string, number>> {
  const ra: Record<TrucSoDuAm, Map<string, number>> = {
    duNo: new Map(),
    tienGui: new Map(),
    soDuTietKiem: new Map(),
  };

  for (const { bang, data } of canDung) {
    if (bang !== "CashMovement") continue;
    const kind = chuoi(data, "kind") as CashMovementKind | null;
    const meta = kind === null ? undefined : DAU_THEO_KIND[kind];
    if (meta === undefined) continue;

    const chaId = chuoi(data, meta.truc === "soDuTietKiem" ? "savingsId" : "loanId");
    if (chaId === null) continue;
    const amount = typeof data.amount === "number" ? data.amount : 0;

    const m = ra[meta.truc];
    m.set(chaId, (m.get(chaId) ?? 0) + meta.dau * amount);
  }
  return ra;
}

/**
 * Dò TRƯỚC xem lượt khôi phục có đẩy trục số dư nào xuống âm không: nền (đọc từ DB) + delta của cụm.
 *
 * Ca thật đã tái hiện được: xoá nhầm một dòng trả gốc 40tr, ghi lại một dòng trả TRỌN 100tr, rồi vào
 * thùng rác bấm Khôi phục dòng 40tr ⇒ dư nợ −40tr và quỹ ra thêm 40tr không có thật.
 *
 * Cha nằm TRONG cụm (khôi phục cả khoản vay lẫn dòng tiền của nó) thì nền KHÔNG đọc DB được — dòng
 * cha chưa tồn tại. Nền lúc đó là `duNoMoSo` của chính ảnh chụp, và chắc chắn không có dòng tiền nào
 * đang trỏ tới (FK `Restrict` không cho con sống mà cha đã mất) ⇒ hai trục kia nền bằng 0. Nhờ vậy
 * một cụm hợp lệ không bao giờ tự chặn chính mình.
 */
async function duDoanSoDuAm(
  tx: Prisma.TransactionClient,
  canDung: BanGhiCanDung[],
  idTrongCum: Set<string>,
  trangThai: Map<string, TrangThaiCha>
): Promise<TrucSoDuAm | null> {
  const delta = deltaSoDu(canDung);

  const duNoMoSoTrongCum = new Map<string, number>();
  for (const { bang, data } of canDung) {
    if (bang !== "Loan") continue;
    duNoMoSoTrongCum.set(
      String(data.id),
      typeof data.duNoMoSo === "number" ? data.duNoMoSo : 0
    );
  }

  /** Nền của một trục, hoặc null khi cha đã mất hẳn (lý do `chaDaMat` nói việc đó rồi). */
  const nen = async (
    truc: TrucSoDuAm,
    chaId: string
  ): Promise<number | null> => {
    if (idTrongCum.has(chaId)) {
      return truc === "duNo" ? (duNoMoSoTrongCum.get(chaId) ?? 0) : 0;
    }
    const loai = truc === "soDuTietKiem" ? "savings" : "loan";
    if (trangThai.get(`${loai}:${chaId}`) === "khong_co") return null;
    if (truc === "duNo") return duNoSauKhiGhi(tx, chaId);
    if (truc === "tienGui") return tienGuiDangGiu(tx, chaId);
    return soDuDangGui(tx, chaId);
  };

  for (const truc of ["duNo", "tienGui", "soDuTietKiem"] as const) {
    for (const [chaId, themVao] of delta[truc]) {
      const goc = await nen(truc, chaId);
      if (goc !== null && goc + themVao < 0) return truc;
    }
  }
  return null;
}

/**
 * Khoản chi ĐỊNH KỲ mà tháng đó nay đã có dòng khác cùng `recurringId` — khôi phục là hai dòng cùng
 * một khoản chi.
 *
 * Đường đi thật: xoá dòng tháng 9 bằng mode "only" (mẫu VẪN active) ⇒ bất kỳ ai mở trang phủ tháng 9
 * đều làm `ensureRecurringExpensesForMonths` tự sinh lại dòng đó với id mới (cổng idempotent của nó
 * là `findFirst({recurringId, date trong tháng})`, KHÔNG có unique dưới DB). Bấm Khôi phục sau đó là
 * cộng đôi một khoản chi — mà chủ shop vừa bấm đúng cái nút app bảo là an toàn.
 *
 * Kẹp tháng theo `startOfMonth`/`endOfMonth` đúng như hàm tự sinh, để hai bên hiểu "trong tháng" y
 * hệt nhau. Loại trừ chính id đang khôi phục: bản ghi đó chưa tồn tại (nếu có thì `idDaTonTaiLai`
 * mới là lý do đúng), nhưng bỏ điều kiện đó ra là màn liệt kê báo sai ngay sau một lượt khôi phục.
 */
async function trungKhoanDinhKy(
  tx: Prisma.TransactionClient,
  { bang, data }: BanGhiCanDung
): Promise<boolean> {
  if (bang !== "Expense") return false;
  const recurringId = chuoi(data, "recurringId");
  if (recurringId === null) return false;
  const ngay = data.date;
  if (!(ngay instanceof Date)) return false;

  const trung = await tx.expense.findFirst({
    where: {
      recurringId,
      date: { gte: startOfMonth(ngay), lte: endOfMonth(ngay) },
      id: { not: String(data.id) },
    },
    select: { id: true },
  });
  return trung !== null;
}

/**
 * Gom đủ dữ kiện cho vị từ thuần `lyDoKhongKhoiPhuc`.
 *
 * Gọi được bằng `prisma` thường (màn liệt kê) hay `tx` transaction (đường ghi) — hàm chỉ đọc.
 */
export async function doTinhTrang(
  tx: Prisma.TransactionClient,
  daKhoiPhuc: boolean,
  canDung: BanGhiCanDung[]
): Promise<TinhTrangKhoiPhuc> {
  let idDaTonTaiLai = false;
  let refIdBiChiem: string | null = null;
  let chaDaMat: ChaDaMat | null = null;
  let chaDaTatToan: ChaDaTatToan | null = null;
  let thangDaCoDinhKy = false;

  // Cha nằm NGAY TRONG cụm đang dựng lại thì không phải "cha đã mất" — nó sắp được ghi trước con
  // (khoản vay của chính các dòng tiền kèm theo là đúng ca này).
  const idTrongCum = new Set(canDung.map((b) => String(b.data.id)));

  // Trạng thái từng cha dò MỘT LẦN rồi dùng lại cho cả 3 việc (mất · tất toán · nền số dư): một cụm
  // khoản vay có thể có vài chục dòng cùng trỏ một cha.
  const trangThai = new Map<string, TrangThaiCha>();

  for (const banGhi of canDung) {
    const id = String(banGhi.data.id);
    if (!idDaTonTaiLai && (await coBanGhi(tx, banGhi.bang, id))) idDaTonTaiLai = true;

    const refId = chuoi(banGhi.data, "refId");
    if (refIdBiChiem === null && refId !== null) {
      const chu = await chuCuaRefId(tx, banGhi.bang, refId);
      if (chu !== null && chu !== id) refIdBiChiem = refId;
    }

    for (const cha of chaCuaBanGhi(banGhi)) {
      if (idTrongCum.has(cha.id)) continue;
      const khoa = `${cha.loai}:${cha.id}`;
      let tt = trangThai.get(khoa);
      if (tt === undefined) {
        tt = await trangThaiCha(tx, cha);
        trangThai.set(khoa, tt);
      }
      if (tt === "khong_co") chaDaMat ??= cha.loai;
      // "Cha đã tất toán" CHỈ chặn bản ghi MANG TIỀN vào cha đó. Liên kết `SoTietKiem.loanId` là
      // liên kết SUÔNG ("vay khoản này rồi mang gửi", chỉ để so lãi suất) — chính form sổ cũng cho
      // trỏ sang khoản vay đã tất toán, nên chặn ở đây là chặn OAN một cụm hợp lệ.
      // `category`/`channel` không có `closedAt` nên không bao giờ rơi vào nhánh này.
      else if (
        tt === "da_tat_toan" &&
        (cha.loai === "loan" || cha.loai === "savings") &&
        (banGhi.bang === "CashMovement" || banGhi.bang === "ThuNhap")
      ) {
        chaDaTatToan ??= cha.loai;
      }
    }

    if (!thangDaCoDinhKy && (await trungKhoanDinhKy(tx, banGhi))) thangDaCoDinhKy = true;
  }

  return {
    daKhoiPhuc,
    idDaTonTaiLai,
    refIdBiChiem,
    chaDaMat,
    chaDaTatToan,
    thangDaCoDinhKy,
    seLamAmSoDu: await duDoanSoDuAm(tx, canDung, idTrongCum, trangThai),
  };
}
