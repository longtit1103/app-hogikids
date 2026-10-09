"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatVnd } from "@/lib/format";
import { formatAmountInput, parseAmountInput, parseSignedAmountInput } from "@/lib/format-amount-input";
import type { KetQuaDocChenhLech } from "@/lib/no-phai-tra/doc-chenh-lech-tai-m";
import type { DongDieuChinh, LuaChonDieuChinh } from "@/lib/no-phai-tra/tinh-chenh-lech-tai-m";

export type LuaChonManHinh = LuaChonDieuChinh | "tu-go";

/** Giữ dấu trừ đầu chuỗi khi đang gõ (ô ngân hàng cho âm — thấu chi), cùng luật form chốt số dư. */
export function hienSoCoDau(raw: string): string {
  const dau = /^\s*[-−]/.test(raw) ? "-" : "";
  return dau + formatAmountInput(Math.abs(parseSignedAmountInput(raw)));
}

function DongBang({
  nhan,
  tien,
  dam = false,
  mau,
  testId,
}: {
  nhan: string;
  tien: number;
  dam?: boolean;
  mau?: string;
  testId?: string;
}) {
  return (
    <div className={`flex justify-between gap-3 ${dam ? "font-medium text-ink" : "text-muted-foreground"}`} data-testid={testId}>
      <span>{nhan}</span>
      <span className={`tabular-nums ${mau ?? ""}`}>{formatVnd(tien)}</span>
    </div>
  );
}

const LUA_CHON: { value: LuaChonManHinh; nhan: string; giaiThich: string }[] = [
  { value: "giai-thich-duoc", nhan: "Chỉ phần giải thích được", giaiThich: "mỗi khoản đã biết nguyên nhân một dòng" },
  { value: "toan-bo", nhan: "Toàn bộ chênh lệch", giaiThich: "thêm một dòng cho phần chưa giải thích — quỹ khớp đúng ngân hàng" },
  { value: "tu-go", nhan: "Tự gõ từng dòng", giaiThich: "sửa số / mô tả, thêm hoặc bỏ dòng" },
];

/**
 * Bước 2 — đối chiếu tiền thật cuối ngày trước ngày bật với quỹ của app (cùng hợp đồng chốt số dư): gõ số
 * dư ngân hàng (cho âm) + tiền mặt ⇒ app tách phần giải thích được (nợ thẻ, phiếu duyệt khác số đã trả,
 * ví ads đã nạp) và phần CHƯA giải thích (đỏ — nên chốt số dư tháng đó để tìm). Chủ shop chọn cách điều
 * chỉnh; mỗi dòng thành một khoản điều chỉnh quỹ đúng ngày bật, mô tả bắt buộc.
 */
