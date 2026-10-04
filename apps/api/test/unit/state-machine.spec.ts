import { STATUSES, type Status } from '@minwon/contracts';
import { ALLOWED_TRANSITIONS, assertTransition, InvalidTransitionError } from '../../src/complaints/state-machine';

const ALLOWED: [Status, Status][] = [
  ['received', 'draft'],
  ['draft', 'draft'],
  ['draft', 'approved'],
  ['approved', 'sent'],
];

const allPairs = STATUSES.flatMap((from) => STATUSES.map((to) => [from, to] as [Status, Status]));
const isAllowed = ([f, t]: [Status, Status]) => ALLOWED.some(([af, at]) => af === f && at === t);

describe('상태 전이', () => {
  it('전이표가 스펙과 정확히 같다', () => {
    expect(ALLOWED_TRANSITIONS).toEqual({
      received: ['draft'],
      draft: ['draft', 'approved'],
      approved: ['sent'],
      sent: [],
    });
  });

  it.each(ALLOWED)('허용: %s → %s', (from, to) => {
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it.each(allPairs.filter((p) => !isAllowed(p)))('불허: %s → %s', (from, to) => {
    expect(() => assertTransition(from, to)).toThrow(InvalidTransitionError);
  });
});
