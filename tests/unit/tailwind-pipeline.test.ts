import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Tailwind styling pipeline', () => {
  it('compiles utilities via @tailwindcss/vite against styles.css', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as {
      devDependencies: Record<string, string>;
    };
    expect(pkg.devDependencies.tailwindcss).toBeTruthy();
    expect(pkg.devDependencies['@tailwindcss/vite']).toBeTruthy();

    const vite = readFileSync(join(process.cwd(), 'vite.config.ts'), 'utf-8');
    expect(vite).toContain("@tailwindcss/vite");
    expect(vite).toContain('tailwindcss()');

    const css = readFileSync(join(process.cwd(), 'src/client/styles.css'), 'utf-8');
    expect(css.startsWith('@import "tailwindcss"')).toBe(true);
    expect(css).toContain('--color-bg:');
    expect(css).toContain('--color-surface:');
    expect(css).toContain('--color-primary:');
  });
});
