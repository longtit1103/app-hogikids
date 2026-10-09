import { format } from "date-fns";

import type { Prisma } from "@/generated/prisma/client";
import { docMocM } from "@/lib/no-phai-tra/cong-bat-no-phai-tra";
import { soDuViAds } from "@/lib/no-phai-tra/so-du-vi-ads";
import { prisma } from "@/lib/prisma";
import { khoaDongTienCoHan } from "@/lib/so-quy/khoa-dong-tien-co-han";

/**
 * Hồ sơ ví ads TRẢ TRƯỚC (`ViAdsTraTruoc`, spec §5.9) — đọc cho trang chuẩn bị/xác nhận bật nợ phải trả
 * và vị từ chặn xoá. Số dư ví là ƯỚC TÍNH ngoài quỹ (`so-du-vi-ads.ts`), không phải tiền quỹ.
 */

/** Nền tảng ads TRẢ TRƯỚC (nạp ví rồi chạy) — hiện chỉ Shopee Ads (chủ shop trả lời 08/10). */
export const NEN_TANG_VI_TRA_TRUOC = ["SHOPEE_ADS"] as const;
export type NenTangViTraTruoc = (typeof NEN_TANG_VI_TRA_TRUOC)[number];

export const NHAN_NEN_TANG_VI: Record<string, string> = { SHOPEE_ADS: "Shopee Ads" };

export type NguonNapVi = "BANK" | "CARD";
export const NHAN_NGUON_NAP: Record<NguonNapVi, string> = {
  BANK: "Ngân hàng",
  CARD: "Thẻ tín dụng",
};

export type HoSoViAds = {
  id: string;
  nenTang: string;
  nguonNap: NguonNapVi;
  soDuNeo: number;
  ngayNeo: Date;
  /** `dd/MM/yyyy` giờ VN — format ở server, client không tự format theo múi giờ trình duyệt. */
  ngayNeoNhan: string;
  note: string;
  /** Số lần nạp `ADS_TOPUP` đã ghi vào ví. */
  soLanNap: number;
  /** Số dư ví ước tính cuối hôm nay — chỉ có khi đã bật (trước đó neo chỉ là số tạm, B ghi đè). */
  soDuHienTai: number | null;
};

export async function docHoSoViAds(): Promise<HoSoViAds[]> {
  const [mocM, vis] = await Promise.all([
    docMocM(),
    prisma.viAdsTraTruoc.findMany({
      orderBy: { nenTang: "asc" },
      include: { _count: { select: { movements: true } } },
    }),
  ]);
  const homNay = new Date();
  return Promise.all(
    vis.map(async (v) => ({
      id: v.id,
      nenTang: v.nenTang,
      nguonNap: v.nguonNap,
      soDuNeo: v.soDuNeo,
      ngayNeo: v.ngayNeo,
      ngayNeoNhan: format(v.ngayNeo, "dd/MM/yyyy"),
      note: v.note,
      soLanNap: v._count.movements,
      soDuHienTai: mocM === null ? null : await soDuViAds(v.nenTang, homNay),
    }))
  );
}

/**
 * Lý do KHÔNG xoá được hồ sơ ví (null = xoá được). Luật: chỉ xoá khi ví CHƯA tác động lên quỹ.
 *  - Đã có lần nạp `ADS_TOPUP` ⇒ dòng tiền đang trỏ vào ví (FK Restrict) — chỉ sửa ghi chú/nguồn nạp.
 *  - Đã bật và ví tham gia bước bật (`ngayNeo < M`) ⇒ số dư neo đã thành một dòng điều chỉnh quỹ lúc bật;
 *    xoá ví là chi ads Shopee sau M quay lại trừ quỹ — trừ HAI lần phần đã điều chỉnh.
 *  - Đã bật và đã có chi ads của nền tảng sau ngày neo ⇒ các ngày đó quỹ đã không trừ (ví gánh); xoá là
 *    quỹ các ngày đã qua đổi số.
 */
export function lyDoKhongXoaViAds(p: {
  soLanNap: number;
  daBat: boolean;
  thamGiaBuocBat: boolean;
  soChiSauNeo: number;
}): string | null {
  if (p.soLanNap > 0) return "Ví đã có lần nạp — không xoá được (chỉ sửa ghi chú / nguồn nạp)";
  if (p.daBat && p.thamGiaBuocBat) {
    return "Ví đã khai ở bước bật theo dõi nợ (số dư neo đã vào điều chỉnh quỹ) — không xoá được";
  }
  if (p.daBat && p.soChiSauNeo > 0) {
    return "Ví đã gánh chi quảng cáo của những ngày đã qua — xoá là quỹ các ngày đó đổi số; không xoá được";
  }
  return null;
}

/**
 * KHOÁ DÒNG ví (`FOR UPDATE`) — lượt sửa/xoá hồ sơ chờ lượt nạp/bật đang ghi trên cùng ví. Chờ CÓ HẠN
 * (ngân sách chung của transaction) — quá hạn ⇒ `LoiKhoaDongTienBan`, lùi trọn.
 */
export async function khoaViAds(tx: Prisma.TransactionClient, id: string): Promise<void> {
  await khoaDongTienCoHan(tx, [() => tx.$queryRaw`SELECT id FROM "ViAdsTraTruoc" WHERE id = ${id} FOR UPDATE`]);
}
