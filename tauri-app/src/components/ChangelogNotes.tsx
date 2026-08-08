import { memo, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useI18n } from "../i18n";

type ChangelogNotesProps = {
  notes: string | null | undefined;
  /** Start expanded when the surrounding UI already gated the notes behind its own toggle. */
  defaultExpanded?: boolean;
  className?: string;
};

/**
 * Release notes come straight from the publisher and can be arbitrarily long, so they
 * are clipped to a few lines and only grow into a bounded scroll area on demand. That
 * keeps update screens on a single viewport instead of stretching the page.
 */
function ChangelogNotes({ notes, defaultExpanded = false, className = "" }: ChangelogNotesProps) {
  const { t } = useI18n();
  const bodyRef = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [clipped, setClipped] = useState(false);
  const text = notes?.trim() ?? "";

  // A new release replaces the notes, so collapse back to the preview.
  const [renderedText, setRenderedText] = useState(text);
  if (renderedText !== text) {
    setRenderedText(text);
    setExpanded(defaultExpanded);
  }

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) {
      return;
    }
    const measure = () => setClipped(el.scrollHeight - el.clientHeight > 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, expanded]);

  if (!text) {
    return null;
  }

  const bodyClass = [
    "changelog-body",
    expanded ? "is-expanded" : "",
    !expanded && clipped ? "is-clipped" : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={`changelog ${className}`.trim()}>
      <p ref={bodyRef} className={bodyClass}>
        {text}
      </p>
      {clipped || expanded ? (
        <button
          type="button"
          className="changelog-toggle"
          onClick={() => setExpanded((prev) => !prev)}
        >
          {expanded ? t("changelog.collapse") : t("changelog.expand")}
          <ChevronDown size={13} className={`changelog-chevron${expanded ? " is-open" : ""}`} />
        </button>
      ) : null}
    </div>
  );
}

export default memo(ChangelogNotes);
