import { RequireRole } from "@/components/Shell";
import { ConsentsPage } from "@/components/ConsentsPage";

export default function Consents() {
  return (
    <RequireRole roles={["dpo"]}>
      <ConsentsPage />
    </RequireRole>
  );
}
