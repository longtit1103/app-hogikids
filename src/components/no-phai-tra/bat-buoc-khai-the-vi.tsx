"use client";

import { Input } from "@/components/ui/input";
import { formatAmountInput, parseAmountInput } from "@/lib/format-amount-input";

/** Một thẻ đang mở, kèm gợi ý kỳ sao kê gần nhất trước ngày bật (server tính theo ngày chốt của thẻ). */
export type TheChoBat = { id: string; ten: string; saoKeNgayChot: string; saoKeHanTra: string };
/** Một hồ sơ ví ads trả trước. */
export type ViChoBat = { id: string; nhan: string };

/** Số chủ shop khai cho MỘT thẻ ở bước 1. `null` = ô còn trống. */
export type KhaiThe = {
  coSaoKe: boolean;
  ngayChot: string;
  hanTra: string;
  soDuSaoKe: number | null;
  daTraTruoc: number;
  duNo: number | null;
};

export function khaiTheMacDinh(t: TheChoBat): KhaiThe {
  return { coSaoKe: true, ngayChot: t.saoKeNgayChot, hanTra: t.saoKeHanTra, soDuSaoKe: null, daTraTruoc: 0, duNo: null };
}

/** Bước 1 xong khi mọi thẻ có dư nợ, thẻ khai sao kê có đủ số + ngày hợp lệ, mọi ví có số dư. */
export function buoc1HopLe(
  the: readonly TheChoBat[],
  khai: Readonly<Record<string, KhaiThe>>,
  vi: readonly ViChoBat[],
  soDuVi: Readonly<Record<string, number | null>>
): boolean {
  const theOk = the.every((t) => {
    const k = khai[t.id];
    if (!k || k.duNo === null) return false;
    if (!k.coSaoKe) return true;
    return k.soDuSaoKe !== null && k.ngayChot !== "" && k.hanTra > k.ngayChot && k.daTraTruoc <= k.soDuSaoKe;
  });
  return theOk && vi.every((v) => soDuVi[v.id] !== null && soDuVi[v.id] !== undefined);
}

function OTien({
  id,
  value,
  onChange,
  nhan,
}: {
  id: string;
  value: number | null;
  onChange: (v: number | null) => void;
  nhan: string;
}) {
  return (
    <Input
      id={id}
      aria-label={nhan}
      inputMode="numeric"
      placeholder="0"
      className="text-right"
      value={value === null ? "" : formatAmountInput(value) || "0"}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, "") === "" ? null : parseAmountInput(e.target.value))}
    />
  );
}

/**
 * Bước 1 — khai số THẬT cuối ngày trước ngày bật: mỗi thẻ (sao kê gần nhất trước ngày bật — tuỳ chọn —
 * và dư nợ tổng cuối ngày đó), mỗi ví ads trả trước (số dư ví). Mọi thẻ đang mở PHẢI khai (0 cũng là số):
 * thẻ thiếu neo thì sau khi bật app không có điểm xuất phát dư nợ.
 */
export function BuocKhaiTheVi({
  the,
  khai,
  onKhai,
  vi,
  soDuVi,
  onSoDuVi,
  ngayTruocM,
  nhanTruocM,
}: {
  the: readonly TheChoBat[];
  khai: Readonly<Record<string, KhaiThe>>;
  onKhai: (cardId: string, k: KhaiThe) => void;
  vi: readonly ViChoBat[];
  soDuVi: Readonly<Record<string, number | null>>;
  onSoDuVi: (viId: string, v: number | null) => void;
  /** `yyyy-MM-dd` của ngày trước ngày bật — ngày chốt sao kê không được sau ngày này. */
  ngayTruocM: string;
  nhanTruocM: string;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-hairline p-4" aria-labelledby="buoc-1">
      <h2 id="buoc-1" className="font-serif text-lg text-ink">
        Bước 1 · Số dư thẻ và ví cuối ngày {nhanTruocM}
      </h2>
      {the.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Chưa có thẻ tín dụng nào. Đang có thẻ còn nợ (kể cả thẻ chưa gắn quảng cáo) thì thêm hồ sơ thẻ ở tab
          Chuẩn bị trước — thẻ thêm SAU khi bật chỉ được khai dư nợ 0.
        </p>
      ) : (
        the.map((t) => {
          const k = khai[t.id];
          const dat = (thay: Partial<KhaiThe>) => onKhai(t.id, { ...k, ...thay });
          return (
            <div key={t.id} data-testid="bat-khai-the" className="flex flex-col gap-2 rounded-lg bg-surface-soft p-3">
              <p className="text-sm font-medium text-ink">{t.ten}</p>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground" htmlFor={`bat-du-no-${t.id}`}>
                Dư nợ tổng cuối ngày {nhanTruocM} (số trên app ngân hàng, gồm cả phần chưa tới kỳ sao kê)
                <OTien id={`bat-du-no-${t.id}`} nhan={`Dư nợ ${t.ten}`} value={k.duNo} onChange={(v) => dat({ duNo: v })} />
              </label>
              <label className="flex items-center gap-2 text-xs text-ink">
                <input type="checkbox" checked={k.coSaoKe} onChange={(e) => dat({ coSaoKe: e.target.checked })} />
                Khai kỳ sao kê gần nhất trước ngày bật (để app nhắc hạn trả)
              </label>
              {k.coSaoKe && (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    Ngày chốt
                    <Input type="date" value={k.ngayChot} max={ngayTruocM} onChange={(e) => dat({ ngayChot: e.target.value })} />
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    Hạn trả
                    <Input type="date" value={k.hanTra} onChange={(e) => dat({ hanTra: e.target.value })} />
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground" htmlFor={`bat-sao-ke-${t.id}`}>
                    Số sao kê
                    <OTien
                      id={`bat-sao-ke-${t.id}`}
                      nhan={`Số sao kê ${t.ten}`}
                      value={k.soDuSaoKe}
                      onChange={(v) => dat({ soDuSaoKe: v })}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground" htmlFor={`bat-da-tra-${t.id}`}>
                    Đã trả của kỳ đó (trước ngày bật)
                    <OTien
                      id={`bat-da-tra-${t.id}`}
                      nhan={`Đã trả kỳ sao kê ${t.ten}`}
                      value={k.daTraTruoc}
                      onChange={(v) => dat({ daTraTruoc: v ?? 0 })}
                    />
                  </label>
                </div>
              )}
              {k.coSaoKe && k.hanTra !== "" && k.ngayChot !== "" && k.hanTra <= k.ngayChot && (
                <p className="text-xs text-error">Hạn trả phải sau ngày chốt.</p>
              )}
              {k.coSaoKe && k.soDuSaoKe !== null && k.daTraTruoc > k.soDuSaoKe && (
                <p className="text-xs text-error">Phần đã trả không được lớn hơn số sao kê.</p>
              )}
            </div>
          );
        })
      )}

      {vi.map((v) => (
        <label
          key={v.id}
          htmlFor={`bat-vi-${v.id}`}
          data-testid="bat-khai-vi"
          className="flex flex-col gap-1 rounded-lg bg-surface-soft p-3 text-xs text-muted-foreground"
        >
          <span className="text-sm font-medium text-ink">{v.nhan}</span>
          Số dư ví cuối ngày {nhanTruocM} (đọc trên trang quảng cáo — tiền đã nạp, chưa chạy)
          <OTien id={`bat-vi-${v.id}`} nhan={`Số dư ${v.nhan}`} value={soDuVi[v.id] ?? null} onChange={(x) => onSoDuVi(v.id, x)} />
        </label>
      ))}
    </section>
  );
}
