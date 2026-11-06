import { NoticesPage } from "@/components/NoticesPage";
import { RequireRole } from "@/components/Shell";

export default function Notices() {
  return (
    <RequireRole roles={["tenant_admin"]}>
      <NoticesPage />
    </RequireRole>
  );
}
