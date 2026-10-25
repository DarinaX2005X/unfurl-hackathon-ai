import { AccountPage } from "@/features/account/AccountPage";

export const metadata = { title: "Your account | Unfurl", robots: { index: false, follow: false } };
export default function AccountRoute() { return <AccountPage />; }
