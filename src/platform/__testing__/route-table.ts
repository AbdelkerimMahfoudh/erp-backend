import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every route the source declares, as `METHOD path` with the controller's path and the handler's joined — read from
 * the controllers themselves, so a route added anywhere is in the table without anybody listing it (0095).
 *
 * Comments are stripped first: a route named in a comment is not a route.
 */

/** A source file without its comments. */
export function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

export function routeTable(root = 'src'): string[] {
  const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith('.controller.ts'));
  const routes: string[] = [];
  for (const file of files) {
    const code = codeOf(join(root, file));
    for (const cls of code.split(/(?=@Controller\()/).slice(1)) {
      const head = cls.match(/^@Controller\((?:'([^']*)'|\{[^}]*?path:\s*'([^']*)'[^}]*\}|\{[^}]*\})?\)/);
      const base = head?.[1] ?? head?.[2] ?? '';
      for (const m of cls.matchAll(/@(Get|Post|Put|Patch|Delete)\((?:'([^']*)')?\)/g)) {
        routes.push(`${m[1].toUpperCase()} ${[base, m[2] ?? ''].filter(Boolean).join('/')}`);
      }
    }
  }
  return routes;
}
