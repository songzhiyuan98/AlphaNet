import type { Metadata } from "next";

import { ResetPasswordForm } from "../../../components/auth/reset-password-form";

export const metadata: Metadata = {
  title: "设置新密码 · AlphaNet",
};

export default function ResetPasswordPage() {
  return <ResetPasswordForm />;
}
