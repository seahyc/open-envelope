import { describe, it, expect } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'child_process';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
  rmSync,
  readdirSync,
  symlinkSync,
  linkSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';

function hasCommand(name: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf-8' }).status === 0;
}

const hasBackupTools = hasCommand('age') && hasCommand('zstd') && hasCommand('sqlite3') && hasCommand('age-keygen');
const backupScript = join(process.cwd(), 'scripts/backup.sh');
const restoreScript = join(process.cwd(), 'scripts/restore.sh');

if (process.env.CI && !hasBackupTools) {
  throw new Error('Backup tests require age, zstd, sqlite3, and age-keygen in CI; they must not skip');
}

function makeWork(): string {
  return mkdtempSync(join(tmpdir(), 'oe-backup-'));
}

function makeAgeKey(work: string): { keyFile: string; publicKey: string } {
  const keyFile = join(work, 'age-key.txt');
  const keygen = execFileSync('age-keygen', ['-o', keyFile], { encoding: 'utf-8' });
  const pubMatch = `${keygen}\n${readFileSync(keyFile, 'utf-8')}`.match(/age1[a-z0-9]+/);
  if (!pubMatch) {
    throw new Error('age-keygen did not print a public key');
  }
  return { keyFile, publicKey: pubMatch[0]! };
}

function sqliteExec(dbPath: string, sql: string): string {
  return execFileSync('sqlite3', [dbPath, sql], { encoding: 'utf-8' }).trim();
}

function encryptTree(work: string, publicKey: string, treeDir: string): string {
  const tarPath = join(work, 'crafted.tar');
  execFileSync('tar', ['-C', treeDir, '-cf', tarPath, '.']);
  execFileSync('zstd', ['-q', '-f', tarPath, '-o', `${tarPath}.zst`]);
  const encrypted = join(work, 'crafted.tar.zst.age');
  execFileSync('age', ['-r', publicKey, '-o', encrypted, `${tarPath}.zst`]);
  return encrypted;
}

function snapshotDbFiles(dbPath: string): { db: Buffer; wal: Buffer | null; shm: Buffer | null } {
  return {
    db: readFileSync(dbPath),
    wal: existsSync(`${dbPath}-wal`) ? readFileSync(`${dbPath}-wal`) : null,
    shm: existsSync(`${dbPath}-shm`) ? readFileSync(`${dbPath}-shm`) : null,
  };
}

function expectDbFilesUnchanged(dbPath: string, before: ReturnType<typeof snapshotDbFiles>): void {
  expect(readFileSync(dbPath).equals(before.db)).toBe(true);
  if (before.wal) {
    expect(existsSync(`${dbPath}-wal`)).toBe(true);
    expect(readFileSync(`${dbPath}-wal`).equals(before.wal)).toBe(true);
  } else {
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
  }
  if (before.shm) {
    expect(existsSync(`${dbPath}-shm`)).toBe(true);
    expect(readFileSync(`${dbPath}-shm`).equals(before.shm)).toBe(true);
  } else {
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
  }
}

const LOCK_PROBE_SQL =
  'PRAGMA busy_timeout=100; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; SELECT count(*) FROM sqlite_master; COMMIT;';

