import { describe, expect, it } from "vitest";
import { detectDeviceKind, deviceKindOf } from "./deviceKind";

const UA = {
  androidPhone:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36",
  androidTablet:
    "Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  ipadDesktop:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  windows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
};

describe("type d’appareil", () => {
  it("reconnaît téléphones, tablettes et ordinateurs", () => {
    expect(detectDeviceKind(UA.androidPhone)).toBe("phone");
    expect(detectDeviceKind(UA.androidTablet)).toBe("tablet");
    expect(detectDeviceKind(UA.iphone)).toBe("phone");
    expect(detectDeviceKind(UA.ipadDesktop, 5)).toBe("tablet");
    expect(detectDeviceKind(UA.ipadDesktop, 0)).toBe("computer");
    expect(detectDeviceKind(UA.windows)).toBe("computer");
  });

  it("devine le type des appareils inscrits avant ce champ", () => {
    expect(deviceKindOf({ label: "Android · Chrome" })).toBe("phone");
    expect(deviceKindOf({ label: "Windows · Edge" })).toBe("computer");
    expect(deviceKindOf({ label: "Mac · Safari" })).toBe("computer");
    expect(deviceKindOf({ label: "Appareil · Navigateur" })).toBeUndefined();
    expect(deviceKindOf({ label: "Android · Chrome", kind: "tablet" })).toBe(
      "tablet",
    );
    expect(deviceKindOf({ label: "Android · Chrome", kind: "bizarre" })).toBe(
      "phone",
    );
  });
});
