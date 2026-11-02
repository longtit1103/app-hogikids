import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

/**
 * `/dang-nhap?redirect=a&redirect=b` làm `searchParams.redirect` thành MẢNG lúc chạy. Trang phải chuẩn
 * hoá trước khi đưa cho `isSafeRedirectPath` (hàm đó nhận chuỗi) — trước đây mảng làm trang 500 chỉ vì
 * ai đó sửa tay URL. Mảng → phần tử đầu (cùng quy ước `URLSearchParams.get`), rồi vẫn qua cổng chống
 * open-redirect như mọi giá trị khác.
 */
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/lib/quyen/nguoi-dung-phien", () => ({ docNguoiDungPhien: async () => null }));

import LoginPage from "@/app/(auth)/dang-nhap/page";
import { LoginForm } from "@/app/(auth)/dang-nhap/login-form";

/** Duyệt cây phần tử React (không render) tìm phần tử có `type` cho trước. */
function tim(nut: ReactNode, type: unknown): ReactElement[] {
  if (Array.isArray(nut)) return nut.flatMap((n) => tim(n, type));
  if (!isValidElement(nut)) return [];
  const tu = nut.type === type ? [nut] : [];
  return [...tu, ...tim((nut.props as { children?: ReactNode }).children, type)];
}

async function redirectToCua(redirect: string | string[] | undefined): Promise<string> {
  const cay = await LoginPage({ searchParams: Promise.resolve({ redirect }) });
  const form = tim(cay, LoginForm)[0];
  return (form.props as { redirectTo: string }).redirectTo;
}

describe("trang đăng nhập — tham số redirect lặp", () => {
  it("một giá trị hợp lệ ⇒ giữ nguyên", async () => {
    expect(await redirectToCua("/tai-chinh")).toBe("/tai-chinh");
  });

  it("lặp tham số ⇒ lấy phần tử đầu, KHÔNG ném lỗi", async () => {
    expect(await redirectToCua(["/tai-chinh", "/don-hang"])).toBe("/tai-chinh");
  });

  it("phần tử đầu không an toàn ⇒ về '/' (vẫn qua cổng open-redirect)", async () => {
    expect(await redirectToCua(["a", "b"])).toBe("/");
    expect(await redirectToCua(["//evil.com", "/ok"])).toBe("/");
    expect(await redirectToCua(undefined)).toBe("/");
  });
});
