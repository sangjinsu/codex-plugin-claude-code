#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const EXIT_USAGE = 1;
const EXIT_CLAUDE_MISSING = 2;
const EXIT_CLAUDE_AUTH = 3;
const EXIT_PLAN_FAILED = 4;
const DEFAULT_PLAN_TIMEOUT_MS = 180_000;
const DEFAULT_CONTEXT_FILE_LIMIT = 200;
const SKILL_DESCRIPTION_PREVIEW_LENGTH = 100;
const REQUIRED_PLAN_SECTIONS = ["Summary", "Current Understanding", "Plan", "Validation", "Risks"];
const DESTRUCTIVE_COMMAND_PATTERNS = [
  { label: "rm -rf", pattern: /\brm\s+-rf\b/i },
  { label: "git reset --hard", pattern: /\bgit\s+reset\s+--hard\b/i },
  { label: "git push --force", pattern: /\bgit\s+push\s+(?:--force|-f)\b/i },
  { label: "DROP TABLE", pattern: /\bDROP\s+TABLE\b/i },
  { label: "kubectl delete", pattern: /\bkubectl\s+delete\b/i }
];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PLUGIN_ROOT = path.resolve(__dirname, "../../..");
const PLUGIN_ROOT = path.resolve(
  process.env.CODEX_PLUGIN_ROOT ||
    process.env.CLAUDE_PLUGIN_ROOT ||
    DEFAULT_PLUGIN_ROOT
);

const REQUIRED_FILES = [
  ".codex-plugin/plugin.json",
  "skills/doctor/SKILL.md",
  "skills/setup/SKILL.md",
  "skills/plan/SKILL.md",
  "skills/skills/SKILL.md",
  "plugins/claude/scripts/claude-companion.mjs",
  "plugins/claude/prompts/plan.md"
];

const SENSITIVE_VALUE_PATTERNS = [
  /\b(sk-ant-[A-Za-z0-9_-]{12,})\b/g,
  /\b(sk-[A-Za-z0-9_-]{20,})\b/g,
  /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  /\b(gh[pousr]_[A-Za-z0-9_]{20,})\b/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
];

const SENSITIVE_ASSIGNMENT_PATTERN =
  /\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|COOKIE|PRIVATE_KEY|AUTH)[A-Z0-9_]*)\s*=\s*([^\s]+)/gi;

function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    process.exit(0);
  }

  if (command === "doctor") {
    process.exit(handleDoctor());
  }

  if (command === "setup") {
    process.exit(handleSetup());
  }

  if (command === "skills") {
    process.exit(handleSkills(args));
  }

  if (command === "plan") {
    process.exit(handlePlan(args));
  }

  printError(`Unknown command: ${command}`);
  printHelp();
  process.exit(EXIT_USAGE);
}

function printHelp() {
  console.log(`Claude companion for the Codex Claude plugin.

Usage:
  node plugins/claude/scripts/claude-companion.mjs doctor
  node plugins/claude/scripts/claude-companion.mjs setup
  node plugins/claude/scripts/claude-companion.mjs skills [--scope all|local|global] [--query <text>] [--format text|json]
  node plugins/claude/scripts/claude-companion.mjs plan "<request>"
  node plugins/claude/scripts/claude-companion.mjs plan --list-skills [--query <text>]
  node plugins/claude/scripts/claude-companion.mjs plan --recommend-skills "<request>"
  node plugins/claude/scripts/claude-companion.mjs plan --check <plan-file|->
  node plugins/claude/scripts/claude-companion.mjs plan --dry-run [--show-skills] "<request>"
  node plugins/claude/scripts/claude-companion.mjs plan --output PLAN.md "<request>"
  node plugins/claude/scripts/claude-companion.mjs plan --skill <id> "<request>"
  printf '<request>' | node plugins/claude/scripts/claude-companion.mjs plan

Commands:
  doctor  Diagnose Claude CLI, auth, prompt execution, project, and plugin files.
  setup   Check Claude CLI, auth status, project status, and plugin files.
  skills  List local and global Claude skills visible from this machine.
  plan    Ask Claude Code CLI for a read-only implementation plan.
`);
}

