import { RequireRole } from "@/components/Shell";
import { RequestsPage } from "@/components/RequestsPage";

export default function Requests() {
  return (
    <RequireRole roles={["dpo"]}>
      <RequestsPage />
    </RequireRole>
  );
}
