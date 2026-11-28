import { Prisma } from "@/generated/prisma/client";

import type { BoLocDonHang, DonKeBen } from "@/lib/orders/don-hang-kieu-du-lieu";
import { PAGE_SIZE } from "@/lib/page-size";
import { prisma } from "@/lib/prisma";

import type { QuyenGiaVon } from "./che-gia-von-types";
import { soNguyenAnToan } from "./orders-lai-tung-don-doi-dong";
import { cteDon, kepBoLocTheoQuyen, thuTuDon, whereDon } from "./orders-lai-tung-don-sql";

/**
 * Vị trí đơn đang mở trong ĐÚNG tập lọc + thứ tự của danh sách (cụm ‹ i / N › của drawer). Cùng CTE,
 * cùng WHERE, cùng bảng trắng sắp xếp với `getTrangDonHang` ⇒ ‹ › đi đúng thứ tự người dùng đang thấy,
 * kể cả sang trang khác (`trang = ceil(vị trí / 20)`). Đơn ngoài tập (hay id lạ) ⇒ `viTri: null`.
 */

type HangKeBen = { tong: unknown; vi_tri: unknown; truoc_id: string | null; sau_id: string | null };

const trangCua = (viTri: number) => Math.ceil(viTri / PAGE_SIZE);

export async function getDonKeBen(boLocVao: BoLocDonHang, donId: string, quyen: QuyenGiaVon, now: Date): Promise<DonKeBen> {
  const boLoc = kepBoLocTheoQuyen(boLocVao, quyen);
  const hang = await prisma.$queryRaw<HangKeBen[]>(Prisma.sql`
    ${cteDon(boLoc, quyen, now, false)},
    xep AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY ${thuTuDon(boLoc.sx, quyen)}) AS rn
      FROM don
      ${whereDon(boLoc, quyen, true)}
    ),
    dich AS (SELECT rn FROM xep WHERE id = ${donId})
    SELECT
      (SELECT COUNT(*) FROM xep)::bigint AS tong,
      (SELECT rn FROM dich) AS vi_tri,
      (SELECT x.id FROM xep x JOIN dich d ON x.rn = d.rn - 1) AS truoc_id,
      (SELECT x.id FROM xep x JOIN dich d ON x.rn = d.rn + 1) AS sau_id
  `);
  if (hang.length !== 1) throw new Error(`Câu vị trí đơn trả ${hang.length} dòng, mong 1`);
  const h = hang[0];

  const tong = soNguyenAnToan(h.tong, "tong");
  if (h.vi_tri === null) return { viTri: null, tong, truoc: null, sau: null };
  const viTri = soNguyenAnToan(h.vi_tri, "vi_tri");
  return {
    viTri,
    tong,
    truoc: h.truoc_id === null ? null : { id: h.truoc_id, trang: trangCua(viTri - 1) },
    sau: h.sau_id === null ? null : { id: h.sau_id, trang: trangCua(viTri + 1) },
  };
}
