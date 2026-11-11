import { describe, expect, it } from 'vitest';
import { syntheticChatResponse } from '@certo/core';
import { flipVoteByte } from '../src/forge.js';

describe('scene 5 forgery (flipVoteByte)', () => {
  it('changes exactly one byte: the final vote letter', () => {
    for (const content of ['Y', 'X', '<think>\nthe token differs\n</think>\n\nX']) {
      const body = syntheticChatResponse({ chatId: 'chatcmpl-t', model: 'Qwen/Qwen3.8-27B', content });
      const f = flipVoteByte(body);
      expect(f.body.length).toBe(body.length);
      expect([...f.body].filter((ch, i) => ch !== body[i])).toEqual([f.to]);
      expect(f.from).toBe(content.at(-1));
      expect(JSON.parse(f.body).choices[0].message.content).toBe(content.slice(0, -1) + f.to);
    }
  });

  it('refuses an answer that is not a vote', () => {
    expect(() => flipVoteByte('{"choices":[{"message":{"content":"maybe"}}]}')).toThrow(/X or Y/);
  });
});
