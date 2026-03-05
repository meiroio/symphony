import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type Args = {
  filePath: string;
};

const TEMPLATE_PATH_CANDIDATES = [
  ".github/pull_request_template.md",
  "../.github/pull_request_template.md",
];

function parseArgs(argv: string[]): Args {
  let filePath = "";

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }

    if (token === "--help" || token === "-h") {
      printHelp();
      process.exit(0);
    }

    if (token === "--file") {
      filePath = argv[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (token.startsWith("--file=")) {
      filePath = token.slice("--file=".length);
      continue;
    }

    throw new Error(`Invalid option: ${token}`);
  }

  if (!filePath) {
    throw new Error("Missing required option --file");
  }

  return { filePath };
}

function printHelp(): void {
  console.log(
    [
      "Validate PR description markdown against .github/pull_request_template.md.",
      "",
      "Usage:",
      "  bun run scripts/check-pr-body.ts --file /path/to/pr_body.md",
    ].join("\n"),
  );
}

function readTemplate(): { path: string; content: string } {
  for (const candidate of TEMPLATE_PATH_CANDIDATES) {
    const absolutePath = resolve(process.cwd(), candidate);
    if (!existsSync(absolutePath)) {
      continue;
    }

    return { path: absolutePath, content: readFileSync(absolutePath, "utf8") };
  }

  throw new Error(
    `Unable to read PR template from any of: ${TEMPLATE_PATH_CANDIDATES.join(", ")}`,
  );
}

function extractTemplateHeadings(templateContent: string): string[] {
  return Array.from(templateContent.matchAll(/^#{4,6}\s+.+$/gm), (match) => match[0]);
}

function headingPosition(content: string, heading: string): number {
  return content.indexOf(heading);
}

function captureHeadingSection(
  content: string,
  heading: string,
  headings: string[],
): string | null {
  const headingIndex = content.indexOf(heading);
  if (headingIndex === -1) {
    return null;
  }

  const sectionStart = headingIndex + heading.length;
  if (sectionStart + 2 > content.length) {
    return "";
  }

  if (content.slice(sectionStart, sectionStart + 2) !== "\n\n") {
    return null;
  }

  const sectionContent = content.slice(sectionStart + 2);
  const nextHeadingIndexes = headings
    .filter((templateHeading) => templateHeading !== heading)
    .map((templateHeading) => sectionContent.indexOf(`\n${templateHeading}`))
    .filter((index) => index !== -1);

  if (nextHeadingIndexes.length === 0) {
    return sectionContent;
  }

  return sectionContent.slice(0, Math.min(...nextHeadingIndexes));
}

function lintBody(templateContent: string, bodyContent: string, headings: string[]): string[] {
  const errors: string[] = [];

  const missingHeadings = headings.filter((heading) => headingPosition(bodyContent, heading) === -1);
  for (const heading of missingHeadings) {
    errors.push(`Missing required heading: ${heading}`);
  }

  const positions = headings
    .map((heading) => headingPosition(bodyContent, heading))
    .filter((position) => position !== -1);
  const sortedPositions = [...positions].sort((first, second) => first - second);
  const orderIsValid = positions.every((position, index) => position === sortedPositions[index]);
  if (!orderIsValid) {
    errors.push("Required headings are out of order.");
  }

  if (bodyContent.includes("<!--")) {
    errors.push("PR description still contains template placeholder comments (<!-- ... -->).");
  }

  for (const heading of headings) {
    const templateSection = captureHeadingSection(templateContent, heading, headings) ?? "";
    const bodySection = captureHeadingSection(bodyContent, heading, headings);
    if (bodySection === null) {
      continue;
    }

    if (bodySection.trim() === "") {
      errors.push(`Section cannot be empty: ${heading}`);
      continue;
    }

    const requiresBullets = /^- /m.test(templateSection);
    if (requiresBullets && !/^- /m.test(bodySection)) {
      errors.push(`Section must include at least one bullet item: ${heading}`);
    }

    const requiresCheckboxes = /^- \[ \] /m.test(templateSection);
    if (requiresCheckboxes && !/^- \[[ xX]\] /m.test(bodySection)) {
      errors.push(`Section must include at least one checkbox item: ${heading}`);
    }
  }

  return errors;
}

function run(): void {
  const { filePath } = parseArgs(Bun.argv.slice(2));
  const { path: templatePath, content: templateContent } = readTemplate();
  const bodyContent = readFileSync(filePath, "utf8");
  const headings = extractTemplateHeadings(templateContent);

  if (headings.length === 0) {
    throw new Error(`No markdown headings found in ${templatePath}`);
  }

  const errors = lintBody(templateContent, bodyContent, headings);
  if (errors.length > 0) {
    for (const errorMessage of errors) {
      console.error(`ERROR: ${errorMessage}`);
    }
    throw new Error(`PR body format invalid. Read \`${templatePath}\` and follow it precisely.`);
  }

  console.log("PR body format OK");
}

try {
  run();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
