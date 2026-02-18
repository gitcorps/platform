export function initialStatusTemplate(projectName: string): string {
  return `# STATUS\n\n## Project\n- Name: ${projectName}\n- Updated: ${new Date().toISOString()}\n\n## Current State\n- Repository initialized by GitCorps.\n- First autonomous run will choose the first milestone from VISION.md.\n\n## Next Milestone\n- Establish an executable baseline with tests where feasible.\n\n## Run Log\n- No runs have completed yet.`;
}
