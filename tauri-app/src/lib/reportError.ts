import type { TranslationKey } from "../i18n";
import { describeApiError } from "./launcherError";
import { notifyError } from "./toast";

type Translator = (key: TranslationKey, values?: Record<string, string | number>) => string;

/**
 * Standard handling for a failed backend call the user explicitly triggered:
 * localize the cause, update the status line, and raise a toast so the failure
 * is actually visible (the status line is not rendered in the shell).
 *
 * Returns the localized text so callers can also render it inline.
 */
export function reportRequestFailure(
  error: unknown,
  t: Translator,
  setStatus?: (status: string) => void,
  titleKey: TranslationKey = "toast.title.requestFailed"
): string {
  const message = describeApiError(error, t);
  setStatus?.(t("app.status.failed", { error: message }));
  notifyError(message, t(titleKey));
  return message;
}
