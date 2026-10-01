import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { yeuCauQuyenTrang } from "@/lib/quyen/cong-trang";
import { isSafeRedirectPath } from "@/lib/safe-redirect-path";

export default async function KhongCoQuyenPage({
  searchParams,
}: {
  searchParams: Promise<{ tu?: string | string[] }>;
}) {
  // Chỉ cần đăng nhập — đây là đích của chính cổng từ chối, không đòi quyền nào.
  await yeuCauQuyenTrang("/khong-co-quyen");
  const { tu } = await searchParams;
  // `tu` là chuỗi người khác gửi tới: chỉ hiện khi là đường dẫn nội bộ an toàn (React tự escape khi hiển thị).
  const duongDan = typeof tu === "string" && isSafeRedirectPath(tu) ? tu : null;

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-16 text-center">
      <h1 className="font-serif text-2xl text-ink">Bạn chưa có quyền vào mục này</h1>
      <p className="text-sm text-muted-foreground">
        {duongDan ? (
          <>
            Bạn không có quyền vào <code className="rounded bg-surface-soft px-1 py-0.5">{duongDan}</code>. Liên hệ chủ
            shop để được cấp.
          </>
        ) : (
          "Bạn không có quyền vào trang này. Liên hệ chủ shop để được cấp."
        )}
      </p>
      <Link href="/" className={buttonVariants()}>
        Về trang chủ
      </Link>
    </div>
  );
}
