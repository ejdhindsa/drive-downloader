export type ToastVariant = 'success' | 'danger' | 'info';

export interface ToastItem {
  id: number;
  variant: ToastVariant;
  message: string;
}

class ToastStore {
  items = $state<ToastItem[]>([]);
  private nextId = 1;
  private timers = new Map<number, ReturnType<typeof setTimeout>>();

  push(variant: ToastVariant, message: string, durationMs = 4500) {
    const id = this.nextId++;
    this.items.push({ id, variant, message });

    if (durationMs > 0) {
      const timer = setTimeout(() => this.dismiss(id), durationMs);
      this.timers.set(id, timer);
    }
  }

  dismiss(id: number) {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    this.items = this.items.filter((item) => item.id !== id);
  }
}

export const toasts = new ToastStore();
