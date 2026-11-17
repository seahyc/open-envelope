import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';

describe('docker-compose hardening', () => {
  const compose = parse(readFileSync(join(process.cwd(), 'docker-compose.yml'), 'utf-8')) as {
    services: {
      openenvelope: {
        read_only?: boolean;
        cap_drop?: string[];
        security_opt?: string[];
        mem_limit?: string;
        cpus?: number | string;
        pids_limit?: number;
        tmpfs?: string[];
        volumes?: string[];
        environment?: string[];
      };
    };
  };
  const service = compose.services.openenvelope;

  it('locks down the production service', () => {
    expect(service.read_only).toBe(true);
    expect(service.cap_drop).toEqual(['ALL']);
    expect(service.security_opt).toContain('no-new-privileges:true');
    expect(service.mem_limit).toBe('768m');
    expect(Number(service.cpus)).toBe(1);
    expect(service.pids_limit).toBe(256);
    expect(service.tmpfs?.some((entry) => entry.startsWith('/tmp'))).toBe(true);
    expect(service.tmpfs?.some((entry) => entry.startsWith('/home/node'))).toBe(true);
    expect(service.volumes?.some((entry) => entry.endsWith(':/data') || entry === 'data:/data')).toBe(true);
    expect(service.volumes?.some((entry) => entry.includes('/backups'))).toBe(true);
  });

  it('pins Codex CLI in the image and uses a non-failing entrypoint', () => {
    const dockerfile = readFileSync(join(process.cwd(), 'Dockerfile'), 'utf-8');
    expect(dockerfile).toContain('@openai/codex@0.164.0');
    expect(dockerfile).toContain('ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]');
    expect(dockerfile).toContain('CATEGORISER_AUTO_THRESHOLD=0.9');
    expect(dockerfile).toContain('CODEX_MODEL=gpt-6-luna');
    expect(dockerfile).toContain('COPY --from=builder /app/dist ./dist');
    const entry = readFileSync(join(process.cwd(), 'scripts/docker-entrypoint.sh'), 'utf-8');
    expect(entry).toMatch(/Never fail startup/);
    expect(entry).toContain('/codex-auth/auth.json');
  });

  it('compiles maintenance CLIs to dist/scripts for the prod image (no tsx)', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.reconcile).toBe('node dist/scripts/reconcile.js');
    expect(pkg.scripts['detect-transfers']).toBe('node dist/scripts/detect-transfers.js');
    const tsconfig = JSON.parse(readFileSync(join(process.cwd(), 'tsconfig.json'), 'utf-8')) as {
      compilerOptions: { rootDir: string; outDir: string };
      include: string[];
    };
    expect(tsconfig.compilerOptions.rootDir).toBe('./src');
    expect(tsconfig.compilerOptions.outDir).toBe('./dist');
    expect(tsconfig.include).toContain('src/**/*');
    expect(readFileSync(join(process.cwd(), 'src/scripts/reconcile.ts'), 'utf-8')).toContain('reconcileAllPeriods');
    expect(readFileSync(join(process.cwd(), 'src/scripts/detect-transfers.ts'), 'utf-8')).toContain(
      'detectAndLinkTransfers'
    );
  });

  it('defaults Codex model, effort, and auto-threshold', () => {
    const env = service.environment ?? [];
    expect(env.some((line) => line.includes('CODEX_MODEL') && line.includes('gpt-6-luna'))).toBe(true);
    expect(env.some((line) => line.includes('CODEX_REASONING_EFFORT') && line.includes('low'))).toBe(true);
    expect(env.some((line) => line.includes('CATEGORISER_AUTO_THRESHOLD') && line.includes('0.9'))).toBe(true);
    expect(env.some((line) => line.includes('CODEX_HOME=/tmp/codex-home'))).toBe(true);
  });
});
