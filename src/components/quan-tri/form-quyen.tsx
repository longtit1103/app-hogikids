"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { MODULES, MODULE_CO_SUA, NHAN_QUYEN, type Module, type Quyen } from "@/lib/quyen/danh-muc-quyen";
import { VAI_TRO_MAU, type MaVaiTroMau } from "@/lib/quyen/vai-tro-mau";

import { batTatQuyen, loiToHopQuyen } from "./quyen-form-logic";

const NHAN_MODULE: Record<Module, string> = {
  "tong-quan": "Tổng quan",
  "don-hang": "Đơn hàng",
  "san-pham": "Sản phẩm",
  "ton-kho": "Tồn kho",
  kenh: "Kênh bán",
  marketing: "Marketing",
  "bao-cao": "Báo cáo",
  "tai-chinh-loi-lo": "Tài chính — Lãi/Lỗ",
  "tai-chinh-dong-tien": "Tài chính — Dòng tiền",
  "tai-chinh-so-quy": "Tài chính — Sổ quỹ",
  "chi-phi": "Sổ chi phí",
  "cai-dat": "Cài đặt",
};

const MA_MAU = Object.keys(VAI_TRO_MAU) as MaVaiTroMau[];

function OTick({
  q,
  giaTri,
  onChange,
  id,
}: {
  q: Quyen;
  giaTri: readonly Quyen[];
  onChange: (v: Quyen[]) => void;
  id?: string;
}) {
  return (
    <Checkbox
      id={id}
      aria-label={NHAN_QUYEN[q]}
      checked={giaTri.includes(q)}
      onCheckedChange={(bat) => onChange(batTatQuyen(giaTri, q, bat === true))}
      data-quyen={q}
    />
  );
}

/**
 * Lưới quyền: hàng mẫu + module × {Xem, Sửa} + 2 quyền đặc biệt. Tick Sửa tự tick Xem. Tổ hợp sai (Lãi/Lỗ
 * thiếu giá vốn) chỉ HIỆN LỖI — không tự tick, người cấp phải chủ động cho thấy lợi nhuận.
 */
export function FormQuyen({
  giaTri,
  onChange,
  loiMayChu,
}: {
  giaTri: readonly Quyen[];
  onChange: (v: Quyen[]) => void;
  /** Lỗi trả từ server (vd `TO_HOP_QUYEN_SAI`) — hiện cùng chỗ với lỗi tổ hợp cục bộ. */
  loiMayChu?: string | null;
}) {
  const loi = loiToHopQuyen(giaTri) ?? loiMayChu ?? null;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="mau-quyen" className="text-sm font-medium text-ink">
          Áp dụng mẫu
        </label>
        <select
          id="mau-quyen"
          className="h-9 rounded-lg border border-input bg-canvas px-2 text-sm text-ink"
          value=""
          onChange={(e) => {
            const ma = e.target.value as MaVaiTroMau;
            if (ma in VAI_TRO_MAU) onChange([...VAI_TRO_MAU[ma].quyen]);
          }}
        >
          <option value="">Chọn mẫu để điền sẵn…</option>
          {MA_MAU.map((ma) => (
            <option key={ma} value={ma}>
              {VAI_TRO_MAU[ma].ten}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">Mẫu chỉ điền sẵn ô tick; bạn vẫn chỉnh được từng quyền.</p>
      </div>

      <div className="rounded-lg border border-hairline">
        <div className="grid grid-cols-[1fr_3.5rem_3.5rem] items-center gap-x-2 border-b border-hairline bg-surface-soft px-3 py-1.5 text-xs font-medium text-muted-foreground">
          <span>Mục</span>
          <span className="text-center">Xem</span>
          <span className="text-center">Sửa</span>
        </div>
        {MODULES.map((m) => {
          const coSua = (MODULE_CO_SUA as readonly string[]).includes(m);
          return (
            <div key={m} className="border-b border-hairline last:border-b-0">
              <div className="grid grid-cols-[1fr_3.5rem_3.5rem] items-center gap-x-2 px-3 py-2 text-sm text-ink">
                <span>{NHAN_MODULE[m]}</span>
                <span className="flex justify-center">
                  <OTick q={`${m}:xem` as Quyen} giaTri={giaTri} onChange={onChange} />
                </span>
                <span className="flex justify-center">
                  {coSua ? (
                    <OTick q={`${m}:sua` as Quyen} giaTri={giaTri} onChange={onChange} />
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </span>
              </div>
              {m === "tai-chinh-loi-lo" && (
                <p className="px-3 pb-2 text-xs text-muted-foreground">
                  Cần kèm quyền &quot;Xem giá vốn &amp; lợi nhuận&quot; bên dưới.
                </p>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex flex-col gap-2 text-sm text-ink">
        {(["gia-von-loi-nhuan:xem", "xuat-du-lieu"] as const).map((q) => (
          <div key={q} className="flex items-center gap-2">
            <OTick q={q} giaTri={giaTri} onChange={onChange} id={`quyen-${q}`} />
            <label htmlFor={`quyen-${q}`} className="cursor-pointer">
              {NHAN_QUYEN[q]}
            </label>
          </div>
        ))}
      </div>

      {loi && (
        <p role="alert" data-testid="loi-to-hop-quyen" className="rounded-lg bg-error/10 px-3 py-2 text-sm text-error">
          {loi}
        </p>
      )}
    </div>
  );
}
