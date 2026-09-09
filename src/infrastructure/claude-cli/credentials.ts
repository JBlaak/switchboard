/**
 * Reading the OAuth token Claude Code stores.
 *
 * On macOS it is in the Keychain, with a file as the fallback; everywhere else
 * only the file exists. The Keychain service name is derived the same way the
 * CLI derives it, including the hash suffix it adds when CLAUDE_CONFIG_DIR is
 * set — otherwise a user with a custom config directory has a token we cannot
 * find.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The OAuth blob, as far as we read it. */
export interface ClaudeOAuth {
  accessToken?: string;
  [key: string]: unknown;
}

interface CredentialsFile {
  claudeAiOauth?: ClaudeOAuth;
}

/** The CLI's own config directory, which it lets the user move. */
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function keychainServiceName(): string {
  const suffix = '-credentials';
  if (!process.env.CLAUDE_CONFIG_DIR) return `Claude Code${suffix}`;
  const hash = crypto.createHash('sha256').update(claudeConfigDir()).digest('hex').substring(0, 8);
  return `Claude Code${suffix}-${hash}`;
}

function readFromKeychain(): CredentialsFile | null {
  if (process.platform !== 'darwin') return null;
  try {
    const user = process.env.USER || os.userInfo().username;
    // execFileSync, not a shell: $USER must not be interpolated into a command.
    const json = execFileSync(
      'security',
      ['find-generic-password', '-a', user, '-w', '-s', keychainServiceName()],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return JSON.parse(json) as CredentialsFile;
  } catch {
    // Not signed in through the Keychain, or the user denied access.
    return null;
  }
}

function readFromFile(): CredentialsFile | null {
  try {
    const credPath = path.join(claudeConfigDir(), '.credentials.json');
    return JSON.parse(fs.readFileSync(credPath, 'utf8')) as CredentialsFile;
  } catch {
    return null;
  }
}

export function readOAuthToken(): ClaudeOAuth | null {
  return (readFromKeychain() || readFromFile())?.claudeAiOauth ?? null;
}
