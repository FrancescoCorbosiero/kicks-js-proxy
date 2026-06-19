import type { Locale } from "./config";
import { it } from "./dictionaries/it";
import { en } from "./dictionaries/en";

/** The dictionary contract: every locale matches the Italian source of truth. */
export type Dictionary = typeof it;

const dictionaries: Record<Locale, Dictionary> = { it, en };

export function getDictionary(locale: Locale): Dictionary {
  return dictionaries[locale];
}
