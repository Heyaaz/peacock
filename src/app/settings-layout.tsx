import type { ReactNode } from "react";

/**
 * One titled group of a settings page: a small heading, an optional line under it, and
 * its rows in one panel. Every page is made of these, so headings and spacing line up
 * from page to page.
 */
export function SettingsSection({
  title,
  description,
  actions,
  className,
  children,
  plain = false,
}: {
  title: string;
  description?: ReactNode;
  /** Buttons at the heading's right end. */
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
  /** Children are laid out by themselves (cards), not wrapped in the row panel. */
  plain?: boolean;
}) {
  return (
    <section className={`settings-section${className ? ` ${className}` : ""}`} aria-label={title}>
      <header className="settings-section__head">
        <span>
          <h3>{title}</h3>
          {description && <p>{description}</p>}
        </span>
        {actions && <span className="settings-section__actions">{actions}</span>}
      </header>
      {plain ? children : <div className="settings-panel">{children}</div>}
    </section>
  );
}
