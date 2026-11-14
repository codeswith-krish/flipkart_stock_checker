import type { CheckResult } from "../../types/index.js";

export interface CheckCycleSummary {
  startedAt: string;
  completedAt: string;
  totalChecked: number;
  alertsTriggered: number;
  results: CheckResult[];
}
