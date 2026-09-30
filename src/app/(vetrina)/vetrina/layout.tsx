import type { Metadata } from "next";
import type { ReactNode } from "react";
import { hubConfig } from "@/config";
import { getServerDictionary } from "@/i18n/server";
import { VetrinaApp } from "@/components/vetrina/VetrinaApp";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDictionary();
  return { title: `${t.vetrina.title} — Store Hub` };
}

/** The Vetrina: the customer's mobile app shell, apart from the operator tabs. */
export default function VetrinaLayout({ children }: { children: ReactNode }) {
  return <VetrinaApp theme={hubConfig.vetrina.theme}>{children}</VetrinaApp>;
}
