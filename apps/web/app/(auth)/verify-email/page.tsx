import type { Metadata } from "next";

import { VerifyEmailForm } from "../../../components/auth/verify-email-form";

export const metadata: Metadata = {
  title: "验证邮箱 · AlphaNet",
};

type SearchValue = string | string[] | undefined;

function first(value: SearchValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function VerifyEmailPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<Record<string, SearchValue>>;
}>) {
  const params = await searchParams;
  const reason = first(params.reason);
  const verificationError = first(params.error);

  return (
    <VerifyEmailForm
      verified={first(params.verified) === "1" && !verificationError}
      verificationFailed={Boolean(verificationError)}
      {...(reason ? { reason } : {})}
    />
  );
}
