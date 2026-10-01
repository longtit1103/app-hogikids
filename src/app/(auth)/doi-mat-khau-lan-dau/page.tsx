import { redirect } from "next/navigation";

import { DoiMatKhauLanDauForm } from "@/components/auth/doi-mat-khau-lan-dau-form";
import { docNguoiDungPhien } from "@/lib/quyen/nguoi-dung-phien";

export default async function DoiMatKhauLanDauPage() {
  // KHÔNG dùng cổng trang: cổng tự đẩy người còn cờ `phaiDoiMatKhau` về đúng trang này ⇒ vòng chuyển hướng.
  const nguoiDung = await docNguoiDungPhien();
  if (!nguoiDung) redirect("/dang-nhap");
  if (!nguoiDung.phaiDoiMatKhau) redirect("/");

  return (
    <div className="flex min-h-man-hinh flex-col bg-canvas">
      <main className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-[420px] rounded-lg border border-hairline bg-canvas p-6 md:p-8">
          <DoiMatKhauLanDauForm email={nguoiDung.email} />
        </div>
      </main>
    </div>
  );
}
