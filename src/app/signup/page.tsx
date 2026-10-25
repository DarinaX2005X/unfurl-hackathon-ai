import { AuthScreen } from "@/features/account/AuthScreen";
import { authRouteInput, type AuthSearchParams } from "@/features/account/auth-route";

export const metadata = { title: "Create an account | Unfurl", robots: { index: false, follow: false } };
export default async function SignupRoute({ searchParams }: { searchParams: Promise<AuthSearchParams> }) {
  return <AuthScreen mode="signup" {...authRouteInput(await searchParams)} />;
}
