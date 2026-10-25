import { AuthScreen } from "@/features/account/AuthScreen";
import { authRouteInput, type AuthSearchParams } from "@/features/account/auth-route";

export const metadata = { title: "Choose a new password | Unfurl", robots: { index: false, follow: false } };
export default async function ResetPasswordRoute({ searchParams }: { searchParams: Promise<AuthSearchParams> }) {
  return <AuthScreen mode="reset-password" {...authRouteInput(await searchParams)} />;
}
