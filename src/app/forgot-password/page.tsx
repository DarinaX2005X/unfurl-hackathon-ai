import { AuthScreen } from "@/features/account/AuthScreen";
import { authRouteInput, type AuthSearchParams } from "@/features/account/auth-route";

export const metadata = { title: "Reset your password | Unfurl", robots: { index: false, follow: false } };
export default async function ForgotPasswordRoute({ searchParams }: { searchParams: Promise<AuthSearchParams> }) {
  return <AuthScreen mode="forgot-password" {...authRouteInput(await searchParams)} />;
}
