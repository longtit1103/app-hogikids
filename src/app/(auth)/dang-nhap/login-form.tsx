"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { login } from "@/lib/actions/auth";
import type { ActionResult } from "@/lib/actions/action-result";

const INITIAL_STATE: ActionResult | null = null;

export function LoginForm({ redirectTo }: { redirectTo: string }) {
  const router = useRouter();
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    (_prevState, formData) => login(formData),
    INITIAL_STATE
  );

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [capsLockOn, setCapsLockOn] = useState(false);
  const [lockoutSeconds, setLockoutSeconds] = useState<number | null>(null);

  // Login succeeded server-side (session cookie set) — leave /dang-nhap.
  useEffect(() => {
    if (state?.ok) {
      router.push(redirectTo);
      router.refresh();
    }
  }, [state, router, redirectTo]);

  // Start the lockout countdown shown on the submit button.
  useEffect(() => {
    if (state && !state.ok && state.code === "LOCKED") {
      const match = state.error.match(/(\d+)/);
      setLockoutSeconds(match ? Number(match[1]) : 60);
    }
  }, [state]);

  useEffect(() => {
    if (lockoutSeconds === null || lockoutSeconds <= 0) {
      return;
    }
    const timer = setTimeout(() => {
      setLockoutSeconds((seconds) => (seconds ?? 1) - 1);
    }, 1000);
    return () => clearTimeout(timer);
  }, [lockoutSeconds]);

  const isLocked = lockoutSeconds !== null && lockoutSeconds > 0;
  const isDisabled = isPending || isLocked || !email.trim() || !password;

  return (
    <div className="flex flex-col gap-6">
      <h2 className="font-serif text-2xl text-ink">Đăng nhập</h2>

      <form action={formAction} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="email" className="text-sm font-medium text-ink">
            Email
          </label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="h-10"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="password" className="text-sm font-medium text-ink">
            Mật khẩu
          </label>
          <div className="relative">
            <Input
              id="password"
              name="password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => setCapsLockOn(event.getModifierState("CapsLock"))}
              onKeyUp={(event) => setCapsLockOn(event.getModifierState("CapsLock"))}
              onBlur={() => setCapsLockOn(false)}
              className="h-10 pr-10"
            />
            <button
              type="button"
              onClick={() => setShowPassword((visible) => !visible)}
              className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-ink"
              aria-label={showPassword ? "Ẩn mật khẩu" : "Hiện mật khẩu"}
            >
              {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
          {capsLockOn && <p className="text-xs text-warning">Caps Lock đang bật</p>}
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Checkbox id="remember" name="remember" value="on" defaultChecked />
            <label htmlFor="remember" className="cursor-pointer text-sm text-ink select-none">
              Ghi nhớ đăng nhập
            </label>
          </div>
          <ForgotPasswordDialog />
        </div>

        {state && !state.ok && (
          <div className="rounded-lg bg-error/10 px-3 py-2 text-sm text-error" role="alert">
            {state.error}
          </div>
        )}

        <Button type="submit" className="h-10 w-full" disabled={isDisabled}>
          {isLocked ? (
            `Thử lại sau ${lockoutSeconds}s…`
          ) : isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            "Đăng nhập"
          )}
        </Button>
      </form>
    </div>
  );
}

function ForgotPasswordDialog() {
  return (
    <Dialog>
      <DialogTrigger type="button" className="text-sm text-primary hover:underline">
        Quên mật khẩu?
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Quên mật khẩu?</DialogTitle>
          <DialogDescription>
            Ứng dụng chỉ có 1 tài khoản quản trị. Vui lòng liên hệ trực tiếp với quản trị viên
            để được hỗ trợ đặt lại mật khẩu.
          </DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  );
}
