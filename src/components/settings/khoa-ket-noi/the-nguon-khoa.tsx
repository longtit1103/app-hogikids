"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { kiemTraKetNoiNguon, luuKhoaKetNoi } from "@/lib/actions/settings-khoa-ket-noi";
import type { NguonKetNoiId } from "@/lib/ket-noi/catalog-khoa-ket-noi";
import type { TrangThaiTruongKhoa } from "@/lib/ket-noi/doc-trang-thai-khoa-ket-noi";
import type { KetQuaKiemTra } from "@/lib/ket-noi/kiem-tra-types";

import { ONhapKhoa } from "./o-nhap-khoa";
import { useUnsavedGuard } from "../use-unsaved-guard";

/**
 * Thẻ MỘT nguồn dữ liệu, dạng GẤP/MỞ: header luôn hiện (tên + badge trạng thái), thân thẻ
 * (các ô khóa + nút + khối riêng) chỉ bung khi cần. Nguồn còn thiếu khóa thì TỰ MỞ sẵn —
 * mắt rơi đúng chỗ cần điền; nguồn đã đủ thì gấp gọn thành một hàng.
 *
 * Thân thẻ ẩn bằng CSS (không unmount) để giá trị đang gõ dở không mất khi lỡ tay gấp lại.
 * `children` = khối riêng của nguồn (webhook Pancake, luồng thay token Meta).
 */
export function TheNguonKhoa({
  nguonId,
  ten,
  moTa,
  truong,
  children,
}: {
  nguonId: NguonKetNoiId;
  ten: string;
  moTa: string;
  truong: TrangThaiTruongKhoa[];
  children?: ReactNode;
}) {
  const router = useRouter();
  const soThieu = truong.filter((t) => !t.daLuu).length;
  const [mo, setMo] = useState(soThieu > 0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [ketQua, setKetQua] = useState<KetQuaKiemTra | null>(null);

  const dirty = Object.values(values).some((v) => v.trim() !== "");
  useUnsavedGuard(dirty);

  async function handleSave() {
    if (!dirty) return;
    setSaving(true);
    try {
      const res = await luuKhoaKetNoi(nguonId, values);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Đã lưu ${res.data.daLuu} khóa của ${ten}`);
      setValues({});
      // Kết quả kiểm tra cũ đo bộ khóa CŨ — giữ lại sẽ nói dối về bộ khóa vừa lưu.
      setKetQua(null);
      router.refresh();
    } catch {
      toast.error("Lưu thất bại — kiểm tra kết nối mạng");
    } finally {
      setSaving(false);
    }
  }

  async function handleCheck() {
    setChecking(true);
    setKetQua(null);
    try {
      const res = await kiemTraKetNoiNguon(nguonId);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setKetQua(res.data);
    } catch {
      toast.error("Kiểm tra thất bại — kiểm tra kết nối mạng");
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="rounded-lg border border-hairline">
      <button
        type="button"
        aria-expanded={mo}
        onClick={() => setMo((cu) => !cu)}
        className="flex w-full items-center justify-between gap-3 rounded-lg px-4 py-3 text-left hover:bg-muted/40"
      >
        <h3 className="min-w-0 truncate text-sm font-medium text-ink">{ten}</h3>
        <span className="flex shrink-0 items-center gap-2">
          {soThieu === 0 ? (
            <Badge className="bg-success/15 text-success">Đã cấu hình</Badge>
          ) : (
            <Badge className="bg-warning/15 text-warning">Thiếu {soThieu} khóa</Badge>
          )}
          <ChevronDown className={`size-4 text-muted-foreground transition-transform ${mo ? "rotate-180" : ""}`} />
        </span>
      </button>

      <div className={mo ? "flex flex-col gap-3 px-4 pb-4" : "hidden"}>
        <p className="text-xs text-muted-foreground">{moTa}</p>

        <div className="flex flex-col gap-3">
          {truong.map((t) => (
            <ONhapKhoa key={t.key} truong={t} value={values[t.key] ?? ""} onChange={(v) => setValues((cu) => ({ ...cu, [t.key]: v }))} />
          ))}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="outline" disabled={checking || saving} onClick={handleCheck}>
            {checking ? "Đang kiểm tra…" : "Kiểm tra kết nối"}
          </Button>
          <Button type="button" disabled={!dirty || saving} onClick={handleSave}>
            {saving ? "Đang lưu…" : "Lưu khóa"}
          </Button>
        </div>

        {ketQua && (
          <div
            className={`flex flex-col gap-1 rounded-lg p-3 text-sm ${ketQua.ok ? "bg-success/10" : "bg-error/10"}`}
          >
            {ketQua.dong.map((d, i) => (
              <p key={i} className={d.ok ? "text-success" : "text-error"}>
                {d.ok ? "✓" : "✕"} {d.nhan}: {d.chiTiet}
              </p>
            ))}
          </div>
        )}

        {children}
      </div>
    </div>
  );
}
