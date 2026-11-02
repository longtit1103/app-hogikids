// @vitest-environment jsdom
/**
 * Hộp xác nhận của app thay hộp confirm gốc của trình duyệt (bị chặn trong PWA/iOS):
 *   - `xacNhan()` trả lời hứa `true`/`false` theo nút người dùng bấm;
 *   - chưa gắn host ⇒ `false` ngay (không treo mãi, không làm việc mất dữ liệu);
 *   - `useUnsavedGuard` chặn click link khi còn thay đổi chưa lưu, hỏi, và CHỈ khi đồng ý mới cho đi tiếp.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { XacNhanHost } from "@/components/ui/xac-nhan-hop-thoai";
import { useUnsavedGuard } from "@/components/settings/use-unsaved-guard";
import { xacNhan } from "@/lib/xac-nhan-hang-doi";

afterEach(cleanup);

describe("xacNhan — hàng đợi + host", () => {
  it("chưa có host ⇒ false ngay, không treo", async () => {
    await expect(xacNhan("Bỏ thay đổi?")).resolves.toBe(false);
  });

  it("bấm Đồng ý ⇒ true; bấm Huỷ ⇒ false", async () => {
    render(<XacNhanHost />);

    let p = xacNhan({ noiDung: "Xoá dòng này?", nhanDongY: "Xoá", nhanHuy: "Giữ" });
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    expect(screen.getByText("Xoá dòng này?")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTestId("xac-nhan-dong-y"));
    });
    await expect(p).resolves.toBe(true);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    p = xacNhan("Xoá nữa?");
    await screen.findByRole("alertdialog");
    await act(async () => {
      fireEvent.click(screen.getByTestId("xac-nhan-huy"));
    });
    await expect(p).resolves.toBe(false);
  });

  it("hai yêu cầu liên tiếp được hỏi lần lượt; trả lời yêu cầu đầu không làm huỷ nhầm yêu cầu sau", async () => {
    render(<XacNhanHost />);
    const p1 = xacNhan("Câu một?");
    const p2 = xacNhan("Câu hai?");
    await screen.findByText("Câu một?");
    await act(async () => {
      fireEvent.click(screen.getByTestId("xac-nhan-dong-y"));
    });
    await expect(p1).resolves.toBe(true);
    await screen.findByText("Câu hai?");
    await act(async () => {
      fireEvent.click(screen.getByTestId("xac-nhan-dong-y"));
    });
    await expect(p2).resolves.toBe(true);
  });
});

describe("useUnsavedGuard — chặn click link khi còn thay đổi chưa lưu", () => {
  function Trang({ dirty, onDiChuyen }: { dirty: boolean; onDiChuyen: () => void }) {
    useUnsavedGuard(dirty);
    return (
      <a
        href="/trang-khac"
        onClick={(e) => {
          e.preventDefault(); // jsdom không điều hướng thật; chỉ đếm xem click có tới được link không
          onDiChuyen();
        }}
      >
        Đi chỗ khác
      </a>
    );
  }

  it("không dirty ⇒ click đi thẳng, không hỏi", () => {
    const di = vi.fn();
    render(
      <>
        <XacNhanHost />
        <Trang dirty={false} onDiChuyen={di} />
      </>,
    );
    fireEvent.click(screen.getByText("Đi chỗ khác"));
    expect(di).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("dirty ⇒ chặn click, hỏi; Ở lại ⇒ không đi; Rời trang ⇒ đi đúng một lần", async () => {
    const di = vi.fn();
    render(
      <>
        <XacNhanHost />
        <Trang dirty onDiChuyen={di} />
      </>,
    );
    fireEvent.click(screen.getByText("Đi chỗ khác"));
    expect(di).not.toHaveBeenCalled();
    await screen.findByRole("alertdialog");

    await act(async () => {
      fireEvent.click(screen.getByTestId("xac-nhan-huy"));
    });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(di).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Đi chỗ khác"));
    await screen.findByRole("alertdialog");
    await act(async () => {
      fireEvent.click(screen.getByTestId("xac-nhan-dong-y"));
    });
    await waitFor(() => expect(di).toHaveBeenCalledTimes(1));
  });
});
