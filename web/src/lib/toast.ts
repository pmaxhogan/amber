import { useToast } from "primevue/usetoast";
import { normalizeError } from "../api/client.ts";

/**
 * Thin wrapper over PrimeVue's toast service.
 *
 * useToast() throws when the ToastService plugin is not installed, which is the
 * common case in a component test that only cares about markup. Falling back to
 * a no-op keeps mutation handlers testable without every test wiring the
 * plugin, while the real app still shows toasts.
 */

export interface Toaster {
  success: (summary: string, detail?: string) => void;
  info: (summary: string, detail?: string) => void;
  warn: (summary: string, detail?: string) => void;
  /** Normalizes anything thrown into a readable message. */
  failure: (summary: string, cause: unknown) => void;
}

interface ToastLike {
  add: (message: { severity: string; summary: string; detail?: string; life?: number }) => void;
}

const NOOP_TOAST: ToastLike = { add: () => undefined };

export function useToaster(): Toaster {
  let service: ToastLike = NOOP_TOAST;
  try {
    service = useToast() as unknown as ToastLike;
  } catch {
    service = NOOP_TOAST;
  }

  const emit = (severity: string, summary: string, detail?: string, life = 4000): void => {
    service.add({ severity, summary, detail, life });
  };

  return {
    success: (summary, detail) => emit("success", summary, detail),
    info: (summary, detail) => emit("info", summary, detail),
    warn: (summary, detail) => emit("warn", summary, detail, 6000),
    failure: (summary, cause) => emit("error", summary, normalizeError(cause).message, 8000),
  };
}
