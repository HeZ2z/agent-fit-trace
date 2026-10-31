import { useNavigate } from "react-router-dom";
import { useCoach } from "../coaching/useCoach.ts";
import { useI18n } from "../i18n/useI18n.ts";
import { useAuth } from "./AuthContext.tsx";

export function AccountSignOut() {
  const { status, user, signOutSession } = useAuth();
  const coach = useCoach();
  const navigate = useNavigate();
  const { t } = useI18n();
  if (status !== "signed-in" || user === null || user.isAnonymous === true) return null;

  return (
    <button type="button" onClick={() => {
      coach.teardown();
      void signOutSession();
      navigate("/login", { replace: true });
    }}>
      {t("Sign out")}
    </button>
  );
}
