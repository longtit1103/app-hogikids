"use client";

import { useEffect } from "react";

const CONFIRM_MESSAGE = "Bạn có thay đổi chưa lưu. Rời trang?";

/**
 * Chặn rời trang khi `dirty`: `beforeunload` (đóng tab/refresh/gõ URL khác)
 * + chặn click các link nội bộ (Next `<Link>` render ra `<a>`) bằng capture
 * listener trên `document` — confirm rồi mới cho đi tiếp, hủy thì chặn
 * navigation. Anchor `#...` trong cùng trang (hàng anchor-tabs) KHÔNG bị
 * chặn. Dùng lại ở Section 1 (Thông tin shop) và Section 2/4 (Kênh bán,
 * Ngưỡng tồn) — mọi form "sửa tại chỗ, lưu bằng nút Lưu" của Cài đặt.
 */
export function useUnsavedGuard(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;

    function handleBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }

    function handleClickCapture(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest?.("a[href]");
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#")) return;
      if (!window.confirm(CONFIRM_MESSAGE)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }

    window.addEventListener("beforeunload", handleBeforeUnload);
    document.addEventListener("click", handleClickCapture, true);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      document.removeEventListener("click", handleClickCapture, true);
    };
  }, [dirty]);
}
