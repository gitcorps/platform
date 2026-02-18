export interface RunnerContext {
  vision: string;
  status: string;
  tree: string[];
}

export interface RunPlan {
  attempted: string;
  changed: string;
  works: string;
  broken: string;
  nextMilestone: string;
  summary: string;
}

export interface LlmProvider {
  id: string;
  complete(prompt: string): Promise<string>;
}

export interface AgentRuntime {
  id: string;
  plan(context: RunnerContext): Promise<RunPlan>;
}
