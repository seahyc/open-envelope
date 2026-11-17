export interface AccountRow {
  id: string;
  name: string;
  aliases: string;
}

export function parseAliases(aliasesJson: string): string[] {
  try {
    const parsed = JSON.parse(aliasesJson) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((value) => String(value));
  } catch {
    return [];
  }
}

export function findAccountIdByExactAlias(accounts: AccountRow[], hint: string): string | null {
  if (!hint) return null;

  for (const account of accounts) {
    const aliases = parseAliases(account.aliases);
    if (aliases.includes(hint) || account.name === hint) {
      return account.id;
    }
  }

  return null;
}

export function normalizeAccountHint(hint: string): string {
  return hint.replace(/[\s-]/g, '').toLowerCase();
}

export function accountHintsMatch(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  return normalizeAccountHint(left) === normalizeAccountHint(right);
}

export function findAccountIdByAlias(accounts: AccountRow[], hint: string): string | null {
  const exact = findAccountIdByExactAlias(accounts, hint);
  if (exact) return exact;
  if (!hint) return null;

  for (const account of accounts) {
    const aliases = parseAliases(account.aliases);
    if (accountHintsMatch(account.name, hint) || aliases.some((alias) => accountHintsMatch(alias, hint))) {
      return account.id;
    }
  }

  return null;
}

export interface AccountMappingLike {
  folderPattern?: string;
  accountHint?: string;
  accountAlias: string;
  accountId?: string;
}

export function resolveAccountId(options: {
  hint: string;
  accounts: AccountRow[];
  filename?: string;
  mappings?: AccountMappingLike[];
}): string | null {
  const { hint, accounts, filename, mappings = [] } = options;

  const mappingHit = mappings.find(
    (mapping) => mapping.accountId && (mapping.accountHint === hint || mapping.accountAlias === hint)
  );
  if (mappingHit?.accountId) {
    return mappingHit.accountId;
  }

  const byAlias = findAccountIdByAlias(accounts, hint);
  if (byAlias) {
    return byAlias;
  }

  if (filename) {
    const folderHit = mappings.find(
      (mapping) => mapping.accountId && mapping.folderPattern && filenameMatchesFolderPattern(filename, mapping.folderPattern)
    );
    if (folderHit?.accountId) {
      return folderHit.accountId;
    }
  }

  return null;
}

export function filenameMatchesFolderPattern(filename: string, folderPattern: string): boolean {
  if (!filename || !folderPattern) return false;
  const parts = filename.replace(/\\/g, '/').split('/');
  return parts.includes(folderPattern);
}
