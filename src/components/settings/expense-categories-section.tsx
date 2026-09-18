"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  createExpenseCategory,
  deleteExpenseCategory,
  renameExpenseCategory,
  toggleExpenseCategoryHidden,
} from "@/lib/actions/settings-expense-categories";
import { laDanhMucKhoaAn, LOI_DANH_MUC_KHOA_AN } from "@/lib/expenses/danh-muc-khoa-an";

const MAX_NAME_LENGTH = 30;

/** Thứ tự cố định 8 danh mục hệ thống — khớp `prisma/seed.ts` (schema không có cột order). */
const SYSTEM_ORDER = ["purchase", "ads", "shipping", "packaging", "return_bom", "fixed", "interest", "other"];

export type ExpenseCategoryRow = {
  id: string;
  name: string;
  isSystem: boolean;
  isHidden: boolean;
  expenseCount: number;
};

function sortCategories(categories: ExpenseCategoryRow[]): ExpenseCategoryRow[] {
  const system = [...categories.filter((c) => c.isSystem)].sort(
    (a, b) => SYSTEM_ORDER.indexOf(a.id) - SYSTEM_ORDER.indexOf(b.id),
  );
  const custom = [...categories.filter((c) => !c.isSystem)].sort((a, b) => a.name.localeCompare(b.name, "vi"));
  return [...system, ...custom];
}

/**
 * Section 3 "Danh mục chi phí": 8 dòng hệ thống (khóa tên, "other" và "interest"
 * khoá cả toggle Hiện/Ẩn — xem danh-muc-khoa-an.ts) rồi tới danh mục tùy chỉnh (sửa inline Enter/Esc, toggle,
 * xóa). Mỗi thao tác lưu NGAY qua server action + `router.refresh()` — khác
 * Section 1/2 (1 form + nút "Lưu" chung) vì đây là list nhiều dòng độc lập.
 */
