"use client";

import { useEffect } from "react";

import { xacNhan } from "@/lib/xac-nhan-hang-doi";

const CONFIRM_MESSAGE = "Bạn có thay đổi chưa lưu. Rời trang?";

/**
 * Chặn rời trang khi `dirty`: `beforeunload` (đóng tab/refresh/gõ URL khác)
 * + chặn click các link nội bộ (Next `<Link>` render ra `<a>`) bằng capture
 * listener trên `document` — hỏi bằng hộp xác nhận của app (`xacNhan`, thay
 * hộp confirm gốc của trình duyệt vốn bị chặn trong PWA/iOS) rồi mới cho đi tiếp, huỷ thì giữ
 * nguyên trang. Anchor `#...` trong cùng trang (hàng anchor-tabs) KHÔNG bị
 * chặn. Dùng lại ở Section 1 (Thông tin shop) và Section 2/4 (Kênh bán,
 * Ngưỡng tồn) — mọi form "sửa tại chỗ, lưu bằng nút Lưu" của Cài đặt.
 *
 * Hộp xác nhận là bất đồng bộ nên không thể trả lời ngay trong handler: handler chặn click gốc,
 * hỏi, và nếu đồng ý thì bắn lại ĐÚNG click đó lên anchor (cờ `choQua` để lần bắn lại không bị chặn
 * lần nữa) — Next `<Link>` tự điều hướng như thường.
 */
export function useUnsavedGuard(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;

    let choQua = false;
    let dangHoi = false;

    function handleBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }

    function handleClickCapture(e: MouseEvent) {
      if (choQua) return;
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#")) return;
      // Mở tab mới / tải file / phím tắt mở tab: trang hiện tại không bị rời đi ⇒ không cần hỏi.
      if (anchor.target === "_blank" || anchor.hasAttribute("download") || e.metaKey || e.ctrlKey || e.shiftKey) return;

      e.preventDefault();
      e.stopImmediatePropagation();
      if (dangHoi) return;
      dangHoi = true;
      void xacNhan({ noiDung: CONFIRM_MESSAGE, tieuDe: "Rời trang?", nhanDongY: "Rời trang", nhanHuy: "Ở lại" })
        .then((dongY) => {
          if (!dongY) return;
          choQua = true;
          try {
            anchor.click();
          } finally {
            choQua = false;
          }
        })
        .finally(() => {
          dangHoi = false;
        });
    }

    window.addEventListener("beforeunload", handleBeforeUnload);
    document.addEventListener("click", handleClickCapture, true);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      document.removeEventListener("click", handleClickCapture, true);
    };
  }, [dirty]);
}
