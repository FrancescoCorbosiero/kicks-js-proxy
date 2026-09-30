import { attempt, readHome } from "@/server/vetrina/service";
import { HomeScreen } from "@/components/vetrina/HomeScreen";

export const dynamic = "force-dynamic";

/** "La tua homepage": read live from the site on every visit — never cached. */
export default async function VetrinaPage() {
  const result = await attempt(() => readHome());
  return <HomeScreen result={result} />;
}
