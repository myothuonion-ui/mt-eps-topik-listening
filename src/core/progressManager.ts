export class ProgressManager {
  private progress = new Map<string, number>();

  update(jobId: string, percent: number) {
    this.progress.set(jobId, Math.max(0, Math.min(100, percent)));
  }

  get(jobId: string) {
    return this.progress.get(jobId) ?? 0;
  }
}

export const progressManager = new ProgressManager();
