import { FUNDING_DISCLAIMER } from "../lib/constants";

export function Disclaimer() {
  return (
    <aside className="disclaimer">
      <strong>Important:</strong> {FUNDING_DISCLAIMER}
    </aside>
  );
}
