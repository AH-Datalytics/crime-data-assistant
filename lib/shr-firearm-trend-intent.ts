/**
 * Recognize simple firearm-homicide count trends that the deterministic SHR
 * shooting route can answer without generating SQL or prose with a model.
 */
export function asksSimpleFirearmHomicideTrend(question: string): boolean {
  const hasFirearm = /\b(?:firearms?|guns?)\b/i.test(question);
  const hasHomicide = /\b(?:murders?|homicides?|killings?)\b/i.test(question);
  if (!hasFirearm || !hasHomicide) return false;

  const asksTrend =
    /\b(?:since|starting|beginning|from|between|through|annual(?:ly)?|by\s+year|each\s+year|over\s+time|trend)\b/i.test(question);
  if (!asksTrend) return false;

  return !/\b(?:share|percent(?:age)?|proportion|rate|per\s+(?:capita|\d)|compare|versus|vs\.?|top|highest|lowest|rank(?:ing)?|rolling|monthly|by\s+(?:race|sex|gender|age|ethnicity|relationship|circumstance|weapon))\b/i.test(question);
}
