import { LinkButton, Notice } from "@/components/ui";
import { routes } from "@/lib/routes";

export function UnsupportedTask() {
  return <Notice tone="warning" title="This activity cannot be opened here">
    <p>The activity uses a format this player does not support. Your work has not been changed.</p>
    <LinkButton href={routes.library} variant="secondary">Return to your library</LinkButton>
  </Notice>;
}
