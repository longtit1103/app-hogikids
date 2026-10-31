import { chmod, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Ghi bản lùi trước phục hồi (`pre-restore-*.dump`) CHỈ chủ tiến trình đọc được.
 *
 * Dump chứa hash mật khẩu mọi tài khoản + kho token (`Setting`). `mkdir`/`writeFile` không `mode` đi
 * qua umask 0022 của container ⇒ thư mục 0755, file 0644 trên bind-mount `./backups` mà host cũng thấy.
 * Hai chỗ hay bị bỏ sót, nên helper này lo sẵn:
 *  - Thư mục ĐÃ TỒN TẠI (bind-mount có từ host): `mkdir({ mode })` chỉ áp khi TẠO MỚI ⇒ phải `chmod`.
 *  - Bản lùi cũ đã ghi 0644 từ trước: siết lại luôn mỗi lần chuẩn bị thư mục.
 */

/**
 * Cảnh báo "không siết được quyền" (best-effort). Dưới Vitest (`NODE_ENV=test`) im lặng: test chạy trên thư mục tạm/
 * volume của máy dev, chmod trượt ở đó là chuyện môi trường và chỉ làm ồn log. Production (`NODE_ENV=production`) vẫn
 * cảnh báo — đó là dấu vết duy nhất báo bản lùi chứa dump có thể đang đọc được bởi uid khác.
 */
type CanhBao = (thongDiep: string, loi: unknown) => void;
const canhBaoMacDinh: CanhBao = (thongDiep, loi) => {
  if (process.env.NODE_ENV === "test") return;
  console.warn(thongDiep, loi);
};

/**
 * Thư mục chứa bản lùi: tạo (đệ quy) 0700, thư mục đã có thì siết về 0700, `.dump` cũ về 0600.
 * `canhBao` chỉ để test tiêm vào (kiểm cảnh báo vẫn phát khi chmod lỗi); mọi nơi gọi thật dùng mặc định.
 */
export async function chuanBiThuMucRiengTu(thuMuc: string, canhBao: CanhBao = canhBaoMacDinh): Promise<void> {
  await mkdir(thuMuc, { recursive: true, mode: 0o700 });
  // Phần siết quyền là BEST-EFFORT: thư mục/file có thể thuộc uid khác (chmod EPERM) — không được chặn
  // lượt phục hồi (bản lùi vẫn phải được ghi) vì chuyện siết quyền, chỉ để lại dấu vết trong log server.
  try {
    await chmod(thuMuc, 0o700);
  } catch (loi) {
    canhBao(`[backup] Không siết được quyền 0700 cho "${thuMuc}":`, loi);
  }
  let tenFile: string[] = [];
  try {
    tenFile = await readdir(thuMuc);
  } catch {
    return; // không liệt kê được thì thôi — file mới do `ghiFileRiengTu` đã 0600 sẵn
  }
  for (const ten of tenFile) {
    if (!ten.endsWith(".dump")) continue;
    try {
      await chmod(join(thuMuc, ten), 0o600);
    } catch (loi) {
      canhBao(`[backup] Không siết được quyền 0600 cho "${ten}":`, loi);
    }
  }
}

/**
 * Ghi file mới 0600. Cờ `wx`: file đã tồn tại ⇒ ném `EEXIST` thay vì đè mất một điểm lùi cũ (tên đã có
 * hậu tố ngẫu nhiên nên trùng là bất thường).
 */
export async function ghiFileRiengTu(duongDan: string, noiDung: Uint8Array): Promise<void> {
  await writeFile(duongDan, noiDung, { mode: 0o600, flag: "wx" });
}
