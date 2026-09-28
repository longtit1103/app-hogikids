"use client";

import { useState } from "react";

import { ExpenseFormModal } from "@/components/expenses/expense-form-modal";
import { Button } from "@/components/ui/button";

/** Đề xuất nguồn ads theo kênh (khớp `ADS_CHANNEL_SUGGESTION` ngược của `expense-form-modal.tsx`); Shopee/Website chưa có nguồn thật → bắt chọn tay. */
const ADS_SOURCE_BY_CHANNEL: Record<string, string | undefined> = {
  facebook: "META",
  tiktok: "TIKTOK_ADS",
};

/**
 * "+ Thêm chi phí ads cho kênh này" — mở `ExpenseFormModal` khóa sẵn danh
 * mục "ads" + kênh hiện tại (design spec 8.1). Kênh tắt → disabled + tooltip.
 */
export function AddChannelAdsButton({
  channelId,
  channelName,
  isActive,
  categories,
  channels,
}: {
  channelId: string;
  channelName: string;
  isActive: boolean;
  categories: { id: string; name: string }[];
  channels: { id: string; name: string; color: string }[];
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        disabled={!isActive}
        title={!isActive ? "Kênh đã tắt — bật lại trong Cài đặt" : undefined}
        onClick={() => setOpen(true)}
      >
        + Thêm chi phí ads cho kênh này
      </Button>
      <ExpenseFormModal
        open={open}
        onOpenChange={setOpen}
        categories={categories}
        channels={channels}
        preset={{
          categoryId: "ads",
          channelId,
          adsSource: ADS_SOURCE_BY_CHANNEL[channelId],
          lockCategory: true,
          lockChannel: true,
        }}
        createSuccessMessage={`Đã thêm chi phí ads cho ${channelName}`}
      />
    </>
  );
}
