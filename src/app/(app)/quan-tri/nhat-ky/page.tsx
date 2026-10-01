import type { AuditLog } from "@/generated/prisma/client";
import { endOfDay, isValid, parse, startOfDay } from "date-fns";
import Link from "next/link";

import { formatGioVn } from "@/components/quan-tri/gio-vn";
import { nhanHanhDong, nhanKhoaGhiChu, nhanLyDo } from "@/components/quan-tri/nhan-hanh-dong";
import { PhanTrangNhatKy } from "@/components/quan-tri/phan-trang-nhat-ky";
import { Badge } from "@/components/ui/badge";
import { PageTitle } from "@/components/shell/page-title";
import { listNhatKy, listHanhDongDaCo, type LocNhatKy } from "@/lib/quan-tri/nhat-ky-queries";
import { listTaiKhoan } from "@/lib/quan-tri/tai-khoan-queries";
import { yeuCauChuShopTrang } from "@/lib/quyen/cong-trang";
import { docSoTrang, veTrangCuoiNeuVuot } from "@/lib/pagination";

const DONG_MOI_TRANG = 50;
const NGAY_CHAT = /^\d{4}-\d{2}-\d{2}$/;

type SP = Record<string, string | undefined>;

/** `yyyy-MM-dd` (giờ VN của container) → đầu/cuối ngày; chuỗi hỏng ⇒ bỏ lọc (không ném). */
function docNgay(s: string | undefined, dauNgay: boolean): Date | undefined {
  if (!s || !NGAY_CHAT.test(s)) return undefined;
  const d = parse(s, "yyyy-MM-dd", new Date());
  if (!isValid(d)) return undefined;
  return dauNgay ? startOfDay(d) : endOfDay(d);
}

function hrefNhatKy(sp: SP, trang: number): string {
  const params = new URLSearchParams();
  for (const k of ["actor", "hanhDong", "tu", "den"]) {
    const v = sp[k];
    if (v) params.set(k, v);
  }
  if (trang > 1) params.set("trang", String(trang));
  const qs = params.toString();
  return qs ? `/quan-tri/nhat-ky?${qs}` : "/quan-tri/nhat-ky";
}

function NguoiThucHien({ r }: { r: AuditLog }) {
  if (r.actorEmail) return <>{r.actorEmail}</>;
  if (r.danhTinhKhaiBao) return <span className="text-muted-foreground">chưa xác thực: {r.danhTinhKhaiBao}</span>;
  return <span className="text-muted-foreground">chưa xác thực</span>;
}

function GhiChu({ ghiChu }: { ghiChu: AuditLog["ghiChu"] }) {
  if (!ghiChu || typeof ghiChu !== "object" || Array.isArray(ghiChu)) return <>—</>;
  const muc = Object.entries(ghiChu).filter(([, v]) => typeof v === "string" || typeof v === "number");
  if (muc.length === 0) return <>—</>;
  return (
    <ul className="flex flex-col gap-0.5">
      {muc.map(([k, v]) => (
        <li key={k}>
          <span className="text-muted-foreground">{nhanKhoaGhiChu(k)}:</span>{" "}
          {k === "lyDo" ? nhanLyDo(String(v)) : String(v)}
        </li>
      ))}
    </ul>
  );
}

function DoiTuong({ r }: { r: AuditLog }) {
  const ten = r.doiTuongMoTa ?? r.doiTuongId;
  if (!r.doiTuongLoai && !ten) return <>—</>;
  return (
    <>
      {r.doiTuongLoai}
      {ten ? ` · ${ten}` : ""}
    </>
  );
}

function KetQua({ ketQua }: { ketQua: AuditLog["ketQua"] }) {
  return ketQua === "OK" ? <Badge variant="secondary">OK</Badge> : <Badge variant="destructive">Lỗi</Badge>;
}

