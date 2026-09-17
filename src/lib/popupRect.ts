/**
 * Where a floating panel goes so that it lands on the screen.
 *
 * The bill form's three popups — the item search, the change-item picker and
 * the last-prices list — are all portalled to <body> and positioned in
 * viewport coordinates taken from their input's own rect. That is the right
 * shape (they sit inside a horizontally scrollable table, which clips
 * anything absolutely positioned), but it was missing the only step that
 * matters on a phone: nothing checked the answer against the width of the
 * screen.
 *
 * So on a 390px phone the item dropdown, anchored to an input sitting at
 * x=140 in a 720px-wide table, opened at x=140 and ran 200px off the right
 * edge — the prices were simply not on the display. The last-prices popup,
 * which right-aligns itself by subtracting its own width, did the same thing
 * off the LEFT edge and lost its heading. Both were photographed at the
 * counter.
 *
 * Pure on purpose: the anchor and the viewport come in as plain numbers, so
 * every case below can be asserted without a browser.
 */

export type Anchor = {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
};

export type Viewport = {
  width: number;
  /** The LAYOUT viewport's height — the box `position: fixed` measures against. */
  height: number;
  /**
   * The band of that box a person can actually see, in the same client
   * coordinates. A keyboard covers the bottom of the screen without changing
   * the layout viewport at all, so this is what decides whether a panel has
   * room below — and the layout viewport is still what positions it.
   *
   * Keeping these apart is the whole point. Conflating them put a popup 220px
   * above the box it belongs to, photographed at the counter: the panel was
   * positioned with a number measured in the wrong space.
   */
  visibleTop?: number;
  visibleBottom?: number;
};

export type PopupPlacement = {
  left: number;
  width: number;
  /** Set when the panel hangs below its anchor. */
  top?: number;
  /** Set instead when it was flipped above — distance from the viewport's
   *  bottom edge, so the panel grows upward from the input rather than
   *  floating away from it. */
  bottom?: number;
  /** Never taller than the room it was given. */
  maxHeight: number;
};

export type PopupOptions = {
  /** Widen a narrow anchor up to this, room permitting. */
  minWidth?: number;
  /** Ignore the anchor's own width and ask for this instead. */
  preferredWidth?: number;
  /** Which edge to line up with. Right-aligned panels are the ones that used
   *  to walk off the left of a phone. */
  align?: "left" | "right";
  /** Breathing room kept at the screen edges. */
  margin?: number;
  /** Distance between the anchor and the panel. */
  gap?: number;
};

/** Below this there is not enough room to show a list, so prefer the other side. */
const USEFUL_HEIGHT = 168;

export function popupRect(
  anchor: Anchor,
  viewport: Viewport,
  opts: PopupOptions = {},
): PopupPlacement {
  const margin = opts.margin ?? 8;
  const gap = opts.gap ?? 4;

  /* A panel may be as wide as the screen less both gutters — and no wider,
     however wide the thing it is anchored to. A 720px table inside a 390px
     phone is exactly how a 300px dropdown ended up half off the display. */
  const room = Math.max(0, viewport.width - margin * 2);
  let width = opts.preferredWidth ?? anchor.width;
  if (opts.minWidth) width = Math.max(width, opts.minWidth);
  width = Math.min(width, room);

  let left = opts.align === "right" ? anchor.right - width : anchor.left;
  // Clamp last: an anchor scrolled off either side must still yield a panel
  // that is wholly on the screen.
  const rightmost = viewport.width - margin - width;
  left = Math.min(Math.max(left, margin), Math.max(margin, rightmost));

  /* Clamped into the layout box on the way in. A visual-viewport reading can
     briefly disagree with it — iOS scrolls for the keyboard before it reports
     the smaller height — and a "visible" edge below the bottom of the screen
     is not a reading worth acting on. */
  const seenTop = Math.min(Math.max(viewport.visibleTop ?? 0, 0), viewport.height);
  const seenBottom = Math.min(
    Math.max(viewport.visibleBottom ?? viewport.height, 0),
    viewport.height,
  );

  const below = seenBottom - (anchor.bottom + gap) - margin;
  const above = anchor.top - gap - seenTop - margin;

  /* Open upwards only when down is genuinely too tight AND up is better —
     which on a phone is what a keyboard does to the bottom half of the
     screen. Callers pass the visual viewport, so "the screen" here means the
     part of it the keyboard has not taken. */
  if (below < Math.min(USEFUL_HEIGHT, above) && above > below) {
    return {
      left,
      width,
      /* Measured against the LAYOUT viewport, because that is what a fixed
         element's `bottom` is measured against. The panel's bottom edge
         lands exactly gap above the anchor — it cannot drift away from it. */
      bottom: viewport.height - (anchor.top - gap),
      maxHeight: Math.max(0, above),
    };
  }
  return { left, width, top: anchor.bottom + gap, maxHeight: Math.max(0, below) };
}

/**
 * The screen, in the coordinates getBoundingClientRect and `position: fixed`
 * both speak — plus, separately, how much of it a keyboard has left.
 *
 * The two must not be mixed. `innerHeight` is the box a fixed element is
 * placed in and the keyboard does not change it; the visual viewport is what
 * the person can see and the keyboard shrinks it. Feeding the second into a
 * `bottom` offset is what threw a popup to the top of the screen: at the
 * moment a field is focused, iOS has already scrolled (offsetTop ≈ 217) but
 * not yet reported the shorter height, so the sum came to 1061 on an 844px
 * phone and the panel was placed against a screen that does not exist.
 */
export function currentViewport(win: Window = window): Viewport {
  const vv = win.visualViewport;
  return {
    width: win.innerWidth,
    height: win.innerHeight,
    ...(vv ? { visibleTop: vv.offsetTop, visibleBottom: vv.offsetTop + vv.height } : null),
  };
}

/**
 * Re-measure whenever anything could have moved the anchor or resized the
 * screen — including the keyboard.
 *
 * `window`'s resize event does NOT fire when a phone keyboard opens: the
 * layout viewport is unchanged, only the visible band shrinks, and that is
 * reported on visualViewport alone. Without these two a panel keeps whatever
 * placement it was given at focus time, which is the worst possible moment to
 * measure — the keyboard is mid-animation and the page is mid-scroll.
 *
 * Scroll is captured so it also catches scrolling containers, not just the
 * window. Returns its own cleanup.
 */
export function watchViewport(onChange: () => void, win: Window = window): () => void {
  win.addEventListener("scroll", onChange, true);
  win.addEventListener("resize", onChange);
  const vv = win.visualViewport;
  vv?.addEventListener("resize", onChange);
  vv?.addEventListener("scroll", onChange);
  return () => {
    win.removeEventListener("scroll", onChange, true);
    win.removeEventListener("resize", onChange);
    vv?.removeEventListener("resize", onChange);
    vv?.removeEventListener("scroll", onChange);
  };
}
