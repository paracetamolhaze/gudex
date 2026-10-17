import { describe, expect, it } from 'vitest';
import { assertLocalTestDatabase } from '../database-target';

describe('destructive database test target guard', () => {
  it('allows the dedicated local test database', () => {
    const value = 'postgres://gudex:gudex@localhost:5442/gudex_test';
    expect(assertLocalTestDatabase(value)).toBe(value);
  });
  it.each(['postgres://user:password@production.example/gudex', 'postgres://user:password@production.example/gudex_test',
    'postgres://gudex:gudex@localhost:5442/gudex'])('refuses unsafe target without printing its credentials', target => {
    expect(() => assertLocalTestDatabase(target)).toThrow('refusing to reset');
    try { assertLocalTestDatabase(target); } catch (error) { expect(String(error)).not.toContain('password'); }
  });
});
