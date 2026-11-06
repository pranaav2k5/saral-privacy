import { IntegrationsPage } from "@/components/IntegrationsPage";
import { RequireRole } from "@/components/Shell";

export default function Integrations() {
  return (
    <RequireRole roles={["tenant_admin"]}>
      <IntegrationsPage />
    </RequireRole>
  );
}
