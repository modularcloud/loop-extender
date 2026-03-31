export interface ParseEnvResult {
  vars: Record<string, string>;
  warnings: string[];
}

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parse a .env file content into key-value pairs.
 *
 * Rules (Spec 8.1):
 * - One KEY=VALUE per line; split on first =.
 * - No whitespace around = (key extends to first =).
 * - Lines starting with # are comments; blank lines ignored.
 * - Duplicate keys: last wins.
 * - Values optionally wrapped in matched double/single quotes (stripped).
 * - Unmatched quotes: treated literally.
 * - No escape sequence interpretation.
 * - Trailing whitespace trimmed from unquoted values.
 * - Key validation: [A-Za-z_][A-Za-z0-9_]*; invalid keys -> warning.
 * - Lines without = or with invalid keys -> warning.
 */
export function parseEnvFile(content: string): ParseEnvResult {
  const vars: Record<string, string> = {};
  const warnings: string[] = [];

  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Blank lines ignored
    if (line.trim() === "") continue;

    // Lines starting with # are comments
    if (line.startsWith("#")) continue;

    // Must contain =
    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) {
      warnings.push(`Line ${i + 1}: missing '=' separator: ${line}`);
      continue;
    }

    const key = line.substring(0, eqIndex);
    let value = line.substring(eqIndex + 1);

    // Key validation
    if (!KEY_PATTERN.test(key)) {
      warnings.push(`Line ${i + 1}: invalid key name: ${key}`);
      continue;
    }

    // Trim trailing whitespace from value
    value = value.replace(/\s+$/, "");

    // Quote stripping: matched pairs only
    if (value.length >= 2) {
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
    }

    vars[key] = value;
  }

  return { vars, warnings };
}
