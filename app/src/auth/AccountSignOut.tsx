import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCoach } from "../coaching/useCoach.ts";
import { useI18n } from "../i18n/useI18n.ts";
import { useAuth } from "./AuthContext.tsx";

export function AccountSignOut() {
  const { status, user, signOutSession } = useAuth();
  const coach = useCoach();
  const navigate = useNavigate();
  const { t } = useI18n();
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (status !== "signed-in" || user === null || user.isAnonymous === true) return null;

  async function onSignOut(): Promise<void> {
    setSigningOut(true);
    setError(null);
    try {
      coach.teardown();
      await signOutSession();
      navigate("/login", { replace: true });
    } catch {
      setError(t("Could not confirm sign out. Check your connection and try again."));
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <>
      <button type="button" disabled={signingOut} onClick={() => void onSignOut()}>
        {signingOut ? t("Signing out…") : t("Sign out")}
      </button>
      {error !== null ? <p role="alert">{error}</p> : null}
    </>
  );
}
