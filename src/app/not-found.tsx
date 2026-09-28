import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-canvas px-4 text-center">
      <h1 className="font-serif text-3xl text-ink">Không tìm thấy trang</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        Đường dẫn bạn truy cập không tồn tại hoặc đã được di chuyển.
      </p>
      <Button render={<Link href="/" />}>Về Dashboard</Button>
    </div>
  );
}
