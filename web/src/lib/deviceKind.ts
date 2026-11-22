/**
 * Type d'appareil (ordinateur, téléphone, tablette) pour l'écran Cercles.
 * Calcul pur : à partir du navigateur à l'inscription, ou, pour les appareils inscrits avant que ce champ
 * existe, deviné d'après leur nom affiché (« Android · Chrome », « Windows · Edge »…).
 */
export type DeviceKind = "phone" | "tablet" | "computer";

/** Type de l'appareil courant d'après son navigateur (`maxTouchPoints` : un iPad récent se dit « Mac »). */
export function detectDeviceKind(ua: string, maxTouchPoints = 0): DeviceKind {
  if (/iPad|Tablet/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1))
    return "tablet";
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? "phone" : "tablet";
  if (/iPhone|iPod|Mobile/.test(ua)) return "phone";
  return "computer";
}

/** Type affiché : le champ enregistré s'il existe, sinon deviné d'après le nom. */
export function deviceKindOf(
  d: { kind?: unknown; label?: string } | undefined,
): DeviceKind | undefined {
  if (d?.kind === "phone" || d?.kind === "tablet" || d?.kind === "computer")
    return d.kind;
  const label = d?.label ?? "";
  if (/^(Android|iPhone)/.test(label)) return "phone";
  if (/^(Windows|Mac|Linux)/.test(label)) return "computer";
  return undefined;
}

export const DEVICE_KIND_LABEL: Record<DeviceKind, string> = {
  phone: "Téléphone",
  tablet: "Tablette",
  computer: "Ordinateur",
};