function spawnIdleWalHolder(dbPath: string) {
  // Same open path as the running app: initDatabase sets WAL and applies migrations,
  // then the connection sits idle. A bare new Database() + journal_mode=WAL does
  // not hold the locks the restore probe needs to detect.
  return spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
        import { initDatabase } from './src/server/db/database.ts';
        const db = initDatabase(process.env.HOLD_DB);
        process.stdout.write('READY\\n');
        setInterval(() => {}, 1 << 30);
      `,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, HOLD_DB: dbPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

async function waitForReady(child: ReturnType<typeof spawn>, timeoutMs = 8000): Promise<void> {
  let out = '';
  let err = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`holder did not become READY: stdout=${out} stderr=${err}`));
    }, timeoutMs);
    const onOut = (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes('READY')) {
        clearTimeout(timer);
        child.stdout?.off('data', onOut);
        resolve();
      }
    };
    child.stdout?.on('data', onOut);
    child.stderr?.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`holder exited ${code} before READY: stdout=${out} stderr=${err}`));
    });
  });
}

describe('backup.sh / restore.sh', () => {
  it('exits non-zero with a clear message when BACKUP_AGE_PUBLIC_KEY is missing', () => {
    const work = makeWork();
    try {
      const dbPath = join(work, 'app.db');
      writeFileSync(dbPath, 'not-a-real-db-but-file-exists');
      const result = spawnSync('sh', [backupScript], {
        env: {
          ...process.env,
          DATABASE_PATH: dbPath,
          BACKUP_DIR: join(work, 'backups'),
          OBJECT_STORAGE_LOCAL_PATH: join(work, 'documents'),
          BACKUP_AGE_PUBLIC_KEY: '',
        },
        encoding: 'utf-8',
      });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/BACKUP_AGE_PUBLIC_KEY is not set/i);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasBackupTools)('round-trips a temp database and documents directory', () => {
    const work = makeWork();
    try {
      const dbPath = join(work, 'openenvelope.db');
      const docsPath = join(work, 'documents');
      const backupDir = join(work, 'backups');
      mkdirSync(docsPath, { recursive: true });
      mkdirSync(join(docsPath, 'ab'), { recursive: true });
      writeFileSync(join(docsPath, 'ab', 'abcdef'), 'synthetic-document');
      sqliteExec(dbPath, "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items (name) VALUES ('fixture-row');");
      const { keyFile, publicKey } = makeAgeKey(work);

      const backup = spawnSync('sh', [backupScript], {
        env: {
          ...process.env,
          DATABASE_PATH: dbPath,
          OBJECT_STORAGE_LOCAL_PATH: docsPath,
          BACKUP_DIR: backupDir,
          BACKUP_AGE_PUBLIC_KEY: publicKey,
          BACKUP_RETENTION_DAYS: '7',
        },
        encoding: 'utf-8',
      });
      expect(backup.status, backup.stderr || backup.stdout).toBe(0);

      const archives = readdirSync(backupDir).filter((name) => name.endsWith('.tar.zst.age'));
      expect(archives).toHaveLength(1);

      const restoreDb = join(work, 'restored', 'openenvelope.db');
      const restoreDocs = join(work, 'restored', 'documents');
      mkdirSync(join(work, 'restored'), { recursive: true });

      const restore = spawnSync('sh', [restoreScript, join(backupDir, archives[0]!), keyFile], {
        env: {
          ...process.env,
          DATABASE_PATH: restoreDb,
          OBJECT_STORAGE_LOCAL_PATH: restoreDocs,
        },
        encoding: 'utf-8',
      });
      expect(restore.status, restore.stderr || restore.stdout).toBe(0);
      expect(existsSync(restoreDb)).toBe(true);

      expect(sqliteExec(restoreDb, 'SELECT name FROM items')).toBe('fixture-row');
      expect(readFileSync(join(restoreDocs, 'ab', 'abcdef'), 'utf-8')).toBe('synthetic-document');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasBackupTools)('rejects an archive that fails zstd -t', () => {
    const work = makeWork();
    try {
      const { keyFile, publicKey } = makeAgeKey(work);
      const plaintext = join(work, 'junk.txt');
      writeFileSync(plaintext, 'not-zstd-payload');
      const encrypted = join(work, 'junk.tar.zst.age');
      execFileSync('age', ['-r', publicKey, '-o', encrypted, plaintext]);

      const restore = spawnSync('sh', [restoreScript, encrypted, keyFile], {
        env: {
          ...process.env,
          DATABASE_PATH: join(work, 'out.db'),
        },
        encoding: 'utf-8',
      });
      expect(restore.status).not.toBe(0);
      expect(`${restore.stdout}\n${restore.stderr}`).toMatch(/zstd integrity check failed/i);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasBackupTools)('moves leftover WAL/SHM aside so they cannot replay onto the snapshot', () => {
    const work = makeWork();
    let live: Database.Database | undefined;
    try {
      const livePath = join(work, 'openenvelope.db');
      const docsPath = join(work, 'documents');
      const backupDir = join(work, 'backups');
      mkdirSync(docsPath, { recursive: true });
      writeFileSync(join(docsPath, 'keep.txt'), 'docs');

      live = new Database(livePath);
      live.pragma('journal_mode = WAL');
      live.pragma('wal_autocheckpoint = 0');
      live.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items (name) VALUES ('fixture-row');");

      const { keyFile, publicKey } = makeAgeKey(work);
      const backup = spawnSync('sh', [backupScript], {
        env: {
          ...process.env,
          DATABASE_PATH: livePath,
          OBJECT_STORAGE_LOCAL_PATH: docsPath,
          BACKUP_DIR: backupDir,
          BACKUP_AGE_PUBLIC_KEY: publicKey,
        },
        encoding: 'utf-8',
      });
      expect(backup.status, backup.stderr || backup.stdout).toBe(0);

      live.exec("CREATE TABLE old_live (name TEXT); INSERT INTO old_live VALUES ('leaked');");
      live.exec("UPDATE items SET name = 'stale-from-wal'");
      expect(existsSync(`${livePath}-wal`)).toBe(true);

      const dbBytes = readFileSync(livePath);
      const walBytes = readFileSync(`${livePath}-wal`);
      const shmBytes = existsSync(`${livePath}-shm`) ? readFileSync(`${livePath}-shm`) : null;
      live.close();
      live = undefined;

      writeFileSync(livePath, dbBytes);
      writeFileSync(`${livePath}-wal`, walBytes);
      if (shmBytes) {
        writeFileSync(`${livePath}-shm`, shmBytes);
      }

      const archives = readdirSync(backupDir).filter((name) => name.endsWith('.tar.zst.age'));
      const restore = spawnSync('sh', [restoreScript, join(backupDir, archives[0]!), keyFile], {
        env: {
          ...process.env,
          DATABASE_PATH: livePath,
          OBJECT_STORAGE_LOCAL_PATH: docsPath,
        },
        encoding: 'utf-8',
      });
      expect(restore.status, restore.stderr || restore.stdout).toBe(0);

      const tables = sqliteExec(livePath, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
      expect(tables).not.toMatch(/old_live/);
      expect(sqliteExec(livePath, 'SELECT name FROM items')).toBe('fixture-row');
    } finally {
      live?.close();
      rmSync(work, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasBackupTools)('aborts when the extracted snapshot fails PRAGMA integrity_check', () => {
    const work = makeWork();
    try {
      const tree = join(work, 'tree');
      mkdirSync(tree);
      const dbPath = join(tree, 'openenvelope.db');
      sqliteExec(dbPath, "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items (name) VALUES ('ok');");
      const buf = readFileSync(dbPath);
      const corrupted = Buffer.from(buf);
      const start = Math.min(200, corrupted.length - 1);
      for (let i = start; i < corrupted.length; i++) {
        corrupted[i] = 0;
      }
      writeFileSync(dbPath, corrupted);

      const { keyFile, publicKey } = makeAgeKey(work);
      const encrypted = encryptTree(work, publicKey, tree);
      const dest = join(work, 'live.db');
      writeFileSync(dest, 'live-bytes');

      const restore = spawnSync('sh', [restoreScript, encrypted, keyFile], {
        env: {
          ...process.env,
          DATABASE_PATH: dest,
        },
        encoding: 'utf-8',
      });
      expect(restore.status).not.toBe(0);
      expect(`${restore.stdout}\n${restore.stderr}`).toMatch(/integrity_check/i);
      expect(readFileSync(dest, 'utf-8')).toBe('live-bytes');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasBackupTools)('refuses to archive document directories that contain a symlink', () => {
    const work = makeWork();
    try {
      const dbPath = join(work, 'openenvelope.db');
      const docsPath = join(work, 'documents');
      mkdirSync(docsPath);
      sqliteExec(dbPath, 'CREATE TABLE items (id INTEGER PRIMARY KEY);');
      symlinkSync('/etc/passwd', join(docsPath, 'link'));
      const { publicKey } = makeAgeKey(work);

      const backup = spawnSync('sh', [backupScript], {
        env: {
          ...process.env,
          DATABASE_PATH: dbPath,
          OBJECT_STORAGE_LOCAL_PATH: docsPath,
          BACKUP_DIR: join(work, 'backups'),
          BACKUP_AGE_PUBLIC_KEY: publicKey,
        },
        encoding: 'utf-8',
      });
      expect(backup.status).not.toBe(0);
      expect(`${backup.stdout}\n${backup.stderr}`).toMatch(/symlink|hard link/i);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasBackupTools)('refuses to archive document directories that contain a hard link', () => {
    const work = makeWork();
    try {
      const dbPath = join(work, 'openenvelope.db');
      const docsPath = join(work, 'documents');
      mkdirSync(docsPath);
      sqliteExec(dbPath, 'CREATE TABLE items (id INTEGER PRIMARY KEY);');
      writeFileSync(join(docsPath, 'a.txt'), 'synthetic');
      linkSync(join(docsPath, 'a.txt'), join(docsPath, 'b.txt'));
      const { publicKey } = makeAgeKey(work);

      const backup = spawnSync('sh', [backupScript], {
        env: {
          ...process.env,
          DATABASE_PATH: dbPath,
          OBJECT_STORAGE_LOCAL_PATH: docsPath,
          BACKUP_DIR: join(work, 'backups'),
          BACKUP_AGE_PUBLIC_KEY: publicKey,
        },
        encoding: 'utf-8',
      });
      expect(backup.status).not.toBe(0);
      expect(`${backup.stdout}\n${backup.stderr}`).toMatch(/hard link/i);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasBackupTools)('refuses archives that contain a symlink member', () => {
    const work = makeWork();
    try {
      const tree = join(work, 'tree');
      mkdirSync(join(tree, 'documents'), { recursive: true });
      sqliteExec(join(tree, 'openenvelope.db'), 'CREATE TABLE items (id INTEGER PRIMARY KEY);');
      symlinkSync('/etc/passwd', join(tree, 'documents', 'link'));
      const { keyFile, publicKey } = makeAgeKey(work);
      const encrypted = encryptTree(work, publicKey, tree);
      const destDocs = join(work, 'live-docs');
      mkdirSync(destDocs);
      writeFileSync(join(destDocs, 'safe.txt'), 'live');

      const restore = spawnSync('sh', [restoreScript, encrypted, keyFile], {
        env: {
          ...process.env,
          DATABASE_PATH: join(work, 'live.db'),
          OBJECT_STORAGE_LOCAL_PATH: destDocs,
        },
        encoding: 'utf-8',
      });
      expect(restore.status).not.toBe(0);
      expect(`${restore.stdout}\n${restore.stderr}`).toMatch(/symlink/i);
      expect(readFileSync(join(destDocs, 'safe.txt'), 'utf-8')).toBe('live');
      expect(existsSync(join(destDocs, 'link'))).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasBackupTools)('refuses archives that contain a hard-link member', () => {
    const work = makeWork();
    try {
      const tree = join(work, 'tree');
      mkdirSync(join(tree, 'documents'), { recursive: true });
      sqliteExec(join(tree, 'openenvelope.db'), 'CREATE TABLE items (id INTEGER PRIMARY KEY);');
      writeFileSync(join(tree, 'documents', 'a.txt'), 'synthetic');
      linkSync(join(tree, 'documents', 'a.txt'), join(tree, 'documents', 'b.txt'));
      const { keyFile, publicKey } = makeAgeKey(work);
      const encrypted = encryptTree(work, publicKey, tree);
      const destDocs = join(work, 'live-docs');
      mkdirSync(destDocs);
      writeFileSync(join(destDocs, 'safe.txt'), 'live');

      const restore = spawnSync('sh', [restoreScript, encrypted, keyFile], {
        env: {
          ...process.env,
          DATABASE_PATH: join(work, 'live.db'),
          OBJECT_STORAGE_LOCAL_PATH: destDocs,
        },
        encoding: 'utf-8',
      });
      expect(restore.status).not.toBe(0);
      expect(`${restore.stdout}\n${restore.stderr}`).toMatch(/hard link/i);
      expect(readFileSync(join(destDocs, 'safe.txt'), 'utf-8')).toBe('live');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasBackupTools)('leaves live state unchanged if restore fails after the DB swap starts', () => {
    const work = makeWork();
    try {
      const liveDb = join(work, 'live', 'openenvelope.db');
      const liveDocs = join(work, 'live', 'documents');
      const srcDb = join(work, 'src', 'openenvelope.db');
      const srcDocs = join(work, 'src', 'documents');
      const backupDir = join(work, 'backups');
      mkdirSync(join(work, 'live'), { recursive: true });
      mkdirSync(liveDocs, { recursive: true });
      mkdirSync(srcDocs, { recursive: true });
      sqliteExec(liveDb, "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items (name) VALUES ('live-row');");
      writeFileSync(join(liveDocs, 'live.txt'), 'live-doc');
      sqliteExec(srcDb, "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items (name) VALUES ('restored-row');");
      writeFileSync(join(srcDocs, 'restored.txt'), 'restored-doc');

      const { keyFile, publicKey } = makeAgeKey(work);
      const backup = spawnSync('sh', [backupScript], {
        env: {
          ...process.env,
          DATABASE_PATH: srcDb,
          OBJECT_STORAGE_LOCAL_PATH: srcDocs,
          BACKUP_DIR: backupDir,
          BACKUP_AGE_PUBLIC_KEY: publicKey,
        },
        encoding: 'utf-8',
      });
      expect(backup.status, backup.stderr || backup.stdout).toBe(0);
      const archives = readdirSync(backupDir).filter((name) => name.endsWith('.tar.zst.age'));

      const restore = spawnSync('sh', [restoreScript, join(backupDir, archives[0]!), keyFile], {
        env: {
          ...process.env,
          DATABASE_PATH: liveDb,
          OBJECT_STORAGE_LOCAL_PATH: liveDocs,
          OPENENVELOPE_TEST_MODE: '1',
          RESTORE_FAIL_AFTER_DB_SWAP: '1',
        },
        encoding: 'utf-8',
      });
      expect(restore.status).not.toBe(0);
      expect(`${restore.stdout}\n${restore.stderr}`).toMatch(/RESTORE_FAIL_AFTER_DB_SWAP|reverting live files/i);
      expect(sqliteExec(liveDb, 'SELECT name FROM items')).toBe('live-row');
      expect(readFileSync(join(liveDocs, 'live.txt'), 'utf-8')).toBe('live-doc');
      expect(existsSync(join(liveDocs, 'restored.txt'))).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasBackupTools)('refuses to restore while another process holds the database', async () => {
    const work = makeWork();
    const liveDb = join(work, 'openenvelope.db');
    const srcDb = join(work, 'src.db');
    const backupDir = join(work, 'backups');
    sqliteExec(liveDb, "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items (name) VALUES ('live-row');");
    sqliteExec(srcDb, "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items (name) VALUES ('restored-row');");
    const holder = spawnIdleWalHolder(liveDb);
    try {
      const { keyFile, publicKey } = makeAgeKey(work);
      const backup = spawnSync('sh', [backupScript], {
        env: {
          ...process.env,
          DATABASE_PATH: srcDb,
          OBJECT_STORAGE_LOCAL_PATH: join(work, 'empty-docs'),
          BACKUP_DIR: backupDir,
          BACKUP_AGE_PUBLIC_KEY: publicKey,
        },
        encoding: 'utf-8',
      });
      expect(backup.status, backup.stderr || backup.stdout).toBe(0);

      await waitForReady(holder);

      const weakProbe = spawnSync('sqlite3', [liveDb, 'PRAGMA busy_timeout=100; BEGIN EXCLUSIVE; ROLLBACK;'], {
        encoding: 'utf-8',
      });
      expect(weakProbe.status, 'idle WAL reader must not conflict with BEGIN EXCLUSIVE; ROLLBACK').toBe(0);

      const lockProbe = spawnSync('sqlite3', [liveDb, LOCK_PROBE_SQL], { encoding: 'utf-8' });
      expect(lockProbe.status, lockProbe.stderr || lockProbe.stdout).not.toBe(0);

      const before = snapshotDbFiles(liveDb);
      const archives = readdirSync(backupDir).filter((name) => name.endsWith('.tar.zst.age'));
      const restore = spawnSync('sh', [restoreScript, join(backupDir, archives[0]!), keyFile], {
        env: {
          ...process.env,
          DATABASE_PATH: liveDb,
        },
        encoding: 'utf-8',
      });
      expect(restore.status).not.toBe(0);
      expect(`${restore.stdout}\n${restore.stderr}`).toMatch(/in use|locked|Stop the OpenEnvelope container/i);
      expectDbFilesUnchanged(liveDb, before);
    } finally {
      holder.kill('SIGKILL');
      await new Promise<void>((resolve) => {
        holder.once('close', () => resolve());
        setTimeout(resolve, 1000);
      });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasBackupTools)('refuses to restore when a separate process holds a sqlite exclusive lock', async () => {
    const work = makeWork();
    const liveDb = join(work, 'openenvelope.db');
    const srcDb = join(work, 'src.db');
    const backupDir = join(work, 'backups');
    sqliteExec(liveDb, "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items (name) VALUES ('live-row');");
    sqliteExec(srcDb, "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items (name) VALUES ('restored-row');");
    const holder = spawn('sqlite3', ['-batch', liveDb], { stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      const { keyFile, publicKey } = makeAgeKey(work);
      const backup = spawnSync('sh', [backupScript], {
        env: {
          ...process.env,
          DATABASE_PATH: srcDb,
          OBJECT_STORAGE_LOCAL_PATH: join(work, 'empty-docs'),
          BACKUP_DIR: backupDir,
          BACKUP_AGE_PUBLIC_KEY: publicKey,
        },
        encoding: 'utf-8',
      });
      expect(backup.status, backup.stderr || backup.stdout).toBe(0);

      holder.stdin.write("PRAGMA busy_timeout=0;\nBEGIN EXCLUSIVE;\n");
      const deadline = Date.now() + 2000;
      let locked = false;
      while (Date.now() < deadline) {
        const probe = spawnSync('sqlite3', [liveDb, 'PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; ROLLBACK;'], {
          encoding: 'utf-8',
        });
        if (probe.status !== 0) {
          locked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(locked).toBe(true);

      const archives = readdirSync(backupDir).filter((name) => name.endsWith('.tar.zst.age'));
      const restore = spawnSync('sh', [restoreScript, join(backupDir, archives[0]!), keyFile], {
        env: {
          ...process.env,
          DATABASE_PATH: liveDb,
        },
        encoding: 'utf-8',
      });
      expect(restore.status).not.toBe(0);
      expect(`${restore.stdout}\n${restore.stderr}`).toMatch(/in use|locked|Stop the OpenEnvelope container/i);
      holder.kill('SIGKILL');
      await new Promise<void>((resolve) => {
        holder.once('close', () => resolve());
        setTimeout(resolve, 1000);
      });
      expect(sqliteExec(liveDb, 'SELECT name FROM items')).toBe('live-row');
    } finally {
      holder.kill('SIGKILL');
      rmSync(work, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasBackupTools)('ignores restore fail hooks unless OPENENVELOPE_TEST_MODE=1', () => {
    const work = makeWork();
    try {
      const liveDb = join(work, 'live', 'openenvelope.db');
      const liveDocs = join(work, 'live', 'documents');
      const srcDb = join(work, 'src', 'openenvelope.db');
      const srcDocs = join(work, 'src', 'documents');
      const backupDir = join(work, 'backups');
      mkdirSync(join(work, 'live'), { recursive: true });
      mkdirSync(liveDocs, { recursive: true });
      mkdirSync(srcDocs, { recursive: true });
      sqliteExec(liveDb, "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items (name) VALUES ('live-row');");
      writeFileSync(join(liveDocs, 'live.txt'), 'live-doc');
      sqliteExec(srcDb, "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items (name) VALUES ('restored-row');");
      writeFileSync(join(srcDocs, 'restored.txt'), 'restored-doc');

      const { keyFile, publicKey } = makeAgeKey(work);
      const backup = spawnSync('sh', [backupScript], {
        env: {
          ...process.env,
          DATABASE_PATH: srcDb,
          OBJECT_STORAGE_LOCAL_PATH: srcDocs,
          BACKUP_DIR: backupDir,
          BACKUP_AGE_PUBLIC_KEY: publicKey,
        },
        encoding: 'utf-8',
      });
      expect(backup.status, backup.stderr || backup.stdout).toBe(0);
      const archives = readdirSync(backupDir).filter((name) => name.endsWith('.tar.zst.age'));

      const restore = spawnSync('sh', [restoreScript, join(backupDir, archives[0]!), keyFile], {
        env: {
          ...process.env,
          DATABASE_PATH: liveDb,
          OBJECT_STORAGE_LOCAL_PATH: liveDocs,
          RESTORE_FAIL_AFTER_DB_SWAP: '1',
          RESTORE_FAIL_BEFORE_SWAP: '1',
        },
        encoding: 'utf-8',
      });
      expect(restore.status, restore.stderr || restore.stdout).toBe(0);
      expect(sqliteExec(liveDb, 'SELECT name FROM items')).toBe('restored-row');
      expect(readFileSync(join(liveDocs, 'restored.txt'), 'utf-8')).toBe('restored-doc');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
