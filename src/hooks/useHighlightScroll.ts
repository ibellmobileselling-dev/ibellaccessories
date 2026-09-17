import { useEffect, useRef, type RefObject } from "react";

/**
 * Keep the arrow-key highlight visible inside a dropdown.
 *
 * Every picker in this app is a capped-height list that the keyboard walks
 * with Up/Down. Without this the highlight walks straight past the bottom
 * edge and keeps going — invisibly — so the shop arrows down, sees nothing
 * move, and presses Enter on whatever it cannot see. On a counter worked
 * entirely by keyboard that is not a rough edge, it is a wrong item on a
 * bill.
 *
 * Two details that are the whole reason this is shared rather than rewritten
 * per dropdown:
 *
 *   Guarded on the index ACTUALLY changing. An unguarded version runs on
 *   every render, which snaps a hand-scrolled list back to the highlight the
 *   instant anything re-renders — and that feels exactly like a list that
 *   cannot be scrolled, which is the complaint this is fixing.
 *
 *   `block: "nearest"`, so a highlight already on screen moves nothing.
 *   Centring on every keypress makes a short list jump about under the eye.
 *
 * The list element needs `data-opt="<index>"` on each option.
 *
 * @param listRef  the scrolling container holding the options
 * @param index    the currently highlighted option
 * @param open     when false, nothing is watched — a closed list has no
 *                 highlight, and reopening should not inherit the old one
 */
export function useHighlightScroll(
  listRef: RefObject<HTMLElement | null>,
  index: number,
  open = true,
) {
  const prev = useRef(index);
  useEffect(() => {
    if (!open) {
      // Reopening starts fresh: remembering the last index across an open
      // would suppress the very first scroll of the next visit.
      prev.current = -1;
      return;
    }
    if (prev.current === index) return;
    prev.current = index;
    listRef.current?.querySelector(`[data-opt="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index, open, listRef]);
}
