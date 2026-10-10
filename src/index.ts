export { renderAgentsMd } from "./scaffold/agentsmd.js";
export {
  CONFIG_FILE,
  defaultConfig,
  renderConfig,
  type AgentMaxxingConfig,
} from "./scaffold/config.js";
export {
  listSkills,
  installSkill,
  parseSkillFrontmatter,
  PKG_ROOT,
  type SkillInfo,
  type InstallResult,
} from "./skills.js";
export { audit, type AuditCheck, type AuditReport } from "./audit.js";
