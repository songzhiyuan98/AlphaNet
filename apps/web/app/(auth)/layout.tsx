import type { Metadata } from "next";
import type { ReactNode } from "react";

import { AuthShell } from "../../components/auth/auth-shell";

export const metadata: Metadata = {
  referrer: "no-referrer",
  robots: {
    follow: false,
    index: false,
  },
};

export default function AuthLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <AuthShell>{children}</AuthShell>;
}