export default async function NhatKyPage({ searchParams }: { searchParams: Promise<SP> }) {
  await yeuCauChuShopTrang("/quan-tri/nhat-ky");
  const sp = await searchParams;

  const loc: LocNhatKy = {
    actorId: sp.actor || undefined,
    hanhDong: sp.hanhDong || undefined,
    tu: docNgay(sp.tu, true),
    den: docNgay(sp.den, false),
  };
  const trang = docSoTrang(sp.trang);

  const [{ rows, tong }, taiKhoan, hanhDongCo] = await Promise.all([
    listNhatKy(loc, trang, DONG_MOI_TRANG),
    listTaiKhoan(),
    listHanhDongDaCo(),
  ]);
  veTrangCuoiNeuVuot({ duongDan: "/quan-tri/nhat-ky", sp, trang, tong, soDongMoiTrang: DONG_MOI_TRANG });
  const tongTrang = Math.max(1, Math.ceil(tong / DONG_MOI_TRANG));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-2">
        <PageTitle title="Nhật ký thao tác">
          <p className="text-sm text-muted-foreground">Ai đã làm gì, lúc nào. Chỉ chủ shop xem được.</p>
        </PageTitle>
        <Link href="/quan-tri" className="text-sm text-primary hover:underline">
          ← Tài khoản
        </Link>
      </div>

      <form method="get" className="grid gap-3 rounded-xl border border-hairline bg-surface-card p-4 sm:grid-cols-2 lg:grid-cols-5 lg:items-end">
        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          Người thực hiện
          <select name="actor" defaultValue={sp.actor ?? ""} className="h-9 rounded-lg border border-input bg-canvas px-2 text-sm text-ink">
            <option value="">Tất cả</option>
            {taiKhoan.map((t) => (
              <option key={t.id} value={t.id}>
                {t.email}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          Hành động
          <select name="hanhDong" defaultValue={sp.hanhDong ?? ""} className="h-9 rounded-lg border border-input bg-canvas px-2 text-sm text-ink">
            <option value="">Tất cả</option>
            {hanhDongCo.map((h) => (
              <option key={h} value={h}>
                {nhanHanhDong(h)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          Từ ngày
          <input type="date" name="tu" defaultValue={sp.tu ?? ""} className="h-9 rounded-lg border border-input bg-canvas px-2 text-sm text-ink" />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          Đến ngày
          <input type="date" name="den" defaultValue={sp.den ?? ""} className="h-9 rounded-lg border border-input bg-canvas px-2 text-sm text-ink" />
        </label>
        <button type="submit" className="h-9 rounded-lg bg-primary px-4 text-sm font-medium text-on-primary">
          Lọc
        </button>
      </form>

      <section className="rounded-xl border border-hairline bg-surface-card p-4 md:p-6">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Không có dòng nhật ký nào khớp bộ lọc.</p>
        ) : (
          <>
            {/* Máy tính: bảng. */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead className="text-left text-xs font-medium text-muted-foreground">
                  <tr>
                    <th className="px-2 py-2">Thời điểm</th>
                    <th className="px-2 py-2">Người</th>
                    <th className="px-2 py-2">Hành động</th>
                    <th className="px-2 py-2">Đối tượng</th>
                    <th className="px-2 py-2">Kết quả</th>
                    <th className="px-2 py-2">Ghi chú</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-t border-hairline align-top" data-testid="dong-nhat-ky">
                      <td className="px-2 py-2 whitespace-nowrap text-muted-foreground">{formatGioVn(r.thoiDiem)}</td>
                      <td className="px-2 py-2 text-ink"><NguoiThucHien r={r} /></td>
                      <td className="px-2 py-2 text-ink">{nhanHanhDong(r.hanhDong)}</td>
                      <td className="px-2 py-2 text-ink"><DoiTuong r={r} /></td>
                      <td className="px-2 py-2"><KetQua ketQua={r.ketQua} /></td>
                      <td className="px-2 py-2 text-xs text-ink"><GhiChu ghiChu={r.ghiChu} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Điện thoại: thẻ. */}
            <ul className="flex flex-col gap-2 md:hidden">
              {rows.map((r) => (
                <li key={r.id} className="flex flex-col gap-1 rounded-lg border border-hairline p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-ink">{nhanHanhDong(r.hanhDong)}</span>
                    <KetQua ketQua={r.ketQua} />
                  </div>
                  <span className="text-xs text-muted-foreground">{formatGioVn(r.thoiDiem)}</span>
                  <span className="text-xs text-ink"><NguoiThucHien r={r} /></span>
                  <span className="text-xs text-ink"><DoiTuong r={r} /></span>
                  <span className="text-xs"><GhiChu ghiChu={r.ghiChu} /></span>
                </li>
              ))}
            </ul>
          </>
        )}
        <PhanTrangNhatKy trang={trang} tongTrang={tongTrang} tong={tong} hrefTrang={(n) => hrefNhatKy(sp, n)} />
      </section>
    </div>
  );
}
