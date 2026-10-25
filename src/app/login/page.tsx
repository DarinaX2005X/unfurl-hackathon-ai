import { AuthScreen } from "@/features/account/AuthScreen";
import { authRouteInput, type AuthSearchParams } from "@/features/account/auth-route";

export const metadata = { title: "Sign in | Unfurl", robots: { index: false, follow: false } };
export default async function LoginRoute({ searchParams }: { searchParams: Promise<AuthSearchParams> }) {
  return <AuthScreen mode="login" {...authRouteInput(await searchParams)} />;
}
