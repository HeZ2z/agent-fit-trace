import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { isSkinName, SKINS, type SkinName, type SkinTokens } from "./index";

/** Versioned key so a future palette migration can coexist with v1. */
export const SKIN_STORAGE_KEY = "pi-fit-trace:skin:v1";

interface SkinContextValue {
  skin: SkinName;
  tokens: SkinTokens;
  setSkin: (skin: SkinName) => void;
  toggleSkin: () => void;
}

const SkinContext = createContext<SkinContextValue | null>(null);

async function readStoredSkin(): Promise<SkinName | null> {
  try {
    const stored = await AsyncStorage.getItem(SKIN_STORAGE_KEY);
    return isSkinName(stored) ? stored : null;
  } catch {
    // Memory-only fallback: keep the in-memory default and never block startup.
    return null;
  }
}

function persistSkin(skin: SkinName): void {
  try {
    void AsyncStorage.setItem(SKIN_STORAGE_KEY, skin).catch(() => {
      // Writes are best-effort; the selected skin still applies for this session.
    });
  } catch {
    // The native storage module can be unavailable (tests, web fallback, ...).
  }
}

/**
 * Skin state for the prototype shell. The provider hydrates the stored choice
 * once on mount and persists every explicit change; both operations fail soft.
 */
export function SkinProvider({ children }: { children: ReactNode }) {
  const [skin, setSkinState] = useState<SkinName>("pixel");
  const mountedRef = useRef(true);
  const userSelectedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    void (async () => {
      const stored = await readStoredSkin();
      // Do not overwrite a choice the user made while storage was loading.
      if (mountedRef.current && stored !== null && !userSelectedRef.current) {
        setSkinState(stored);
      }
    })();

    return () => {
      mountedRef.current = false;
    };
  }, []);

  const value = useMemo<SkinContextValue>(() => {
    const setSkin = (next: SkinName) => {
      userSelectedRef.current = true;
      setSkinState(next);
      persistSkin(next);
    };

    return {
      skin,
      tokens: SKINS[skin],
      setSkin,
      toggleSkin: () => setSkin(skin === "pixel" ? "glass" : "pixel"),
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
