/**
 * Peacock's mark: a strike chevron (Λ with a crossbar), drawn in the current color so it takes
 * the theme's accent wherever it sits. `crossbar={false}` is the bare chevron of the menu bar.
 */
export function PeacockMark({
  crossbar = true,
  className,
  title,
}: {
  crossbar?: boolean;
  className?: string;
  /** Names the mark for a screen reader; without it the mark is decoration. */
  title?: string;
}) {
  return (
    <svg
      className={`peacock-mark${className ? ` ${className}` : ""}`}
      viewBox="0 0 56 56"
      fill="none"
      stroke="currentColor"
      strokeWidth={5.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <path d="M12 42 L28 12 L44 42" />
      {crossbar && <path d="M20 31h16" />}
    </svg>
  );
}

/** The name as a wordmark, in the display face (Unbounded). */
export function PeacockWordmark({ className }: { className?: string }) {
  return <span className={`peacock-wordmark${className ? ` ${className}` : ""}`}>PEACOCK</span>;
}
