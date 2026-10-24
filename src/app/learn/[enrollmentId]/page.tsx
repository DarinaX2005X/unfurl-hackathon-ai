import { PublicHeader } from "@/components/shell";
import { LinkButton } from "@/components/ui";
import { routes } from "@/lib/routes";
import styles from "@/features/learning/sample/sample.module.css";

export default function UnavailableLearningPage() {
  return <><PublicHeader /><main id="main-content" className={styles.unavailable}>
    <h1>This learning session isn’t available</h1>
    <p>Open a course from your library to continue learning. You can also try a short model experiment without starting a course.</p>
    <div><LinkButton href={routes.library}>Open your library</LinkButton><LinkButton href={routes.try} variant="secondary">Try the experiment</LinkButton></div>
  </main></>;
}