function handleDoctor() {
  const lines = ["Claude doctor", ""];
  const node = checkNodeRuntime();
  lines.push(`Node.js: ${node.ok ? "ok" : "unsupported"} (${node.detail})`);

  const claude = checkClaudeCli();
  lines.push(`Claude CLI: ${claude.available ? "available" : "missing"} (${claude.detail})`);

  let auth = { ok: false, label: "skipped", detail: "Claude CLI is unavailable" };
  if (claude.available) {
    auth = checkClaudeAuth();
  }
  lines.push(`Claude auth: ${auth.label}${auth.detail ? ` (${auth.detail})` : ""}`);

  const project = checkProject(process.cwd());
  lines.push(`Project: ${project.ok ? "ok" : "not detected"} (${project.detail})`);

  const files = checkRequiredFiles();
  const missingFiles = files.filter((file) => !file.exists);
  lines.push(`Plugin files: ${missingFiles.length === 0 ? "ok" : "missing files"}`);
  for (const file of missingFiles) {
    lines.push(`  missing ${file.path}`);
  }

  const skills = discoverSkills({
    cwd: process.cwd(),
    home: getHomeDirectory(),
    scope: "all",
    query: ""
  });
  lines.push(`Claude skills: ${skills.length} discovered`);

  let smoke = { ok: false, skipped: true, detail: "Claude CLI or auth is unavailable" };
  if (claude.available && auth.ok) {
    smoke = checkClaudePromptSmoke();
  }
  lines.push(`Claude prompt smoke: ${smoke.ok ? "ok" : smoke.skipped ? "skipped" : "failed"}`);
  if (smoke.detail) {
    lines.push(`Claude prompt smoke detail: ${smoke.detail}`);
  }

  lines.push("", "Next steps:");
  let exitCode = 0;
  if (!node.ok) {
    lines.push("Install Node.js 20 or newer before using this plugin.");
    exitCode = EXIT_USAGE;
  } else if (!claude.available) {
    lines.push("Install Claude Code CLI separately, then rerun `claude:doctor`.");
    exitCode = EXIT_CLAUDE_MISSING;
  } else if (!auth.ok) {
    lines.push("Run `claude auth login`, then rerun `claude:doctor`.");
    exitCode = EXIT_CLAUDE_AUTH;
  } else if (!smoke.ok) {
    lines.push(formatClaudeFailureAdvice(smoke.failure, "planning"));
    exitCode = EXIT_PLAN_FAILED;
  } else if (!project.ok || missingFiles.length > 0) {
    lines.push("Restore the project/plugin structure, then rerun `claude:doctor`.");
    exitCode = EXIT_USAGE;
  } else {
    lines.push("Ready. Try `claude:plan --recommend-skills <request>` or `claude:plan <request>`.");
  }

  console.log(redactSecrets(lines.join(os.EOL)));
  return exitCode;
}

function handleSetup() {
  const lines = ["Claude setup check", ""];
  const claude = checkClaudeCli();

  if (claude.available) {
    lines.push(`Claude CLI: available (${claude.detail})`);
  } else {
    lines.push(`Claude CLI: missing (${claude.detail})`);
  }

  const project = checkProject(process.cwd());
  lines.push(`Project: ${project.ok ? "ok" : "not detected"} (${project.detail})`);

  const files = checkRequiredFiles();
  lines.push("", "Plugin files:");
  for (const file of files) {
    lines.push(`  ${file.exists ? "ok" : "missing"} ${file.path}`);
  }

  let authOk = false;
  if (claude.available) {
    const auth = checkClaudeAuth();
    authOk = auth.ok;
    lines.splice(2, 0, `Claude auth: ${auth.label}`);
    if (auth.detail) {
      lines.splice(3, 0, `Claude auth detail: ${auth.detail}`);
    }
  } else {
    lines.splice(
      2,
      0,
      "Claude auth: skipped because the Claude CLI is not installed or not executable"
    );
  }

  const missingFiles = files.filter((file) => !file.exists);
  lines.push("", "Result:");

  if (!claude.available) {
    lines.push("Claude Code CLI is required. Install it separately, then rerun claude:setup.");
    console.log(redactSecrets(lines.join(os.EOL)));
    return EXIT_CLAUDE_MISSING;
  }

  if (!authOk) {
    lines.push("Claude CLI is installed, but authentication is not ready. Run `claude auth login`.");
    console.log(redactSecrets(lines.join(os.EOL)));
    return EXIT_CLAUDE_AUTH;
  }

  if (!project.ok || missingFiles.length > 0) {
    lines.push("Plugin structure is incomplete. Restore the missing files before using claude:plan.");
    console.log(redactSecrets(lines.join(os.EOL)));
    return EXIT_USAGE;
  }

  lines.push("Ready. You can run `claude:plan <request>`.");
  console.log(redactSecrets(lines.join(os.EOL)));
  return 0;
}

function handleSkills(args) {
  const options = parseSkillListArgs(args);
  if (options.help) {
    printSkillsHelp();
    return 0;
  }
  if (options.error) {
    printError(options.error);
    return EXIT_USAGE;
  }

  const skills = discoverSkills({
    cwd: process.cwd(),
    home: getHomeDirectory(),
    scope: options.scope,
    query: options.query
  });
  printSkills(skills, options.format);
  return 0;
}

