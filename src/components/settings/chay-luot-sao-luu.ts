/**
 * Logic một lượt bấm "Sao lưu ngay" — tách khỏi `backup-button.tsx` để TEST ĐƯỢC.
 *
 * Lý do tách giống hệt `lib/backup/doc-trang-thai-sao-luu.ts`: bất biến ở đây là "lượt LỖI cũng
 * phải làm mới màn hình". Nằm trong component thì không có cách nào khoá nó bằng test (repo không
 * có jsdom/testing-library), nên gỡ đi cả suite vẫn xanh trong khi thẻ Sao lưu treo trạng thái OK
 * cũ ngay sau một lượt vừa hỏng — đúng loại tín hiệu nói dối mà nguồn SyncLog kind BACKUP sinh ra
 * để diệt.
 *
 * File CỐ Ý không import react/next/sonner: giữ nó chạy được trong test môi trường `node`.
 */

/**
 * Tải bản backup qua `fetch POST /api/backup` (route là POST vì có side-effect;
 * không dùng thẻ <a href> để hiện được spinner + toast lỗi). Thành công → tạo
 * Blob download với tên file lấy từ `Content-Disposition`; lỗi → đọc JSON
 * `{error}` route trả về và ném lên để caller toast.
 */
export async function downloadBackup(): Promise<void> {
  const res = await fetch("/api/backup", { method: "POST" });
  if (!res.ok) {
    let message = "Sao lưu thất bại";
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // body không phải JSON — giữ message mặc định.
    }
    throw new Error(message);
  }

  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition") ?? "";
  const match = disposition.match(/filename="?([^"]+)"?/);
  const filename = match?.[1] ?? "hogikids-backup.dump";

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** Mọi thứ chạm ra ngoài (mạng, toast, router) đều tiêm vào để test dựng được cả hai nhánh. */
export type PhuThuocLuotSaoLuu = {
  taiBanSaoLuu: () => Promise<void>;
  baoThanhCong: (thongDiep: string) => void;
  baoLoi: (thongDiep: string) => void;
  /** Render lại phần server (thẻ "Sao lưu" ở Cài đặt › Dữ liệu đọc `docTrangThaiSaoLuu` ở server). */
  lamMoiManHinh: () => void;
};

/**
 * Một lượt bấm nút: tải file → báo kết quả → LUÔN làm mới màn hình. Không bao giờ ném ra ngoài
 * (lỗi đã thành toast), để caller chỉ cần lo cờ `loading`.
 */
export async function chayLuotSaoLuu(phuThuoc: PhuThuocLuotSaoLuu): Promise<void> {
  try {
    await phuThuoc.taiBanSaoLuu();
    phuThuoc.baoThanhCong("Đã tạo bản sao lưu");
  } catch (err) {
    phuThuoc.baoLoi(err instanceof Error ? `Sao lưu thất bại: ${err.message}` : "Sao lưu thất bại");
  } finally {
    // `finally` chứ KHÔNG chỉ nhánh thành công — hai lý do, cả hai đều là "màn hình nói dối":
    //  · Lượt LỖI cũng ghi `SyncLog{kind:BACKUP,status:ERROR}` (`api/backup/route.ts`). Không render
    //    lại thì thẻ Sao lưu vẫn khoe "Sao lưu gần nhất: <mốc cũ>" trong khi lượt vừa bấm vừa hỏng.
    //  · Lượt THÀNH CÔNG cần refresh để shop chưa từng sao lưu thôi thấy "Chưa sao lưu lần nào".
    // Toast đã bắn ở trên (trước refresh) nên người bấm biết ngay kết quả, không chờ server render.
    phuThuoc.lamMoiManHinh();
  }
}