export function BuocDoiChieu({
  bankRaw,
  onBankRaw,
  tienMat,
  onTienMat,
  coTheTinh,
  dangTinh,
  onTinh,
  ketQua,
  luaChon,
  onLuaChon,
  dieuChinh,
  onDieuChinh,
  nhanTruocM,
}: {
  bankRaw: string;
  onBankRaw: (s: string) => void;
  tienMat: number;
  onTienMat: (n: number) => void;
  coTheTinh: boolean;
  dangTinh: boolean;
  onTinh: () => void;
  ketQua: KetQuaDocChenhLech | null;
  luaChon: LuaChonManHinh;
  onLuaChon: (l: LuaChonManHinh) => void;
  dieuChinh: readonly DongDieuChinh[];
  onDieuChinh: (ds: DongDieuChinh[]) => void;
  nhanTruocM: string;
}) {
  const sua = (i: number, thay: Partial<DongDieuChinh>) =>
    onDieuChinh(dieuChinh.map((d, j) => (j === i ? { ...d, ...thay } : d)));

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-hairline p-4" aria-labelledby="buoc-2">
      <h2 id="buoc-2" className="font-serif text-lg text-ink">
        Bước 2 · Đối chiếu tiền thật cuối ngày {nhanTruocM}
      </h2>
      <p className="text-xs text-muted-foreground">
        Gõ đúng số trên app ngân hàng (tổng tài khoản THANH TOÁN, đang thấu chi thì gõ số âm) và tiền mặt đếm
        được. KHÔNG cộng sổ tiết kiệm / tiền gửi vào số dư.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground" htmlFor="bat-so-du-bank">
          Số dư ngân hàng
          <Input
            id="bat-so-du-bank"
            inputMode="numeric"
            placeholder="0"
            className="text-right"
            value={bankRaw}
            onChange={(e) => onBankRaw(hienSoCoDau(e.target.value))}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground" htmlFor="bat-tien-mat">
          Tiền mặt
          <Input
            id="bat-tien-mat"
            inputMode="numeric"
            placeholder="0"
            className="text-right"
            value={formatAmountInput(tienMat)}
            onChange={(e) => onTienMat(parseAmountInput(e.target.value))}
          />
        </label>
      </div>
      <div>
        <Button type="button" variant="secondary" disabled={!coTheTinh || dangTinh} onClick={onTinh}>
          {dangTinh ? "Đang tính…" : ketQua ? "Tính lại chênh lệch" : "Tính chênh lệch"}
        </Button>
        {!coTheTinh && <p className="mt-1 text-xs text-muted-foreground">Khai đủ bước 1 trước.</p>}
      </div>

      {ketQua && (
        <div className="flex flex-col gap-1.5 rounded-lg bg-surface-soft p-3 text-sm" data-testid="bat-bang-chenh-lech">
          <DongBang nhan={`Tiền thật (ngân hàng + tiền mặt)`} tien={ketQua.soThat} />
          <DongBang nhan={`Quỹ của app cuối ngày ${nhanTruocM}`} tien={ketQua.quyApp} testId="bat-quy-app" />
          {ketQua.duNoThauChi > 0 && <DongBang nhan="Cộng dư nợ thấu chi (ngân hàng âm phần này)" tien={ketQua.duNoThauChi} />}
          <DongBang nhan="Chênh lệch (dương = tiền thật nhiều hơn sổ)" tien={ketQua.chenh} dam />
          <p className="mt-1 text-xs text-muted-foreground">Giải thích được:</p>
          {ketQua.muc.length === 0 && <p className="text-xs text-muted-foreground">— không có khoản nào</p>}
          {ketQua.muc.map((m) => (
            <DongBang key={m.khoa} nhan={m.nhan} tien={m.soTien} />
          ))}
          <DongBang
            nhan="Chưa giải thích"
            testId="bat-dong-chua-giai-thich"
            tien={ketQua.chuaGiaiThich}
            dam
            mau={ketQua.chuaGiaiThich === 0 ? "text-success" : "text-error"}
          />
          {ketQua.chuaGiaiThich !== 0 && (
            <p className="text-xs text-error" data-testid="bat-chua-giai-thich">
              Còn {formatVnd(Math.abs(ketQua.chuaGiaiThich))} chưa rõ nguyên nhân — nên chốt số dư tháng có ngày{" "}
              {nhanTruocM} ở Sổ quỹ để tìm khoản thu/chi ghi thiếu hoặc thừa trước khi bật.
            </p>
          )}
          {ketQua.tienDangGui > 0 && (
            <p className="text-xs text-warning">
              Đang gửi tiết kiệm / tiền gửi {formatVnd(ketQua.tienDangGui)} — nếu bạn đã cộng số đó vào số dư ngân
              hàng thì trừ ra rồi tính lại.
            </p>
          )}
        </div>
      )}

      {ketQua && (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-xs text-muted-foreground">Điều chỉnh quỹ ngày bật</legend>
          {LUA_CHON.map((l) => (
            <label key={l.value} className="flex items-start gap-2 text-sm text-ink">
              <input
                type="radio"
                name="bat-lua-chon"
                className="mt-1"
                checked={luaChon === l.value}
                onChange={() => onLuaChon(l.value)}
              />
              <span>
                {l.nhan} <span className="text-xs text-muted-foreground">— {l.giaiThich}</span>
              </span>
            </label>
          ))}
          <ul className="flex flex-col gap-2" data-testid="bat-danh-sach-dieu-chinh">
            {dieuChinh.length === 0 && <li className="text-xs text-muted-foreground">Không có dòng điều chỉnh nào.</li>}
            {dieuChinh.map((d, i) => (
              <li key={i} className="grid grid-cols-[6rem_8rem_1fr_auto] items-center gap-2 max-sm:grid-cols-2">
                <select
                  aria-label="Chiều điều chỉnh"
                  className="h-9 rounded-lg border border-input bg-canvas px-2 text-sm text-ink"
                  value={d.chieu}
                  disabled={luaChon !== "tu-go"}
                  onChange={(e) => sua(i, { chieu: e.target.value as "IN" | "OUT" })}
                >
                  <option value="IN">Vào quỹ</option>
                  <option value="OUT">Ra quỹ</option>
                </select>
                <Input
                  aria-label="Số tiền điều chỉnh"
                  inputMode="numeric"
                  className="text-right"
                  readOnly={luaChon !== "tu-go"}
                  value={formatAmountInput(d.soTien)}
                  onChange={(e) => sua(i, { soTien: parseAmountInput(e.target.value) })}
                />
                <Input
                  aria-label="Mô tả điều chỉnh"
                  maxLength={200}
                  readOnly={luaChon !== "tu-go"}
                  value={d.moTa}
                  onChange={(e) => sua(i, { moTa: e.target.value })}
                />
                {luaChon === "tu-go" && (
                  <Button type="button" variant="outline" size="sm" onClick={() => onDieuChinh(dieuChinh.filter((_, j) => j !== i))}>
                    Bỏ
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {luaChon === "tu-go" && (
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onDieuChinh([...dieuChinh, { chieu: "IN", soTien: 0, moTa: "" }])}
              >
                + Thêm dòng
              </Button>
            </div>
          )}
        </fieldset>
      )}
    </section>
  );
}
