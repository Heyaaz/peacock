/**
 * Peacock's mark: a script capital P, Satisfy's own glyph (Apache-2.0, see THIRD_PARTY_NOTICES)
 * turned into one path, so no font ships for it. It is drawn on the 100-unit square of the tile
 * it sits on: 84% of the tile tall, nudged left and down a little to look centered (design §11).
 * It fills in the current color, so it takes the theme's accent wherever it sits.
 */
const PEACOCK_P_PATH =
  "M20.74 85.47Q21.07 85.23 21.77 84.65Q22.47 84.08 23.41 82.52Q24.35 80.96 25.5 78.01Q26.65 75.06 27.88 69.97Q28.54 67.26 29.6 63.08Q30.67 58.9 31.94 54.14Q33.21 49.38 34.53 44.33Q35.84 39.29 37.07 34.74Q38.3 30.18 39.28 26.49Q40.27 22.8 40.84 20.75Q39.28 21.74 37.81 22.97Q36.49 24.03 35.02 25.39Q33.54 26.74 32.15 28.22Q31.08 27.31 30.51 26.25Q30.18 25.75 29.93 25.18Q29.44 23.95 29.44 22.64Q29.44 21.33 31.49 19.93Q32.56 19.19 34.73 17.8Q36.9 16.4 40.1 15.05Q43.3 13.7 47.57 12.71Q51.83 11.73 57 11.73Q62.17 11.73 65.33 13.78Q68.49 15.83 70.17 18.78Q71.85 21.74 72.34 25.02Q72.83 28.3 72.59 30.76Q72.1 35.35 69.64 40.36Q67.17 45.36 62.83 49.58Q58.48 53.81 52.24 56.76Q46.01 59.72 37.97 60.13Q37.31 63.24 36.66 66.52Q36 69.81 35.26 72.96Q34.53 76.12 33.75 78.87Q32.97 81.62 32.15 83.59Q31.33 85.72 30.01 86.99Q28.7 88.26 25.83 88.26Q24.35 88.26 23.08 87.52Q21.81 86.79 20.74 85.47M40.19 48.07Q39.94 49.38 39.57 51.47Q39.2 53.56 38.71 56.19Q40.92 55.86 43.63 55Q46.34 54.14 49.05 52.66Q51.75 51.18 54.34 49.09Q56.92 47 59.05 44.25Q61.19 41.5 62.62 38.02Q64.06 34.53 64.47 30.27Q64.88 26.16 64.02 23.42Q63.15 20.67 61.51 18.99Q59.87 17.31 57.74 16.61Q55.61 15.91 53.47 15.91Q51.42 15.91 49.46 16.49Q47.49 17.06 45.52 17.96Q45.76 18.04 46.09 18.37Q46.58 18.86 46.83 19.77Q44.86 27.72 43.59 33.06Q42.32 38.39 41.58 41.75Q40.68 45.69 40.19 48.07";

export function PeacockMark({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      className={`peacock-mark${className ? ` ${className}` : ""}`}
      viewBox="0 0 100 100"
      fill="currentColor"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <path d={PEACOCK_P_PATH} />
    </svg>
  );
}

/** The wordmark, set in Unbounded (bundled, OFL). */
export function PeacockWordmark({ className }: { className?: string }) {
  return <span className={`peacock-wordmark${className ? ` ${className}` : ""}`}>PEACOCK</span>;
}
