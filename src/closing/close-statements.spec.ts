import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What a close may be told, and by whom (docs/58 D71).
 *
 * A close without amounts rests on a statement: the person attests they checked,
 * or acknowledges they did not and says why. Only the close writes the machine
 * keys those statements leave on a channel's row; a count can never forge one.
 * These are pinned on the service's source; the behaviour is driven end to end
 * on a copy of live by the close harnesses (docs/58 §3.5).
 */
const closing = readFileSync(join(__dirname, 'closing.service.ts'), 'utf8');

/** One method's source: from its signature to the next class member (public or private), never the rest of the file. */
function body(name: string): string {
  const start = closing.indexOf(`  async ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  const rest = closing.slice(start + 10);
  const next = rest.search(/\n {2}(?:async |private |public |protected |\/\/ ---)/);
  if (next < 0) throw new Error(`${name} has no member after it`);
  return closing.slice(start, start + 10 + next);
}

describe('a count cannot carry a key only the close writes', () => {
  it('refuses a skip whose reason is one of the machine keys', () => {
    const count = body('recordCount');
    expect(count).toMatch(/if \(isMachineSkipReason\(dto\.skipReason\)\) \{\s*throw new BadRequestException\(\{ code: 'reserved_reason'/);
  });

  it('keeps the person’s own reason in the count’s event and its audit, not only on the row a close may replace', () => {
    const count = body('recordCount');
    // The row, the count's event, the audit: three places, so replacing the row never loses the reason.
    expect(count.match(/skipReason: dto\.skip \? \(dto\.skipReason\?\.trim\(\) \?\? null\) : null/g)).toHaveLength(3);
  });
});

describe('a close says one thing about the balances it did not count', () => {
  it('refuses "I checked" and "I did not check" in the same request, before anything is read', () => {
    const close = body('close');
    const refusal = close.indexOf("code: 'conflicting_statements'");
    expect(refusal).toBeGreaterThan(0);
    expect(close).toMatch(/if \(dto\.attestChecked === true && dto\.acknowledgeUnverified === true\) \{/);
    // Before the replay, the report and the lock: a contradiction is refused whatever the day holds.
    expect(refusal).toBeLessThan(close.indexOf('replayClose('));
  });

  it('attests every channel without an amount, or leaves them all to the acknowledgement — never a mix', () => {
    const close = body('close');
    expect(close).toMatch(/const attested = dto\.attestChecked === true \? unchecked : \[\];/);
    expect(close).toMatch(/const unverified = dto\.attestChecked === true \? \[\] : unchecked;/);
  });
});

describe('a close stored before the attestation existed', () => {
  it('reads back with an empty attested list, never undefined', () => {
    expect(closing).toMatch(/report\.close && !Array\.isArray\(report\.close\.attested\) \? \{ \.\.\.report, close: \{ \.\.\.report\.close, attested: \[\] \} \} : report/);
  });
});
