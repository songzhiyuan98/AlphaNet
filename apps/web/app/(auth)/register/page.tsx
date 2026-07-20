import type { Metadata } from "next";

import { RegisterForm } from "../../../components/auth/register-form";
import { isGoogleAuthEnabled } from "../../../lib/web-auth-config";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "注册 Owner 账户 · AlphaNet",
};

export default function RegisterPage() {
  return <RegisterForm googleAuthEnabled={isGoogleAuthEnabled()} />;
}