function handlePlan(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage:
  node plugins/claude/scripts/claude-companion.mjs plan "<request>"
  node plugins/claude/scripts/claude-companion.mjs plan --list-skills [--query <text>]
  node plugins/claude/scripts/claude-companion.mjs plan --recommend-skills "<request>"
  node plugins/claude/scripts/claude-companion.mjs plan --check <plan-file|->
  node plugins/claude/scripts/claude-companion.mjs plan --dry-run [--show-skills] "<request>"
  node plugins/claude/scripts/claude-companion.mjs plan --output PLAN.md "<request>"
  node plugins/claude/scripts/claude-companion.mjs plan --show-skills [--skill <id>] "<request>"
  printf '<request>' | node plugins/claude/scripts/claude-companion.mjs plan

Options:
  --list-skills              List skills without running a plan
  --recommend-skills         Recommend skills for the request without running Claude
  --check <plan-file|->      Validate a Claude plan against the current repo
  --dry-run                  Print the prompt/context without running Claude
  --output <file>            Save the plan with metadata to a file
  --save                     Save the plan to PLAN.md
  --model <name>             Pass a Claude model name to the CLI
  --timeout <ms>             Override the Claude plan timeout
  --max-files <n>            Limit visible files included in the prompt
  --show-skills              Include matching skill candidates in the Claude prompt
  --skill <id>               Require one skill
  --skills <id,id>           Require multiple skills
  --scope all|local|global   Skill sources to scan (default: all)
  --query <text>             Filter skill lookup by id, name, description, or path
  --format text|json         Output format for skill list modes (default: text)`);
    return 0;
  }

  const planOptions = parsePlanArgs(args);
  if (planOptions.error) {
    printError(planOptions.error);
    return EXIT_USAGE;
  }

  if (planOptions.listSkills) {
    const skills = discoverSkills({
      cwd: process.cwd(),
      home: getHomeDirectory(),
      scope: planOptions.scope,
      query: planOptions.query
    });
    printSkills(skills, planOptions.format);
    return 0;
  }

  if (planOptions.checkPath !== null) {
    return handlePlanCheck(planOptions.checkPath);
  }

  if (planOptions.recommendSkills) {
    const recommendationText = readPlanRequest(planOptions.requestArgs) || planOptions.query;
    if (!recommendationText) {
      printError("Missing skill recommendation query. Pass a request or use --query <text>.");
      return EXIT_USAGE;
    }
    printRecommendedSkills({
      cwd: process.cwd(),
      home: getHomeDirectory(),
      scope: planOptions.scope,
      text: recommendationText
    });
    return 0;
  }

  const request = readPlanRequest(planOptions.requestArgs);
  if (!request) {
    printError(
      "Missing plan request. Pass a request argument, pipe one through stdin, or run `claude:plan --recommend-skills <request>` first."
    );
    return EXIT_USAGE;
  }

  const promptPath = path.join(PLUGIN_ROOT, "plugins/claude/prompts/plan.md");
  if (!fs.existsSync(promptPath)) {
    printError(`Missing prompt template: ${path.relative(PLUGIN_ROOT, promptPath)}`);
    return EXIT_USAGE;
  }

  const prompt = buildPlanPrompt({
    template: fs.readFileSync(promptPath, "utf8"),
    request,
    workspace: collectWorkspaceContext(process.cwd(), planOptions.maxFiles),
    skillContext: buildSkillContext({
      request,
      showSkills: planOptions.showSkills,
      explicitSkills: planOptions.explicitSkills,
      scope: planOptions.scope,
      query: planOptions.query
    })
  });

  if (planOptions.dryRun) {
    printPlanDryRun(prompt, planOptions);
    return 0;
  }

  const claude = checkClaudeCli();
  if (!claude.available) {
    printError("Claude Code CLI is not available. Run `claude:doctor` for details.");
    return EXIT_CLAUDE_MISSING;
  }

  const timeout = getPlanTimeoutMs();
  const effectiveTimeout = planOptions.timeout || timeout;
  const claudeArgs = buildClaudePlanArgs(prompt, planOptions);
  const result = runCommand(
    "claude",
    claudeArgs,
    {
      cwd: process.cwd(),
      maxBuffer: 20 * 1024 * 1024,
      timeout: effectiveTimeout
    }
  );

  if (result.error) {
    printError(formatClaudeFailure(result, { action: "plan", timeout: effectiveTimeout }));
    return EXIT_PLAN_FAILED;
  }

  if (result.status !== 0) {
    printError(formatClaudeFailure(result, { action: "plan", timeout: effectiveTimeout }));
    return EXIT_PLAN_FAILED;
  }

  const output = redactSecrets(result.stdout.trimEnd());
  if (!output.trim()) {
    printError("Claude returned no plan output. Try a narrower request or run `claude:doctor`.");
    return EXIT_PLAN_FAILED;
  }

  if (output) {
    console.log(output);
  }
  if (planOptions.outputPath) {
    const savePath = path.resolve(process.cwd(), planOptions.outputPath);
    fs.mkdirSync(path.dirname(savePath), { recursive: true });
    fs.writeFileSync(
      savePath,
      formatSavedPlan({
        request,
        output,
        explicitSkills: uniqueValues(planOptions.explicitSkills)
      }),
      "utf8"
    );
    console.log(`Plan saved: ${savePath}`);
  }
  return 0;
}

function printSkillsHelp() {
  console.log(`Usage:
  node plugins/claude/scripts/claude-companion.mjs skills [options]

Options:
  --scope all|local|global   Skill sources to scan (default: all)
  --query <text>             Filter by id, name, description, or path
  --format text|json         Output format (default: text)
`);
}

function parseSkillListArgs(args) {
  const options = { scope: "all", query: "", format: "text", help: false, error: "" };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--scope") {
      options.scope = args[++index] || "";
    } else if (arg.startsWith("--scope=")) {
      options.scope = arg.slice("--scope=".length);
    } else if (arg === "--query") {
      options.query = args[++index] || "";
    } else if (arg.startsWith("--query=")) {
      options.query = arg.slice("--query=".length);
    } else if (arg === "--format") {
      options.format = args[++index] || "";
    } else if (arg.startsWith("--format=")) {
      options.format = arg.slice("--format=".length);
    } else {
      options.error = `Unknown skills option: ${arg}`;
      break;
    }
  }

  if (!["all", "local", "global"].includes(options.scope)) {
    options.error = "Invalid --scope. Use all, local, or global.";
  }
  if (!["text", "json"].includes(options.format)) {
    options.error = "Invalid --format. Use text or json.";
  }

  return options;
}

function parsePlanArgs(args) {
  const options = {
    checkPath: null,
    requestArgs: [],
    explicitSkills: [],
    dryRun: false,
    listSkills: false,
    recommendSkills: false,
    showSkills: false,
    scope: "all",
    query: "",
    format: "text",
    maxFiles: DEFAULT_CONTEXT_FILE_LIMIT,
    model: "",
    outputPath: "",
    timeout: 0,
    error: ""
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--list-skills") {
      options.listSkills = true;
    } else if (arg === "--recommend-skills") {
      options.recommendSkills = true;
    } else if (arg === "--check") {
      options.checkPath = args[++index] || "";
    } else if (arg.startsWith("--check=")) {
      options.checkPath = arg.slice("--check=".length);
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--output") {
      options.outputPath = args[++index] || "";
    } else if (arg.startsWith("--output=")) {
      options.outputPath = arg.slice("--output=".length);
    } else if (arg === "--save") {
      options.outputPath = "PLAN.md";
    } else if (arg === "--model") {
      options.model = args[++index] || "";
    } else if (arg.startsWith("--model=")) {
      options.model = arg.slice("--model=".length);
    } else if (arg === "--timeout") {
      options.timeout = parsePositiveIntegerOption(args[++index] || "", "--timeout");
    } else if (arg.startsWith("--timeout=")) {
      options.timeout = parsePositiveIntegerOption(arg.slice("--timeout=".length), "--timeout");
    } else if (arg === "--max-files") {
      options.maxFiles = parsePositiveIntegerOption(args[++index] || "", "--max-files");
    } else if (arg.startsWith("--max-files=")) {
      options.maxFiles = parsePositiveIntegerOption(arg.slice("--max-files=".length), "--max-files");
    } else if (arg === "--show-skills") {
      options.showSkills = true;
    } else if (arg === "--skill") {
      addExplicitSkills(options, args[++index] || "");
    } else if (arg.startsWith("--skill=")) {
      addExplicitSkills(options, arg.slice("--skill=".length));
    } else if (arg === "--skills") {
      addExplicitSkills(options, args[++index] || "");
    } else if (arg.startsWith("--skills=")) {
      addExplicitSkills(options, arg.slice("--skills=".length));
    } else if (arg === "--scope") {
      options.scope = args[++index] || "";
    } else if (arg.startsWith("--scope=")) {
      options.scope = arg.slice("--scope=".length);
    } else if (arg === "--query") {
      options.query = args[++index] || "";
    } else if (arg.startsWith("--query=")) {
      options.query = arg.slice("--query=".length);
    } else if (arg === "--format") {
      options.format = args[++index] || "";
    } else if (arg.startsWith("--format=")) {
      options.format = arg.slice("--format=".length);
    } else {
      options.requestArgs.push(arg);
    }
  }

  if (!["all", "local", "global"].includes(options.scope)) {
    options.error = "Invalid --scope. Use all, local, or global.";
  }
  if (!["text", "json"].includes(options.format)) {
    options.error = "Invalid --format. Use text or json.";
  }
  if (options.checkPath === "") {
    options.error = "Missing --check value. Use a plan file path or - for stdin.";
  }
  if (options.outputPath === "") {
    // Keep empty string as the disabled state unless --output consumed a missing value.
    const hasOutputFlag = args.some((arg) => arg === "--output" || arg.startsWith("--output="));
    if (hasOutputFlag) {
      options.error = "Missing --output value.";
    }
  }
  if (options.timeout === null || options.maxFiles === null) {
    options.error = "Numeric options must be positive integers.";
  }

  return options;
}

function parsePositiveIntegerOption(value, optionName) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function addExplicitSkills(options, rawValue) {
  for (const value of rawValue.split(",")) {
    const skill = value.trim();
    if (skill) {
      options.explicitSkills.push(skill);
    }
  }
}

function printRecommendedSkills({ cwd, home, scope, text }) {
  const allSkills = discoverSkills({ cwd, home, scope, query: "" });
  const candidates = selectSkillCandidates(allSkills, text, 5);
  console.log(`Recommended Claude skills (${candidates.length})`);
  if (candidates.length === 0) {
    console.log(`No matching skills found for: ${text}`);
    console.log("Try `claude:plan --list-skills --query <keyword>`.");
    return;
  }

  for (const skill of candidates) {
    const description = formatSkillDescriptionForText(skill.description);
    console.log(`- ${skill.id} [${skill.scope}]${description}`);
  }

  console.log("");
  console.log("Usage examples:");
  console.log(`claude:plan --skill ${candidates[0].id} ${text}`);
  if (candidates.length > 1) {
    const ids = candidates.slice(0, 3).map((skill) => skill.id).join(",");
    console.log(`claude:plan --skills ${ids} ${text}`);
  }
}

function handlePlanCheck(checkPath) {
  const planText = readPlanCheckInput(checkPath);
  if (planText.error) {
    printError(planText.error);
    return EXIT_USAGE;
  }

  const report = checkPlanText(planText.content, process.cwd());
  printPlanCheckReport(report);
  return report.errors.length > 0 ? EXIT_PLAN_FAILED : 0;
}

function readPlanCheckInput(checkPath) {
  if (checkPath === "-") {
    try {
      return { content: fs.readFileSync(0, "utf8") };
    } catch (error) {
      return { error: `Failed to read plan from stdin: ${error.message}` };
    }
  }

  const absolutePath = path.resolve(process.cwd(), checkPath);
  try {
    return { content: fs.readFileSync(absolutePath, "utf8") };
  } catch (error) {
    return { error: `Failed to read plan file: ${error.message}` };
  }
}

function readPlanRequest(args) {
  const argText = args.join(" ").trim();
  if (argText) {
    return argText;
  }

  if (process.stdin.isTTY) {
    return "";
  }

  try {
    return fs.readFileSync(0, "utf8").trim();
  } catch {
    return "";
  }
}

function buildPlanPrompt({ template, request, workspace, skillContext = "" }) {
  return `${template.trim()}

${skillContext ? `${skillContext.trim()}${os.EOL}${os.EOL}` : ""}User request:

${request}

Workspace context gathered by Codex without reading secret values:

Current directory:
${workspace.cwd}

Git status:
${workspace.gitStatus || "(git status unavailable or empty)"}

Visible files:
${workspace.files || "(no files found)"}
`;
}

function buildClaudePlanArgs(prompt, options) {
  const args = [
    "-p",
    prompt,
    "--output-format",
    "text",
    "--no-session-persistence",
    "--tools",
    "Read,Glob,Grep,LS"
  ];
  if (options.model) {
    args.push("--model", options.model);
  }
  return args;
}

function formatSavedPlan({ request, output, explicitSkills }) {
  const skills = explicitSkills.length > 0 ? explicitSkills.join(", ") : "(none)";
  return `<!-- Generated by claude:plan -->

Generated: ${new Date().toISOString()}
Request: ${request}
Skills: ${skills}

---

${output.trimEnd()}
`;
}

function printPlanDryRun(prompt, options = {}) {
  const previewArgs = buildClaudePlanArgs(prompt, options)
    .map((arg) => (arg === prompt ? "<prompt>" : arg))
    .join(" ");
  console.log(`Claude plan dry run

No Claude CLI call was made.

Command preview:
claude ${previewArgs}

Prompt:
${prompt}`);
}

function buildSkillContext({ request, showSkills, explicitSkills, scope, query }) {
  const sections = [
    "Claude skill policy:",
    "- You may select relevant enabled Claude Code skills when they improve the plan.",
    "- Do not use skills to edit files, commit, or run destructive commands."
  ];

  const required = uniqueValues(explicitSkills).map(formatSkillInvocation);
  if (required.length > 0) {
    sections.push("", "Required Claude skills:");
    for (const skill of required) {
      sections.push(`- ${skill}`);
    }
    sections.push(
      "Use the required skills before writing the plan if they are available. If a required skill is unavailable, mention that in Risks and continue with the best available plan."
    );
  }

  if (showSkills) {
    const allSkills = discoverSkills({
      cwd: process.cwd(),
      home: getHomeDirectory(),
      scope,
      query: ""
    });
    const candidates = selectSkillCandidates(allSkills, query || request, 20);
    sections.push("", "Available Claude skills:");
    if (candidates.length === 0) {
      sections.push("- No matching skills were found.");
    } else {
      for (const skill of candidates) {
        sections.push(formatSkillForPrompt(skill));
      }
    }
  }

  return sections.join(os.EOL);
}

function formatSkillInvocation(skill) {
  const trimmed = skill.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

function formatSkillForPrompt(skill) {
  const description = skill.description ? ` - ${skill.description}` : "";
  return `- ${skill.id} [${skill.scope}]${description}`;
}

function printSkills(skills, format) {
  if (format === "json") {
    console.log(JSON.stringify(skills, null, 2));
    return;
  }

  if (skills.length === 0) {
    console.log("No Claude skills found.");
    return;
  }

  console.log(`Claude skills (${skills.length})`);
  for (const skill of skills) {
    const description = formatSkillDescriptionForText(skill.description);
    console.log(`- ${skill.id} [${skill.scope}]${description}`);
  }
}

function formatSkillDescriptionForText(description) {
  const normalized = String(description || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= SKILL_DESCRIPTION_PREVIEW_LENGTH) {
    return ` - ${normalized}`;
  }
  return ` - ${normalized.slice(0, SKILL_DESCRIPTION_PREVIEW_LENGTH - 3).trimEnd()}...`;
}

function discoverSkills({ cwd, home, scope = "all", query = "" }) {
  const entries = [];
  if (scope === "all" || scope === "local") {
    entries.push(...discoverLocalSkills(cwd));
  }
  if (scope === "all" || scope === "global") {
    entries.push(...discoverGlobalSkills(home));
  }

  const deduped = dedupeSkills(entries);
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return deduped;
  }

  return deduped.filter((skill) => skillMatchesQuery(skill, normalizedQuery));
}

function discoverLocalSkills(cwd) {
  return [
    ...readSkillTree(path.join(cwd, "skills"), "local", null),
    ...readSkillTree(path.join(cwd, ".claude/skills"), "local", null),
    ...readPluginSkillTrees(path.join(cwd, ".claude/plugins"), "local")
  ];
}

function discoverGlobalSkills(home) {
  const claudeRoot = path.join(home, ".claude");
  return [
    ...readSkillTree(path.join(claudeRoot, "skills"), "global", null),
    ...readPluginSkillTrees(path.join(claudeRoot, "plugins/cache"), "global"),
    ...readSkillTree(path.join(home, ".agents/skills"), "global", null)
  ];
}

function readPluginSkillTrees(root, scope) {
  const pluginRoots = findFiles(root, ".claude-plugin/plugin.json", 7).map((file) =>
    path.dirname(path.dirname(file))
  );
  const entries = [];
  for (const pluginRoot of pluginRoots) {
    const pluginName = readPluginName(pluginRoot);
    entries.push(...readSkillTree(path.join(pluginRoot, "skills"), scope, pluginName));
  }
  return entries;
}

function readSkillTree(root, scope, pluginName) {
  return findFiles(root, "SKILL.md", 8)
    .map((filePath) => readSkillFile(filePath, scope, pluginName))
    .filter(Boolean);
}

function readSkillFile(filePath, scope, pluginName) {
  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  const frontmatter = parseFrontmatter(content);
  const fallbackName = path.basename(path.dirname(filePath));
  const name = frontmatter.name || fallbackName;
  const id = pluginName ? `${pluginName}:${name}` : name;
  return {
    id,
    name,
    description: frontmatter.description || "",
    scope,
    path: filePath
  };
}

function parseFrontmatter(content) {
  if (!content.startsWith("---")) {
    return {};
  }

  const end = content.indexOf("\n---", 3);
  if (end === -1) {
    return {};
  }

  const result = {};
  const body = content.slice(3, end).trim();
  const lines = body.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      continue;
    }
    if (match[2].trim() === "|" || match[2].trim() === ">") {
      const blockLines = [];
      while (index + 1 < lines.length && /^\s+/.test(lines[index + 1])) {
        index += 1;
        blockLines.push(lines[index].trim());
      }
      result[match[1]] = blockLines.filter(Boolean).join(" ");
    } else {
      result[match[1]] = stripYamlScalar(match[2]);
    }
  }
  return result;
}

function stripYamlScalar(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readPluginName(pluginRoot) {
  const manifestPath = path.join(pluginRoot, ".claude-plugin/plugin.json");
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (typeof manifest.name === "string" && manifest.name.trim()) {
      return manifest.name.trim();
    }
  } catch {
    // Fall back to the plugin directory name.
  }
  return path.basename(pluginRoot);
}

function findFiles(root, targetName, maxDepth) {
  const output = [];
  walkForTarget(root, targetName, maxDepth, 0, output);
  return output.sort();
}

function walkForTarget(current, targetName, maxDepth, depth, output) {
  if (depth > maxDepth) {
    return;
  }

  let entries = [];
  try {
    entries = fs.readdirSync(current, { withFileTypes: true });
  } catch {
    return;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const absolutePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (isIgnoredSkillDiscoveryPath(entry.name)) {
        continue;
      }
      walkForTarget(absolutePath, targetName, maxDepth, depth + 1, output);
    } else if (entry.isFile() && matchesTargetName(absolutePath, targetName)) {
      output.push(absolutePath);
    }
  }
}

function matchesTargetName(filePath, targetName) {
  if (targetName.includes("/")) {
    return filePath.endsWith(targetName);
  }
  return path.basename(filePath) === targetName;
}

function isIgnoredSkillDiscoveryPath(name) {
  return [".git", "node_modules", "dist", "build", "coverage", ".cache"].includes(name);
}

function dedupeSkills(skills) {
  const byId = new Map();
  for (const skill of skills) {
    const existing = byId.get(skill.id);
    if (!existing || (existing.scope !== "local" && skill.scope === "local")) {
      byId.set(skill.id, skill);
    }
  }
  return [...byId.values()];
}

function skillMatchesQuery(skill, query) {
  const searchable = [skill.id, skill.name, skill.description, skill.path]
    .join("\n")
    .toLowerCase();
  return searchable.includes(query);
}

function selectSkillCandidates(skills, text, limit) {
  const terms = extractSkillSearchTerms(text);

  if (terms.length === 0) {
    return skills.slice(0, limit);
  }

  const scored = skills
    .map((skill, index) => ({
      skill,
      index,
      score: scoreSkill(skill, terms)
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  return scored.slice(0, limit).map((entry) => entry.skill);
}

function scoreSkill(skill, terms) {
  const id = skill.id.toLowerCase();
  const name = skill.name.toLowerCase();
  const description = skill.description.toLowerCase();
  const filePath = skill.path.toLowerCase();
  const text = [id, name, description, filePath].join("\n");
  const baseScore = terms.reduce((score, term) => {
    if (!text.includes(term)) {
      return score;
    }
    let nextScore = score + 1;
    if (id.includes(term)) {
      nextScore += 8;
    }
    if (name.includes(term)) {
      nextScore += 6;
    }
    if (description.includes(term)) {
      nextScore += 3;
    }
    return nextScore;
  }, 0);

  if (baseScore === 0) {
    return 0;
  }

  let finalScore = baseScore - supportSkillPenalty(skill, terms);
  if (terms.includes("__planning_creation")) {
    if (/writing-plans|writing-plan|plan-.*review|planning/.test(id)) {
      finalScore += 25;
    }
    if (/executing-plans|execute|execution/.test(id)) {
      finalScore -= 25;
    }
  }
  return finalScore;
}

function extractSkillSearchTerms(text) {
  const normalized = text.toLowerCase();
  const terms = normalized
    .split(/[^a-z0-9가-힣_-]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3);

  if (/\bplan\b|계획|기획|짤때|짜기|작성/.test(normalized)) {
    terms.push("planning", "plans", "implementation");
  }
  if (/\bplan\b|계획|기획|짤때|짜기|작성/.test(normalized)) {
    terms.push("__planning_creation");
  }

  return uniqueValues(terms);
}

function supportSkillPenalty(skill, terms) {
  if (!["doctor", "setup", "skills"].includes(skill.id)) {
    return 0;
  }

  const supportIntentTerms = ["doctor", "setup", "skills", "diagnose", "diagnostic", "list"];
  const isSupportIntent = terms.some((term) => supportIntentTerms.includes(term));
  return isSupportIntent ? 0 : 40;
}

function checkPlanText(planText, cwd) {
  const errors = [];
  const warnings = [];
  const missingSections = REQUIRED_PLAN_SECTIONS.filter(
    (section) => !new RegExp(`^${escapeRegExp(section)}\\s*$`, "im").test(planText)
  );
  if (missingSections.length > 0) {
    errors.push(`Missing required sections: ${missingSections.join(", ")}`);
  }

  for (const command of DESTRUCTIVE_COMMAND_PATTERNS) {
    if (command.pattern.test(planText)) {
      errors.push(`Destructive command detected: ${command.label}`);
    }
  }

  for (const script of findMentionedNpmScripts(planText)) {
    if (!npmScriptExists(cwd, script)) {
      errors.push(`Unknown npm script: ${script}`);
    }
  }

  for (const referencedPath of findReferencedPaths(planText)) {
    if (!fs.existsSync(path.resolve(cwd, referencedPath))) {
      errors.push(`Referenced path does not exist: ${referencedPath}`);
    }
  }

  if (!/Implementation Checklist/im.test(planText)) {
    warnings.push("Implementation Checklist section is recommended for Codex handoff.");
  }

  return { errors: uniqueValues(errors), warnings: uniqueValues(warnings) };
}

function printPlanCheckReport(report) {
  console.log("Claude plan check");
  console.log("");
  if (report.errors.length === 0 && report.warnings.length === 0) {
    console.log("Result: ok");
    return;
  }

  console.log(`Result: ${report.errors.length > 0 ? "failed" : "ok with warnings"}`);
  if (report.errors.length > 0) {
    console.log("");
    console.log("Errors:");
    for (const error of report.errors) {
      console.log(`- ${error}`);
    }
  }
  if (report.warnings.length > 0) {
    console.log("");
    console.log("Warnings:");
    for (const warning of report.warnings) {
      console.log(`- ${warning}`);
    }
  }
}

function findMentionedNpmScripts(text) {
  const scripts = [];
  const pattern = /\bnpm\s+run\s+([A-Za-z0-9:_-]+)/g;
  let match = pattern.exec(text);
  while (match) {
    scripts.push(match[1]);
    match = pattern.exec(text);
  }
  return uniqueValues(scripts);
}

function npmScriptExists(cwd, scriptName) {
  const packageJsonPath = path.join(cwd, "package.json");
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    return Boolean(packageJson.scripts && Object.hasOwn(packageJson.scripts, scriptName));
  } catch {
    return false;
  }
}

function findReferencedPaths(text) {
  const paths = [];
  const codePattern = /`([^`\n]+)`/g;
  let match = codePattern.exec(text);
  while (match) {
    const candidate = match[1].trim();
    if (isLikelyRepoPath(candidate)) {
      paths.push(stripPathPunctuation(candidate));
    }
    match = codePattern.exec(text);
  }
  return uniqueValues(paths);
}

function isLikelyRepoPath(candidate) {
  if (!candidate || candidate.includes("*") || candidate.startsWith("http")) {
    return false;
  }
  if (/^(npm|node|git|claude|codex)\b/.test(candidate)) {
    return false;
  }
  return candidate.includes("/") || /\.[A-Za-z0-9]+$/.test(candidate);
}

function stripPathPunctuation(candidate) {
  return candidate.replace(/[.,;:]+$/g, "");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getHomeDirectory() {
  return process.env.HOME || os.homedir();
}

function checkNodeRuntime() {
  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  return {
    ok: Number.isFinite(major) && major >= 20,
    detail: process.version
  };
}

function checkClaudeCli() {
  const result = runCommand("claude", ["--version"], {
    cwd: process.cwd(),
    maxBuffer: 1024 * 1024
  });

  if (result.error?.code === "ENOENT") {
    return { available: false, detail: "not found on PATH" };
  }

  if (result.error) {
    return { available: false, detail: result.error.message };
  }

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
    return { available: false, detail: redactSecrets(detail) };
  }

  return {
    available: true,
    detail: redactSecrets((result.stdout || result.stderr || "ok").trim())
  };
}

function checkClaudePromptSmoke() {
  const timeout = Math.min(getPlanTimeoutMs(), 30_000);
  const result = runCommand(
    "claude",
    [
      "-p",
      "Reply with exactly OK if this read-only planning smoke test can run.",
      "--output-format",
      "text",
      "--no-session-persistence",
      "--tools",
      "Read,Glob,Grep,LS"
    ],
    {
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024,
      timeout
    }
  );

  if (result.error || result.status !== 0) {
    return {
      ok: false,
      skipped: false,
      detail: summarizeFailureDetail(result),
      failure: { result, timeout }
    };
  }

  const output = redactSecrets(result.stdout.trim() || result.stderr.trim());
  return {
    ok: Boolean(output),
    skipped: false,
    detail: output || "empty output",
    failure: output ? null : { result, timeout }
  };
}

function checkClaudeAuth() {
  const result = runCommand("claude", ["auth", "status"], {
    cwd: process.cwd(),
    maxBuffer: 1024 * 1024
  });

  const detail = redactSecrets((result.stderr || result.stdout || "").trim());

  if (result.error) {
    return { ok: false, label: "error", detail: result.error.message };
  }

  if (result.status === 0) {
    return { ok: true, label: "authenticated", detail: summarizeAuthStatus(detail) };
  }

  return {
    ok: false,
    label: "not authenticated",
    detail: detail || `exit ${result.status}`
  };
}

function summarizeAuthStatus(text) {
  if (!text) {
    return "";
  }

  try {
    const parsed = JSON.parse(text);
    const keys = Object.keys(parsed).filter((key) => !/token|secret|key|cookie/i.test(key));
    if (keys.length === 0) {
      return "JSON status received";
    }
    return `JSON status keys: ${keys.join(", ")}`;
  } catch {
    return text.split(/\r?\n/)[0];
  }
}

function getPlanTimeoutMs() {
  const raw = process.env.CLAUDE_PLUGIN_PLAN_TIMEOUT_MS;
  if (!raw) {
    return DEFAULT_PLAN_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_PLAN_TIMEOUT_MS;
  }
  return parsed;
}

function formatClaudeFailure(failure, { action, timeout }) {
  if (failure.error?.code === "ETIMEDOUT") {
    return `Claude ${action} timed out after ${timeout}ms.
Try a narrower request, check Claude CLI responsiveness, then rerun the command.`;
  }

  const combined = summarizeFailureDetail(failure);
  if (isClaudeAuthFailure(combined)) {
    return `Claude authentication failed while planning.
Run \`claude auth login\`, then rerun \`claude:doctor\`.
${combined}`;
  }

  if (isClaudeUsageCreditsFailure(combined)) {
    return `Claude usage credits are required for this plan request.
Turn on usage credits at https://claude.ai/settings/usage or configure Claude CLI to use a standard context model, then rerun \`claude:doctor\`.
${combined}`;
  }

  return `Claude ${action} failed with exit ${failure.status}.${combined ? `${os.EOL}${combined}` : ""}`;
}

function formatClaudeFailureAdvice(failure, context) {
  if (!failure) {
    return `Claude ${context} failed. Rerun \`claude:doctor\` for details.`;
  }
  return formatClaudeFailure(failure.result, {
    action: context,
    timeout: failure.timeout || DEFAULT_PLAN_TIMEOUT_MS
  });
}

function summarizeFailureDetail(result) {
  if (!result) {
    return "";
  }
  if (result.error?.message) {
    return redactSecrets(result.error.message);
  }
  return redactSecrets([result.stderr, result.stdout].filter(Boolean).join(os.EOL).trim());
}

function isClaudeAuthFailure(text) {
  return /401|invalid authentication credentials|not authenticated|auth/i.test(text || "");
}

function isClaudeUsageCreditsFailure(text) {
  return /usage credits required|1m context/i.test(text || "");
}

function checkProject(cwd) {
  const git = runCommand("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    maxBuffer: 1024 * 1024
  });

  if (!git.error && git.status === 0 && git.stdout.trim() === "true") {
    return { ok: true, detail: cwd };
  }

  const markers = ["package.json", "AGENTS.md", ".codex-plugin/plugin.json"];
  const found = markers.find((marker) => fs.existsSync(path.join(cwd, marker)));
  if (found) {
    return { ok: true, detail: `${cwd} (${found})` };
  }

  return { ok: false, detail: cwd };
}

function checkRequiredFiles() {
  return REQUIRED_FILES.map((relativePath) => ({
    path: relativePath,
    exists: fs.existsSync(path.join(PLUGIN_ROOT, relativePath))
  }));
}

function collectWorkspaceContext(cwd, maxFiles = DEFAULT_CONTEXT_FILE_LIMIT) {
  return {
    cwd,
    gitStatus: getGitStatus(cwd),
    files: getVisibleFiles(cwd, maxFiles).join(os.EOL)
  };
}

function getGitStatus(cwd) {
  const result = runCommand("git", ["status", "--short", "--untracked-files=all"], {
    cwd,
    maxBuffer: 1024 * 1024
  });

  if (result.error || result.status !== 0) {
    return "";
  }

  return redactSecrets(result.stdout.trim());
}

function getVisibleFiles(cwd, maxFiles = DEFAULT_CONTEXT_FILE_LIMIT) {
  const gitFiles = runCommand(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd, maxBuffer: 1024 * 1024 }
  );

  if (!gitFiles.error && gitFiles.status === 0) {
    const files = gitFiles.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((file) => !isIgnoredContextPath(file))
      .sort();

    if (files.length > 0) {
      return files.slice(0, maxFiles);
    }
  }

  return walkFiles(cwd, cwd, maxFiles);
}

