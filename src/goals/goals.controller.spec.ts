import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GoneException, NotFoundException } from '@nestjs/common';
import { GoalsController } from './goals.controller';

describe('Goals are dormant (D227)', () => {
  const controller = new GoalsController();

  it('an old build lists nothing and finds nothing', () => {
    expect(controller.list()).toEqual([]);
    expect(() => controller.get()).toThrow(NotFoundException);
  });

  it.each([
    ['fr-FR', 'Cette fonctionnalité est actuellement indisponible.'],
    ['ar', 'هذه الميزة غير متاحة حاليًا.'],
    [undefined, 'This feature is currently unavailable.'],
  ])('creating is refused with a stable code, in %s', (language, message) => {
    try {
      controller.create(language);
      throw new Error('not refused');
    } catch (e) {
      expect(e).toBeInstanceOf(GoneException);
      expect((e as GoneException).getResponse()).toEqual({ code: 'feature_unavailable', message });
    }
  });

  it('no code outside the module touches the goals table', () => {
    const source = readFileSync(join(__dirname, 'goals.controller.ts'), 'utf8');
    expect(source).not.toMatch(/prisma|\.goal\.|FROM goals/i);
    expect(readdirSync(__dirname).sort()).toEqual(['goals.controller.spec.ts', 'goals.controller.ts', 'goals.module.ts']);
  });
});
