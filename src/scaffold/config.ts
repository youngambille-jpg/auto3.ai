export const CONFIG_FILE = "agentmaxxing.config.json";

export interface AgentMaxxingConfig {
  $schema: string;
  version: number;
  skills: {
    dir: string;
    enabled: string[];
  };
  audit: {
    /** Fail the audit (non-zero exit) below this percentage. */
    failBelow: number;
  };
}

export function defaultConfig(): AgentMaxxingConfig {
  return {
    $schema: "https://agentmaxxing.dev/schema/config.json",
    version: 1,
    skills: {
      dir: ".agents/skills",
      enabled: ["commit-conventions"],
    },
    audit: {
      failBelow: 60,
    },
  };
}

export function renderConfig(): string {
  return `${JSON.stringify(defaultConfig(), null, 2)}\n`;
}
