import type { Metadata } from "next";

import { ForgotPasswordForm } from "../../../components/auth/forgot-password-form";

export const metadata: Metadata = {
  title: "重置密码 · AlphaNet",
};

export default function ForgotPasswordPage() {
  return <ForgotPasswordForm />;
}
