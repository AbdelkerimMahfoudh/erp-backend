/**
 * Two small things the fixture command needs and nothing else should.
 *
 * Kept beside it rather than in `src/`: a prompt that does not echo and a hash
 * helper are tooling, and putting them in the application would invite somebody
 * to use them there.
 */
import { createHash as nodeCreateHash } from 'node:crypto';
import * as readline from 'node:readline';

/** The same hash the contact-verification service stores. */
export function createHash(input: string): string {
  return nodeCreateHash('sha256').update(input).digest('hex');
}

export interface Prompt {
  question(text: string): Promise<string>;
  close(): void;
}

/**
 * Ask for a password without putting it on the screen.
 *
 * A staging password typed into a terminal that echoes it ends up in a
 * screenshot, a scrollback buffer or a pair-programming session. Muting the
 * output stream is the whole trick: the characters still arrive, they are just
 * never written back.
 */
export function createInterface(): Prompt {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return {
    question(text: string): Promise<string> {
      return new Promise((resolve) => {
        const output = rl as unknown as { output: NodeJS.WriteStream; _writeToOutput?: unknown };
        let muted = false;
        output._writeToOutput = (chunk: string) => {
          if (!muted) output.output.write(chunk);
        };
        rl.question(text, (answer) => {
          muted = false;
          process.stdout.write('\n');
          resolve(answer);
        });
        muted = true;
      });
    },
    close() {
      rl.close();
    },
  };
}
