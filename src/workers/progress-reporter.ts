export type ProgressResponse = {
  type: 'progress';
  progress: number;
  message: string;
  transient?: boolean;
};

export interface ProgressReporter {
  report(progress: number, message: string): void;
  milestone(progress: number, message: string): void;
}
export function createProgressReporter(
  post: (response: ProgressResponse) => void,
  now: () => number = () => performance.now(),
  minIntervalMs = 100,
  minDelta = 0.02,
): ProgressReporter {
  let lastTime = -Infinity;
  let lastProgress = -Infinity;
  return {
    report(progress, message) {
      const time = now();
      if (progress < 1 && time - lastTime < minIntervalMs && progress - lastProgress < minDelta) return;
      lastTime = time;
      lastProgress = progress;
      post({ type: 'progress', progress, message, transient: true });
    },
    milestone(progress, message) {
      lastTime = now();
      lastProgress = progress;
      post({ type: 'progress', progress, message });
    },
  };
}
