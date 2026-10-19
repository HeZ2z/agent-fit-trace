import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

import { SKINS, type SkinName, type SkinTokens } from "./index";

interface SkinContextValue {
  skin: SkinName;
  tokens: SkinTokens;
  setSkin: (skin: SkinName) => void;
  toggleSkin: () => void;
}

const SkinContext = createContext<SkinContextValue | null>(null);

/** Skin state for the prototype shell; persistence lands with the settings store. */
export function SkinProvider({ children }: { children: ReactNode }) {
  const [skin, setSkin] = useState<SkinName>("pixel");
  const value = useMemo<SkinContextValue>(() => {
    const set = (next: SkinName) => setSkin(next);
    return {
      skin,
      tokens: SKINS[skin],
      setSkin: set,
      toggleSkin: () => set(skin === "pixel" ? "glass" : "pixel"),
    };
  }, [skin]);

  return <SkinContext.Provider value={value}>{children}</SkinContext.Provider>;
}

export function useSkin(): SkinContextValue {
  const value = useContext(SkinContext);
  if (value === null) {
    throw new Error("useSkin must be used inside a SkinProvider");
  }
  return value;
}
