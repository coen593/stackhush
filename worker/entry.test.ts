import { describe, expect, it } from 'vitest';
import * as entry from './index.ts';

describe('the Worker entry module', () => {
  // workerd treats every named export of the entry module as an entrypoint and refuses to start
  // when one is not a handler, so shared values belong in other modules.
  it('exports only the default handler', () => {
    expect(Object.keys(entry)).toEqual(['default']);
  });
});
