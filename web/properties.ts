// Display names are opaque labels; keep API identifiers stable when renaming.
export const propertyLabels: Record<string, string> = {
  panic_contract: "Panic contract",
  no_ub: "No undefined behavior",
};
export function prop(property: string): string {
  return propertyLabels[property] ?? property;
}
