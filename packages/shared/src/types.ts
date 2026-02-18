export type ProjectStatus = "active" | "paused" | "failed";

export type RunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "out_of_funds";

export interface UserDoc {
  createdAt: unknown;
  displayName: string;
  stripeCustomerId?: string;
}

export interface ProjectDoc {
  slug: string;
  name: string;
  manifestoMd: string;
  repoFullName: string;
  repoUrl: string;
  siteUrl?: string;
  createdByUid: string;
  balanceCents: number;
  currentRunId: string | null;
  status: ProjectStatus;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface RunDoc {
  status: RunStatus;
  budgetCents: number;
  spentCents?: number;
  startedAt?: unknown;
  endedAt?: unknown;
  heartbeatAt?: unknown;
  summaryMd?: string;
  agentRuntime: string;
}

export interface FundingEventDoc {
  uid: string | null;
  amountCents: number;
  stripePaymentIntentId: string;
  createdAt: unknown;
}