export function ExpenseCategoriesSection({ categories: initial }: { categories: ExpenseCategoryRow[] }) {
  const router = useRouter();
  const categories = sortCategories(initial);
  const hasCustom = categories.some((c) => !c.isSystem);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  const [adding, setAdding] = useState(false);
  const [addValue, setAddValue] = useState("");
  const [savingAdd, setSavingAdd] = useState(false);

  const [busyId, setBusyId] = useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<ExpenseCategoryRow | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  function startEdit(row: ExpenseCategoryRow) {
    setEditingId(row.id);
    setEditValue(row.name);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditValue("");
  }

  async function saveEdit(id: string) {
    const trimmed = editValue.trim();
    if (!trimmed) {
      toast.error("Tên danh mục không được để trống");
      return;
    }
    setSavingEdit(true);
    try {
      const res = await renameExpenseCategory(id, trimmed);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Đã đổi tên danh mục");
      cancelEdit();
      router.refresh();
    } catch {
      toast.error("Lưu thất bại — kiểm tra kết nối");
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleToggleHidden(row: ExpenseCategoryRow, nextHidden: boolean) {
    setBusyId(row.id);
    try {
      const res = await toggleExpenseCategoryHidden(row.id, nextHidden);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      router.refresh();
      toast.success(`Đã ${nextHidden ? "ẩn" : "hiện"} danh mục ${row.name}`, {
        action: {
          label: "Hoàn tác",
          onClick: () => void handleToggleHidden(row, !nextHidden),
        },
      });
    } catch {
      toast.error("Lưu thất bại — kiểm tra kết nối");
    } finally {
      setBusyId(null);
    }
  }

  function openDelete(row: ExpenseCategoryRow) {
    setDeleteError(null);
    setDeleteTarget(row);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await deleteExpenseCategory(deleteTarget.id);
      if (!res.ok) {
        if (res.code === "HAS_EXPENSES") {
          setDeleteError(res.error);
          return;
        }
        toast.error(res.error);
        setDeleteTarget(null);
        return;
      }
      toast.success("Đã xóa danh mục");
      setDeleteTarget(null);
      router.refresh();
    } catch {
      toast.error("Lưu thất bại — kiểm tra kết nối");
    } finally {
      setDeleting(false);
    }
  }

  async function handleHideInstead() {
    if (!deleteTarget) return;
    const row = deleteTarget;
    setDeleteTarget(null);
    await handleToggleHidden(row, true);
  }

  async function handleAdd() {
    if (savingAdd) return; // hai lần Enter trong cùng một tick bắn 2 request trước khi nút kịp disable
    const trimmed = addValue.trim();
    if (!trimmed) {
      toast.error("Tên danh mục không được để trống");
      return;
    }
    setSavingAdd(true);
    try {
      const res = await createExpenseCategory(trimmed);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Đã thêm danh mục");
      setAdding(false);
      setAddValue("");
      router.refresh();
    } catch {
      toast.error("Lưu thất bại — kiểm tra kết nối");
    } finally {
      setSavingAdd(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col divide-y divide-hairline rounded-lg border border-hairline">
        {categories.map((row) => {
          const khoaAn = laDanhMucKhoaAn(row.id); // "Khác" + "Lãi vay": app tự ghi vào, ẩn là tự chặn đường ghi
          const isEditing = editingId === row.id;

          return (
            <div key={row.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {isEditing ? (
                  <Input
                    autoFocus
                    value={editValue}
                    maxLength={MAX_NAME_LENGTH}
                    disabled={savingEdit}
                    onChange={(e) => setEditValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveEdit(row.id);
                      if (e.key === "Escape") cancelEdit();
                    }}
                    className="h-8 max-w-[220px]"
                  />
                ) : (
                  <span className="truncate text-sm text-ink">{row.name}</span>
                )}
                <Badge variant={row.isSystem ? "secondary" : "outline"}>
                  {row.isSystem ? "Hệ thống" : "Tùy chỉnh"}
                </Badge>
                {row.expenseCount > 0 && (
                  <span className="text-xs text-muted-foreground">{row.expenseCount} khoản chi</span>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-3">
                {isEditing ? (
                  <>
                    <Button type="button" size="sm" disabled={savingEdit} onClick={() => saveEdit(row.id)}>
                      Lưu
                    </Button>
                    <Button type="button" size="sm" variant="outline" disabled={savingEdit} onClick={cancelEdit}>
                      Hủy
                    </Button>
                  </>
                ) : (
                  <>
                    {!row.isSystem && (
                      <button
                        type="button"
                        aria-label={`Sửa tên ${row.name}`}
                        onClick={() => startEdit(row)}
                        className="text-muted-foreground hover:text-ink"
                      >
                        <Pencil className="size-4" />
                      </button>
                    )}
                    <span title={khoaAn ? LOI_DANH_MUC_KHOA_AN : undefined}>
                      <Switch
                        checked={!row.isHidden}
                        disabled={khoaAn || busyId === row.id}
                        onCheckedChange={(checked) => handleToggleHidden(row, !checked)}
                        aria-label={`Hiện/Ẩn danh mục ${row.name}`}
                      />
                    </span>
                    {!row.isSystem && (
                      <button
                        type="button"
                        aria-label={`Xóa ${row.name}`}
                        onClick={() => openDelete(row)}
                        className="text-muted-foreground hover:text-error"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}

        {!hasCustom && !adding && (
          <p className="p-3 text-sm text-muted-foreground">Chưa có danh mục tùy chỉnh nào.</p>
        )}

        {adding && (
          <div className="flex flex-wrap items-center gap-3 p-3">
            <Input
              autoFocus
              placeholder="Tên danh mục mới"
              value={addValue}
              maxLength={MAX_NAME_LENGTH}
              disabled={savingAdd}
              onChange={(e) => setAddValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAdd();
                if (e.key === "Escape") {
                  setAdding(false);
                  setAddValue("");
                }
              }}
              className="h-8 max-w-[220px]"
            />
            <Button type="button" size="sm" disabled={savingAdd} onClick={handleAdd}>
              Lưu
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={savingAdd}
              onClick={() => {
                setAdding(false);
                setAddValue("");
              }}
            >
              Hủy
            </Button>
          </div>
        )}
      </div>

      {!adding && (
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
            + Thêm danh mục
          </Button>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Danh mục ẩn không hiện trong form Thêm chi phí nhưng vẫn nhận ghi tự động (ADS_API). &quot;Nhập
        hàng&quot; là dòng tiền — KHÔNG BAO GIỜ vào P&amp;L.
      </p>

      <Dialog open={Boolean(deleteTarget)} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Xóa danh mục</DialogTitle>
            {!deleteError && deleteTarget && (
              <DialogDescription>{`Xóa danh mục "${deleteTarget.name}"? Hành động không hoàn tác.`}</DialogDescription>
            )}
          </DialogHeader>

          {deleteError && (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-ink">{deleteError}. Bạn có thể Ẩn thay thế.</p>
              <Button type="button" variant="outline" onClick={handleHideInstead}>
                Ẩn danh mục
              </Button>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeleteTarget(null)}>
              {deleteError ? "Đóng" : "Hủy"}
            </Button>
            {!deleteError && (
              <Button type="button" variant="destructive" disabled={deleting} onClick={confirmDelete}>
                {deleting ? "Đang xóa…" : "Xóa"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
