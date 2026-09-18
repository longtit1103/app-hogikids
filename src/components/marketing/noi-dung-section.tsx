import { format, parseISO } from "date-fns";

import { formatPct1 } from "@/components/kenh/channel-format";
import { CHUA_KET_NOI_ANALYTICS, KhuTrongMarketing } from "@/components/marketing/khu-trong-marketing";
import { ChuThichDoTuoiVaThieu } from "@/components/marketing/canh-bao-do-tuoi-du-lieu";
import { DONG_MOI_TRANG_MARKETING, PhanTrangMarketing } from "@/components/marketing/phan-trang-marketing";
import { SoSanBao } from "@/components/marketing/so-san-bao";
import { formatVnd } from "@/lib/format";
import type { ChuThichDoTuoi } from "@/lib/reports/marketing/cau-do-tuoi-du-lieu";
import type { LiveTiktok, PhienLive } from "@/lib/reports/marketing/live-tiktok";
import type { LoaiTaiKhoanVideo, VideoSan, VideoTiktok } from "@/lib/reports/marketing/video-tiktok";

/**
 * Tab `noi-dung` — bảng Video + bảng Phiên live (spec §5.2 / task-8-brief Step 2).
 *
 * Hai bảng dùng HAI tham số trang RIÊNG (`?trangvideo=`/`?tranglive=`, xem `ThamSoTrang.thamSo` ở
 * `@/lib/pagination`) — KHÔNG còn chung một `?trang=` như bản đầu. Lý do đổi (fix vòng B-2): Video
 * thường nhiều trang (vd 45 dòng/3 trang) trong khi Live hiếm khi quá 1 trang (vd 5 phiên); dùng
 * chung một tham số khiến bấm "trang sau" của Video đẩy CẢ Live sang trang rỗng, và bảng Live tự
 * mâu thuẫn với chính nó (in "Không có phiên live nào trong kỳ này." ngay trên dòng đếm "5 phiên
 * live" của `PhanTrangMarketing`). Đổi bộ lọc tài khoản (chỉ ảnh hưởng Video) reset `trangvideo`
 * nhưng GIỮ NGUYÊN `tranglive` đang có trên URL — xem `hrefTaiKhoan`.
 *
 * BẤT BIẾN #2: mọi số ở `video`/`live` là số SÀN TỰ NHẬN CÔNG — bọc `<SoSanBao>` đúng cột spec liệt
 * kê (KHÔNG bọc "SP thêm vào live" — spec liệt kê cột đó KHÔNG có badge).
 */

/**
 * `sp` nhận NGUYÊN `searchParams` của `page.tsx` (không chỉ `KyTrenUrl` — tu/den/range), vì
 * `PhanTrangMarketing`/các link lọc bên dưới phải giữ NGUYÊN `tab`/`taikhoan` đang có trên URL khi
 * đổi trang; hẹp lại thành `KyTrenUrl` sẽ làm nút "trang sau" rụng mất bộ lọc đang chọn.
 */
type SpDayDu = Record<string, string | undefined>;

function soGon(n: number): string {
  return new Intl.NumberFormat("vi-VN").format(n);
}

const GIOI_HAN_TIEU_DE = 60;

function tieuDeHienThi(v: string | null): string {
  if (v === null) return "(không rõ video)";
  return v.length > GIOI_HAN_TIEU_DE ? `${v.slice(0, GIOI_HAN_TIEU_DE)}…` : v;
}

const NHAN_LOAI_TAI_KHOAN: Record<string, string> = {
  OFFICIAL_ACCOUNTS: "Shop",
  AFFILIATE_ACCOUNTS: "Affiliate",
  MARKETING_ACCOUNTS: "Marketing",
};

function nhanTaiKhoan(loai: string | null): string {
  if (loai === null) return "—";
  return NHAN_LOAI_TAI_KHOAN[loai] ?? loai;
}