function walkFiles(root, current, limit, output = []) {
  if (output.length >= limit) {
    return output;
  }

  let entries = [];
  try {
    entries = fs.readdirSync(current, { withFileTypes: true });
  } catch {
    return output;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (output.length >= limit) {
      break;
    }

    const absolutePath = path.join(current, entry.name);
    const relativePath = path.relative(root, absolutePath);
    if (!relativePath || isIgnoredContextPath(relativePath)) {
      continue;
    }

    if (entry.isDirectory()) {
      walkFiles(root, absolutePath, limit, output);
    } else if (entry.isFile()) {
      output.push(relativePath);
    }
  }

  return output;
}

function isIgnoredContextPath(relativePath) {
  const normalized = relativePath.split(path.sep).join("/");
  return /(^|\/)(\.git|node_modules|dist|build|coverage|\.cache|target)(\/|$)/.test(
    normalized
  );
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
    stdio: "pipe",
    timeout: options.timeout,
    windowsHide: true
  });

  return {
    status: result.status ?? 0,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error || null
  };
}

function redactSecrets(text) {
  if (!text) {
    return "";
  }

  let redacted = text.replace(SENSITIVE_ASSIGNMENT_PATTERN, "$1=[REDACTED]");
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, (match, prefix) => {
      if (typeof prefix === "string" && /^Bearer\s+/i.test(prefix)) {
        return `${prefix}[REDACTED]`;
      }
      return "[REDACTED]";
    });
  }
  return redacted;
}

function printError(message) {
  console.error(redactSecrets(message));
}

main();
