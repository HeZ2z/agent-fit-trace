import { Platform } from "react-native";

import { getHealthConnectProvider } from "./healthConnect";
import { getHealthKitProvider } from "./healthKit";
import {
  healthPlatformFor,
  type HealthPlatform,
  type PlatformHealthProvider,
  type SleepImportResult,
} from "./healthModel.ts";

/**
 * Per-platform provider selection for the Health screen (issue #51).
 *
 * The screen talks to one `PlatformHealthProvider` and never branches on
 * `Platform.OS` itself: this module resolves which device health store to read,
 * and the pure `healthStatusView` resolves which copy to show. Both native
 * adapters keep their own lazy `require`, so selecting a provider here never
 * touches a native module on the wrong platform — the `other` arm is a stub
 * that reports the platform as unavailable without loading anything.
 *
 * Tests never import this module (it pulls in React Native through the
 * adapters); the pure platform and status rules it relies on live in
 * `healthModel.ts` and are covered there.
 */

/** The current device's health-store platform, from React Native's `Platform.OS`. */
export function currentHealthPlatform(): HealthPlatform {
  return healthPlatformFor(Platform.OS);
}

/**
 * The provider for a platform with no health store (web, a test shell). It
 * answers every call with the same honest "not on this platform" result instead
 * of loading a native module or pretending to have data.
 */
function createUnsupportedProvider(): PlatformHealthProvider {
  return {
    sourceKind: "health-connect",
    async availability() {
      return { kind: "unavailable", reason: "platform" };
    },
    async requestReadPermissions() {
      // No grant is observable here; the granular arm with nothing granted is
      // what makes `sleepReadUsable` false and the status line say "platform".
      return { kind: "granted", granted: [], missing: [] };
    },
    async currentPermissions() {
      return { kind: "granted", granted: [], missing: [] };
    },
    async sleepHoursForDate(): Promise<SleepImportResult> {
      return { kind: "unavailable", reason: "platform" };
    },
    async restingHeartRateForDate(): Promise<number | null> {
      return null;
    },
  };
}

let providerSingleton: PlatformHealthProvider | null = null;
let providerPlatform: HealthPlatform | null = null;

/**
 * The provider for this device, chosen once per platform and cached. A platform
 * change cannot happen in a running app, but keying the cache on the resolved
 * platform keeps a test shell (or a re-mount after a mocked `Platform.OS`)
 * from being handed the wrong store.
 */
export function getHealthProvider(): PlatformHealthProvider {
  const platform = currentHealthPlatform();
  if (providerSingleton !== null && providerPlatform === platform) return providerSingleton;
  providerPlatform = platform;
  providerSingleton =
    platform === "android"
      ? getHealthConnectProvider()
      : platform === "ios"
        ? getHealthKitProvider()
        : createUnsupportedProvider();
  return providerSingleton;
}