function dangLucHienThi(v: string | null): string {
  if (v === null) return "—";
  // `video_post_time` là chuỗi naive "YYYY-MM-DD HH:MM:SS" của sàn (giờ shop = giờ VN) —
  // KHÔNG parse qua `new Date()` (bẫy naive-datetime-là-UTC đã vá 2026-07: `parseISO` không nhận
  // khuôn có khoảng trắng nên tự nó đã tránh được, nhưng viết tường minh cho rõ ý).
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(v);
  if (!match) return v;
  const [, y, m, d, h, min] = match;
  return `${d}/${m}/${y} ${h}:${min}`;
}

function batDauHienThi(iso: string): string {
  try {
    return format(parseISO(iso), "dd/MM/yyyy HH:mm");
  } catch {
    return iso;
  }
}

function thoiLuongHienThi(giay: number | null): string {
  if (giay === null) return "—";
  if (giay < 60) return `${giay} giây`;
  const phut = Math.floor(giay / 60);
  const conLai = giay % 60;
  return conLai === 0 ? `${phut} phút` : `${phut} phút ${conLai} giây`;
}

const LOAI_TAI_KHOAN_LOC: { key: LoaiTaiKhoanVideo; nhan: string }[] = [
  { key: "ALL", nhan: "Tất cả" },
  { key: "OFFICIAL_ACCOUNTS", nhan: "Shop" },
  { key: "AFFILIATE_ACCOUNTS", nhan: "Affiliate" },
];

function hrefTaiKhoan(loai: LoaiTaiKhoanVideo, sp: SpDayDu): string {
  const p = new URLSearchParams();
  p.set("tab", "noi-dung");
  if (loai !== "ALL") p.set("taikhoan", loai);
  if (sp.tu && sp.den) {
    p.set("tu", sp.tu);
    p.set("den", sp.den);
  } else if (sp.range) {
    p.set("range", sp.range);
  }
  // Đổi tài khoản chỉ lọc lại bảng Video ⇒ reset `trangvideo` (KHÔNG set — về trang 1), nhưng GIỮ
  // NGUYÊN `tranglive` nếu đang có trên URL: đổi bộ lọc Video không có lý do gì kéo bảng Live (không
  // hề bị lọc lại) về trang 1 của nó.
  if (sp.tranglive) p.set("tranglive", sp.tranglive);
  return `/marketing?${p.toString()}`;
}

