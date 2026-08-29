import { describe, expect, it } from 'vitest';
import { createProgressReporter, type ProgressResponse } from './progress-reporter';

describe('generation progress reporter', () => {
  it('rate-limits transient progress while preserving milestones and completion', () => {
    let time = 0;
    const posted: ProgressResponse[] = [];
    const reporter = createProgressReporter((message) => posted.push(message), () => time, 100, 0.02);

    reporter.report(0.01, 'first');
    time = 50;
    reporter.report(0.015, 'suppressed');
    time = 60;
    reporter.report(0.05, 'delta');
    time = 200;
    reporter.report(0.051, 'time');
    reporter.report(1, 'done');
    reporter.milestone(0.5, 'phase');
    reporter.report(0.5, 'suppressed after milestone');

    expect(posted.map((message) => message.message)).toEqual(['first', 'delta', 'time', 'done', 'phase']);
    expect(posted.slice(0, 4).every((message) => message.transient)).toBe(true);
    expect(posted[4].transient).toBeUndefined();
  });
});
