import Image from "next/image";
import { redirect } from "next/navigation";

import { getAuthenticatedUserId } from "@/lib/session";
import { isSafeRedirectPath } from "@/lib/safe-redirect-path";
import { LoginForm } from "./login-form";

type LoginPageProps = {
  searchParams: Promise<{ redirect?: string }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  // PHẢI dùng cùng phép kiểm với `requireUser`: nếu ở đây chỉ nhìn cookie có `userId` mà không
  // soi mốc phiên, thì một cookie ĐÃ BỊ THU HỒI sẽ khiến trang này đẩy sang "/", còn "/" đẩy
  // ngược về đây — vòng lặp chuyển hướng, không đăng nhập lại được.
  if (await getAuthenticatedUserId()) {
    redirect("/");
  }

  // Only allow same-origin relative paths — never forward an absolute URL,
  // protocol-relative ("//evil.com"), or backslash ("/\evil.com") value from
  // the query string (open-redirect guard).
  const { redirect: redirectParam } = await searchParams;
  const redirectTo = redirectParam && isSafeRedirectPath(redirectParam) ? redirectParam : "/";

  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <main className="flex flex-1 items-center justify-center px-4 py-12 md:px-8">
        <div className="grid w-full max-w-5xl gap-10 md:grid-cols-2 md:items-center md:gap-16">
          {/* Branding column */}
          <div className="flex flex-col items-center gap-6 text-center md:items-start md:text-left">
            <div className="flex items-center gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary font-serif text-lg text-on-primary">
                H
              </span>
              <span className="font-serif text-xl text-ink">HogiKids</span>
            </div>
            <h1 className="font-serif text-3xl leading-tight tracking-tight text-ink md:text-5xl">
              Quản lý shop của bạn, gọn trong một nơi.
            </h1>
            <p className="text-base text-muted-foreground">
              Đơn hàng · Tồn kho · Chi phí · Lợi nhuận
            </p>
            <div className="hidden w-full overflow-hidden rounded-xl bg-surface-card md:block">
              <Image
                src="/illustrations/login.svg"
                alt=""
                width={480}
                height={360}
                priority
                className="h-auto w-full"
              />
            </div>
          </div>

          {/* Form card */}
          <div className="mx-auto w-full max-w-[400px] rounded-lg border border-hairline bg-canvas p-6 md:p-8">
            <LoginForm redirectTo={redirectTo} />
          </div>
        </div>
      </main>
      <footer className="pb-6 text-center text-xs text-muted-foreground">© 2026 HogiKids</footer>
    </div>
  );
}
