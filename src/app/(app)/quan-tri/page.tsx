import Link from "next/link";

import { PageTitle } from "@/components/shell/page-title";
import { BangTaiKhoan } from "@/components/quan-tri/bang-tai-khoan";
import { listTaiKhoan } from "@/lib/quan-tri/tai-khoan-queries";
import { yeuCauChuShopTrang } from "@/lib/quyen/cong-trang";

export default async function QuanTriPage() {
  await yeuCauChuShopTrang("/quan-tri");
  const rows = await listTaiKhoan();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-2">
        <PageTitle title="Quản trị">
          <p className="text-sm text-muted-foreground">Tài khoản nhân sự và quyền truy cập.</p>
        </PageTitle>
        <Link href="/quan-tri/nhat-ky" className="text-sm text-primary hover:underline">
          Nhật ký thao tác
        </Link>
      </div>

      <div role="note" className="rounded-xl border border-hairline bg-surface-soft px-4 py-3 text-sm text-ink">
        Tài khoản mới chỉ mở được app khi email đã được thêm vào policy Cloudflare Access — làm ở dashboard Cloudflare.
      </div>

      <section className="rounded-xl border border-hairline bg-surface-card p-4 md:p-6">
        <BangTaiKhoan rows={rows} />
      </section>
    </div>
  );
}