function BangVideo({
  video,
  taiKhoanDangLoc,
  sp,
  trang,
  chuThich,
}: {
  video: VideoTiktok;
  taiKhoanDangLoc: LoaiTaiKhoanVideo;
  sp: SpDayDu;
  trang: number;
  /** Câu chú thích ĐỘ TƯƠI đã tính SẴN ở `page.tsx` (ruling P2-R38) — component KHÔNG tự tính. */
  chuThich: ChuThichDoTuoi;
}) {
  if (video.mocSanSang === null) {
    return <KhuTrongMarketing tieuDe="Video" loiNhan={CHUA_KET_NOI_ANALYTICS} />;
  }

  const tong = video.video.length;
  const trang20: VideoSan[] = video.video.slice(
    (trang - 1) * DONG_MOI_TRANG_MARKETING,
    trang * DONG_MOI_TRANG_MARKETING
  );

  return (
    <section className="rounded-xl border border-hairline p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-serif text-lg text-ink">Video</h2>
        <nav className="flex gap-1 rounded-lg bg-surface-soft p-1 text-xs" aria-label="Lọc loại tài khoản video">
          {LOAI_TAI_KHOAN_LOC.map((l) => (
            <a
              key={l.key}
              href={hrefTaiKhoan(l.key, sp)}
              className={
                l.key === taiKhoanDangLoc
                  ? "rounded-md bg-canvas px-2.5 py-1 font-medium text-ink shadow-sm"
                  : "rounded-md px-2.5 py-1 text-muted-foreground hover:text-ink"
              }
            >
              {l.nhan}
            </a>
          ))}
        </nav>
      </div>

      {trang20.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">Không có video nào trong kỳ này.</p>
      ) : (
        <>
          {/* Mobile: card 2 cột (tên + 3 số chính). Bảng đầy đủ từ md trở lên. */}
          <div className="mt-3 flex flex-col gap-2 md:hidden">
            {trang20.map((v) => (
              <div key={v.id} className="rounded-lg border border-hairline p-3 text-sm">
                <p className="text-ink" title={v.tieuDe ?? "(không rõ video)"}>
                  {tieuDeHienThi(v.tieuDe)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {nhanTaiKhoan(v.loaiTaiKhoan)} · {dangLucHienThi(v.dangLuc)}
                </p>
                <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <p className="text-muted-foreground">Lượt xem</p>
                    <p className="tabular-nums text-ink">
                      {v.luotXem === null ? "—" : <SoSanBao>{soGon(v.luotXem)}</SoSanBao>}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Đơn SKU</p>
                    <p className="tabular-nums text-ink">
                      {v.donSku === null ? "—" : <SoSanBao>{soGon(v.donSku)}</SoSanBao>}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">GMV</p>
                    <p className="tabular-nums text-ink">
                      {v.gmvSan === null ? "—" : <SoSanBao>{formatVnd(v.gmvSan)}</SoSanBao>}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-3 hidden overflow-x-auto md:block">
            <table className="w-full min-w-[860px] text-sm">
              <thead>
                <tr className="border-b border-hairline text-left text-xs text-muted-foreground">
                  <th className="py-1.5 pr-2 font-normal">Tiêu đề</th>
                  <th className="py-1.5 pr-2 font-normal">Tài khoản</th>
                  <th className="py-1.5 pr-2 font-normal">Đăng lúc</th>
                  <th className="py-1.5 pr-2 text-right font-normal">Lượt xem</th>
                  <th className="py-1.5 pr-2 text-right font-normal">CTR</th>
                  <th className="py-1.5 pr-2 text-right font-normal">Đơn SKU</th>
                  <th className="py-1.5 pr-2 text-right font-normal">GMV</th>
                  <th className="py-1.5 text-right font-normal">GPM</th>
                </tr>
              </thead>
              <tbody>
                {trang20.map((v) => (
                  <tr key={v.id} className="border-b border-hairline/60 last:border-0">
                    <td className="max-w-[280px] truncate py-1.5 pr-2 text-ink" title={v.tieuDe ?? "(không rõ video)"}>
                      {tieuDeHienThi(v.tieuDe)}
                    </td>
                    <td className="py-1.5 pr-2 text-xs text-muted-foreground">
                      {nhanTaiKhoan(v.loaiTaiKhoan)}
                      {v.taiKhoan && <span className="ml-1">({v.taiKhoan})</span>}
                    </td>
                    <td className="py-1.5 pr-2 text-xs text-muted-foreground">{dangLucHienThi(v.dangLuc)}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">
                      {v.luotXem === null ? "—" : <SoSanBao>{soGon(v.luotXem)}</SoSanBao>}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">
                      {v.ctr === null ? "—" : <SoSanBao>{formatPct1(v.ctr * 100)}</SoSanBao>}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">
                      {v.donSku === null ? "—" : <SoSanBao>{soGon(v.donSku)}</SoSanBao>}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">
                      {v.gmvSan === null ? "—" : <SoSanBao>{formatVnd(v.gmvSan)}</SoSanBao>}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                      {v.gpmSan === null ? "—" : <SoSanBao>{formatVnd(v.gpmSan)}</SoSanBao>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <PhanTrangMarketing sp={sp} trang={trang} tong={tong} donVi="video" thamSo="trangvideo" />

      {/* Cột CTR hay để trống ở kỳ nhiều ngày (video-tiktok.ts: sàn chỉ báo CTR cho ĐÚNG 1 ngày, kỳ
          xem thường nhiều ngày hơn ⇒ hầu hết video "—") — chủ shop dễ đọc nhầm thành "sàn không báo"
          hoặc "app thiếu dữ liệu"; cả hai đều sai nên phải nói rõ lý do thật. Hiện khi bảng có dòng,
          không phụ thuộc `chuThich` (đây là cách ĐỌC cột, không phải trạng thái đồng bộ). */}
      {tong > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          Cột CTR hay để trống (—): sàn chỉ tính được tỉ lệ này khi video đó chỉ xuất hiện đúng một ngày trong kỳ
          đang xem, nhiều ngày thì sàn không cộng lại được — không phải video đó không có dữ liệu.
        </p>
      )}

      <ChuThichDoTuoiVaThieu cau1={chuThich.cau1} cau2={chuThich.cau2} />
    </section>
  );
}

function BangLive({
  live,
  sp,
  trang,
  chuThich,
}: {
  live: LiveTiktok;
  sp: SpDayDu;
  trang: number;
  /** Câu chú thích ĐỘ TƯƠI của bảng Live — tính SẴN ở `page.tsx` (fix vòng B-2, việc #1). `LiveTiktok`
   *  KHÔNG có `soNgayThieu` (đúng thiết kế — phiên live là thực thể có id riêng, không phải chuỗi
   *  ngày, xem docblock `live-tiktok.ts`) nên `cau2` LUÔN null; chỉ `cau1` (suy từ `mocSanSang` qua
   *  đúng cơ chế 3 trạng thái của `quyetDinhCauDoTuoi`) có thể có chữ. */
  chuThich: ChuThichDoTuoi;
}) {
  // KHÔNG gate bằng `mocSanSang === null` như bảng Video: `LiveTiktok` không có khái niệm
  // soNgayThieu/soNgayChuaSanSang (phiên live là thực thể có id riêng, không phải chuỗi ngày — xem
  // docblock `live-tiktok.ts`), và việc bảng Video đã hiện khu trống "Chưa kết nối…" là đủ tín hiệu
  // cho người đọc; lặp lại y hệt câu đó lần hai ở đây chỉ tạo hai khối trùng nội dung trên cùng
  // màn hình. Ở đây luôn hiện heading + bảng (hoặc dòng "chưa có phiên live" khi rỗng) — nhưng VẪN
  // hiện câu ĐỘ TƯƠI (`chuThich`) phía dưới bảng: workflow chết mấy ngày trước đây làm bảng này im
  // lặng hiện thiếu phiên (fix vòng B-2, việc #1), chủ shop đọc thành "kỳ này ít live thật".
  const tong = live.phien.length;
  const trang20: PhienLive[] = live.phien.slice(
    (trang - 1) * DONG_MOI_TRANG_MARKETING,
    trang * DONG_MOI_TRANG_MARKETING
  );

  return (
    <section className="rounded-xl border border-hairline p-4">
      <h2 className="font-serif text-lg text-ink">Phiên live</h2>

      {trang20.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">Không có phiên live nào trong kỳ này.</p>
      ) : (
        <>
          <div className="mt-3 flex flex-col gap-2 md:hidden">
            {trang20.map((p) => (
              <div key={p.id} className="rounded-lg border border-hairline p-3 text-sm">
                <p className="text-ink">{p.tieuDe ?? "(không rõ tiêu đề)"}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {batDauHienThi(p.batDau)} · {thoiLuongHienThi(p.thoiLuongGiay)}
                </p>
                <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <p className="text-muted-foreground">Đơn SKU</p>
                    <p className="tabular-nums text-ink">
                      {p.donSku === null ? "—" : <SoSanBao>{soGon(p.donSku)}</SoSanBao>}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">GMV</p>
                    <p className="tabular-nums text-ink">
                      {p.gmvSan === null ? "—" : <SoSanBao>{formatVnd(p.gmvSan)}</SoSanBao>}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Khách</p>
                    <p className="tabular-nums text-ink">
                      {p.khach === null ? "—" : <SoSanBao>{soGon(p.khach)}</SoSanBao>}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-3 hidden overflow-x-auto md:block">
            <table className="w-full min-w-[860px] text-sm">
              <thead>
                <tr className="border-b border-hairline text-left text-xs text-muted-foreground">
                  <th className="py-1.5 pr-2 font-normal">Bắt đầu</th>
                  <th className="py-1.5 pr-2 font-normal">Thời lượng</th>
                  <th className="py-1.5 pr-2 font-normal">Tài khoản</th>
                  <th className="py-1.5 pr-2 text-right font-normal">Đơn SKU</th>
                  <th className="py-1.5 pr-2 text-right font-normal">GMV</th>
                  <th className="py-1.5 pr-2 text-right font-normal">Khách</th>
                  <th className="py-1.5 pr-2 text-right font-normal">Click→đơn</th>
                  <th className="py-1.5 text-right font-normal">SP thêm vào live</th>
                </tr>
              </thead>
              <tbody>
                {trang20.map((p) => (
                  <tr key={p.id} className="border-b border-hairline/60 last:border-0">
                    <td className="py-1.5 pr-2 text-ink">{batDauHienThi(p.batDau)}</td>
                    <td className="py-1.5 pr-2 text-muted-foreground">{thoiLuongHienThi(p.thoiLuongGiay)}</td>
                    <td className="py-1.5 pr-2 text-xs text-muted-foreground">{p.taiKhoan ?? "—"}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">
                      {p.donSku === null ? "—" : <SoSanBao>{soGon(p.donSku)}</SoSanBao>}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">
                      {p.gmvSan === null ? "—" : <SoSanBao>{formatVnd(p.gmvSan)}</SoSanBao>}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">
                      {p.khach === null ? "—" : <SoSanBao>{soGon(p.khach)}</SoSanBao>}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">
                      {p.clickSangDon === null ? "—" : <SoSanBao>{formatPct1(p.clickSangDon * 100)}</SoSanBao>}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                      {p.spThemVaoLive === null ? "—" : soGon(p.spThemVaoLive)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <PhanTrangMarketing sp={sp} trang={trang} tong={tong} donVi="phiên live" thamSo="tranglive" />

      {/* A4: shop chưa tự live (60/60 phiên là của creator) ⇒ sàn không trả `interaction_performance`
          cho phiên nào ⇒ reader không có trường số nào để hiện cụm cột tương tác — chỉ còn câu chú
          thích bắt buộc giải thích vì sao cụm đó vắng mặt (spec §"Luật hiển thị" câu #3). Chỉ hiện khi
          bảng CÓ dòng — 0 phiên (chưa đồng bộ) thì câu này lạc đề, dòng "chưa có phiên live" ở trên đã
          đủ nói hết. */}
      {!live.coCotTuongTac && tong > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          Chỉ số tương tác chỉ có với phiên live của tài khoản shop.
        </p>
      )}

      <ChuThichDoTuoiVaThieu cau1={chuThich.cau1} cau2={chuThich.cau2} />
    </section>
  );
}

export function NoiDungSection({
  video,
  live,
  sp,
  trangVideo,
  trangLive,
  taiKhoanDangLoc = "ALL",
  chuThichVideo,
  chuThichLive,
}: {
  video: VideoTiktok;
  live: LiveTiktok;
  sp: SpDayDu;
  /** Trang của bảng Video (`?trangvideo=`) — TÁCH khỏi `trangLive`, xem docblock đầu file. */
  trangVideo: number;
  /** Trang của bảng Phiên live (`?tranglive=`). */
  trangLive: number;
  taiKhoanDangLoc?: LoaiTaiKhoanVideo;
  /** Câu chú thích ĐỘ TƯƠI của bảng Video — tính SẴN ở `page.tsx` (ruling P2-R35 + P2-R38), đọc
   *  stream `tiktok/analytics_videos` (ruling P2-R40). */
  chuThichVideo: ChuThichDoTuoi;
  /** Câu chú thích ĐỘ TƯƠI của bảng Live — tính SẴN ở `page.tsx` (fix vòng B-2, việc #1), đọc stream
   *  `tiktok/analytics_lives`. */
  chuThichLive: ChuThichDoTuoi;
}) {
  return (
    <div className="flex flex-col gap-4">
      <BangVideo
        video={video}
        taiKhoanDangLoc={taiKhoanDangLoc}
        sp={sp}
        trang={trangVideo}
        chuThich={chuThichVideo}
      />
      <BangLive live={live} sp={sp} trang={trangLive} chuThich={chuThichLive} />
    </div>
  );
}
